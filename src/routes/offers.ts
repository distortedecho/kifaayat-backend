import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  type OfferStatus,
  type OfferWithListing,
  MAX_OFFER_ROUNDS,
  OFFER_EXPIRY_HOURS,
} from "../types/transactions.js";
import {
  createNotification,
  offerCounteredNotification,
} from "../lib/notifications.js";
import { emit } from "../lib/events.js";
import { acceptOffer, declineOffer, OfferServiceError } from "../services/offerService.js";

const offers = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createOfferSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  amount: z.number().int().positive("Amount must be a positive integer (in cents)"),
  currency: z.enum(["AUD", "USD", "NZD", "CAD", "GBP"]),
});

const counterOfferSchema = z.object({
  amount: z.number().int().positive("Amount must be a positive integer (in cents)"),
});

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get cover photo URL for a listing.
 */
async function getCoverPhotoUrl(listingId: string): Promise<string | null> {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase
    .from("listing_photos")
    .select("url")
    .eq("listing_id", listingId)
    .eq("position", 0)
    .single();

  return data?.url || null;
}

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/offers
 * Create a new offer on a listing.
 */
offers.post("/", idempotencyMiddleware, clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createOfferSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, amount, currency } = parsed.data;

  // Validate listing exists, is active, and is negotiable
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status, negotiable, title, price_amount")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "active") {
    return c.json({ error: "Listing is not available" }, 400);
  }

  if (!listing.negotiable) {
    return c.json({ error: "This listing does not accept offers" }, 400);
  }

  // Buyer cannot be the seller
  if (listing.seller_id === profile.id) {
    return c.json({ error: "You cannot make an offer on your own listing" }, 400);
  }

  // Check for existing pending offer from this buyer on this listing
  const { data: existingOffer } = await supabase
    .from("offers")
    .select("id")
    .eq("listing_id", listing_id)
    .eq("buyer_id", profile.id)
    .eq("status", "pending")
    .single();

  if (existingOffer) {
    return c.json({ error: "You already have a pending offer on this listing" }, 409);
  }

  // Calculate expiry (48 hours from now)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + OFFER_EXPIRY_HOURS);

  // Insert offer
  const { data: offer, error: insertError } = await supabase
    .from("offers")
    .insert({
      listing_id,
      buyer_id: profile.id,
      seller_id: listing.seller_id,
      amount,
      currency,
      status: "pending" as OfferStatus,
      round: 1,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating offer:", insertError);
    return c.json({ error: "Failed to create offer" }, 500);
  }

  // Emit event; the notifications listener dispatches the seller alert.
  emit("offer:received", {
    offerId: offer.id as string,
    sellerId: listing.seller_id as string,
    buyerId: profile.id as string,
    buyerName: profile.display_name || "A buyer",
    listingId: listing_id,
    listingTitle: listing.title,
    amount,
    currency,
  });

  return c.json({ offer }, 201);
});

/**
 * GET /api/offers/mine
 * List buyer's offers with listing info. Cursor-paginated on created_at
 * (default limit 20). Query params: ?cursor=<ISO>&limit=<n>
 */
offers.get("/mine", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "20", 10) || 20, 1),
    100
  );

  let query = supabase
    .from("offers")
    .select(
      "*, listings!offers_listing_id_fkey(id, title, price_amount, listing_photos(url, position)), profiles!offers_seller_id_fkey(display_name)"
    )
    .eq("buyer_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: offersData, error } = await query;

  if (error) {
    console.error("Error fetching buyer offers:", error);
    return c.json({ error: "Failed to fetch offers" }, 500);
  }

  const items: OfferWithListing[] = (offersData || []).map((row: Record<string, unknown>) => {
    const listing = row.listings as Record<string, unknown> | null;
    const sellerProfile = row.profiles as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id as string,
      listing_id: row.listing_id as string,
      buyer_id: row.buyer_id as string,
      seller_id: row.seller_id as string,
      amount: row.amount as number,
      currency: row.currency as string,
      status: row.status as OfferStatus,
      round: row.round as number,
      parent_offer_id: row.parent_offer_id as string | null,
      expires_at: row.expires_at as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      listing_title: listing ? (listing.title as string) : "",
      listing_cover_photo_url: coverUrl,
      listing_price_amount: listing ? (listing.price_amount as number) : 0,
      counterparty_name: sellerProfile
        ? (sellerProfile.display_name as string | null)
        : null,
    };
  });

  const nextCursor =
    items.length === limit ? items[items.length - 1].created_at : null;

  return c.json({ items, offers: items, next_cursor: nextCursor });
});

/**
 * GET /api/offers/received
 * List seller's received offers with listing info and buyer name.
 * Cursor-paginated on created_at (default limit 20).
 * Query params: ?cursor=<ISO>&limit=<n>
 */
offers.get("/received", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "20", 10) || 20, 1),
    100
  );

  let query = supabase
    .from("offers")
    .select(
      "*, listings!offers_listing_id_fkey(id, title, price_amount, listing_photos(url, position)), profiles!offers_buyer_id_fkey(display_name)"
    )
    .eq("seller_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: offersData, error } = await query;

  if (error) {
    console.error("Error fetching seller offers:", error);
    return c.json({ error: "Failed to fetch offers" }, 500);
  }

  const items: OfferWithListing[] = (offersData || []).map((row: Record<string, unknown>) => {
    const listing = row.listings as Record<string, unknown> | null;
    const buyerProfile = row.profiles as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id as string,
      listing_id: row.listing_id as string,
      buyer_id: row.buyer_id as string,
      seller_id: row.seller_id as string,
      amount: row.amount as number,
      currency: row.currency as string,
      status: row.status as OfferStatus,
      round: row.round as number,
      parent_offer_id: row.parent_offer_id as string | null,
      expires_at: row.expires_at as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      listing_title: listing ? (listing.title as string) : "",
      listing_cover_photo_url: coverUrl,
      listing_price_amount: listing ? (listing.price_amount as number) : 0,
      counterparty_name: buyerProfile
        ? (buyerProfile.display_name as string | null)
        : null,
    };
  });

  const nextCursor =
    items.length === limit ? items[items.length - 1].created_at : null;

  return c.json({ items, offers: items, next_cursor: nextCursor });
});

/**
 * GET /api/offers/:id
 * Get single offer with full details.
 */
offers.get("/:id", clerkMiddleware, requireProfile, async (c) => {
  const offerId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(offerId)) {
    return c.json({ error: "Invalid offer ID format" }, 400);
  }

  const { data: offer, error } = await supabase
    .from("offers")
    .select(
      "*, listings!offers_listing_id_fkey(id, title, price_amount, listing_photos(url, position)), buyer:profiles!offers_buyer_id_fkey(display_name, avatar_url), seller:profiles!offers_seller_id_fkey(display_name, avatar_url)"
    )
    .eq("id", offerId)
    .single();

  if (error || !offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  // Only buyer or seller can view
  if (offer.buyer_id !== profile.id && offer.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to view this offer" }, 403);
  }

  return c.json({ offer });
});

/**
 * POST /api/offers/:id/accept
 * Seller accepts an offer.
 */
offers.post("/:id/accept", clerkMiddleware, requireProfile, async (c) => {
  const offerId = c.req.param("id");
  const profile = c.get("profile");

  if (!UUID_REGEX.test(offerId)) {
    return c.json({ error: "Invalid offer ID format" }, 400);
  }

  try {
    const updatedOffer = await acceptOffer(offerId, { profileId: profile.id });
    return c.json({ offer: updatedOffer });
  } catch (err) {
    if (err instanceof OfferServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 500);
    }
    console.error("Unexpected error in accept offer:", err);
    return c.json({ error: "Failed to accept offer" }, 500);
  }
});

/**
 * POST /api/offers/:id/decline
 * Seller declines an offer.
 */
offers.post("/:id/decline", clerkMiddleware, requireProfile, async (c) => {
  const offerId = c.req.param("id");
  const profile = c.get("profile");

  if (!UUID_REGEX.test(offerId)) {
    return c.json({ error: "Invalid offer ID format" }, 400);
  }

  try {
    const updatedOffer = await declineOffer(offerId, { profileId: profile.id });
    return c.json({ offer: updatedOffer });
  } catch (err) {
    if (err instanceof OfferServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 500);
    }
    console.error("Unexpected error in decline offer:", err);
    return c.json({ error: "Failed to decline offer" }, 500);
  }
});

/**
 * POST /api/offers/:id/counter
 * Counter an offer (seller counters buyer's offer, or buyer counters seller's counter).
 */
offers.post("/:id/counter", clerkMiddleware, requireProfile, async (c) => {
  const offerId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(offerId)) {
    return c.json({ error: "Invalid offer ID format" }, 400);
  }

  // Parse body
  const body = await c.req.json();
  const parsed = counterOfferSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { amount: counterAmount } = parsed.data;

  // Fetch the offer
  const { data: offer, error: fetchError } = await supabase
    .from("offers")
    .select("*, listings!offers_listing_id_fkey(id, title, seller_id)")
    .eq("id", offerId)
    .single();

  if (fetchError || !offer) {
    return c.json({ error: "Offer not found" }, 404);
  }

  // Must be pending
  if (offer.status !== "pending") {
    return c.json({ error: "Offer is not pending" }, 400);
  }

  // User must be the recipient of the current offer
  // If original buyer made the offer, seller can counter
  // If seller countered, buyer can counter back
  const isSeller = offer.seller_id === profile.id;
  const isBuyer = offer.buyer_id === profile.id;

  if (!isSeller && !isBuyer) {
    return c.json({ error: "Not authorized to counter this offer" }, 403);
  }

  // Determine who is the recipient -- the person who did NOT create the current offer
  // For round 1 (buyer -> seller): seller is recipient, can counter
  // For round 2 (seller -> buyer via counter): buyer is recipient, can counter
  // For round 3: no more counters
  // The person who "made" the current offer row is identified by checking
  // if it has a parent: odd rounds are buyer-initiated, even rounds are seller-initiated
  const isOddRound = offer.round % 2 === 1;
  const recipientIsSeller = isOddRound; // round 1: buyer sent, seller receives
  const userIsRecipient = recipientIsSeller ? isSeller : isBuyer;

  if (!userIsRecipient) {
    return c.json({ error: "Only the offer recipient can counter" }, 403);
  }

  // Check round limit
  if (offer.round >= MAX_OFFER_ROUNDS) {
    return c.json({ error: "Maximum counter-offer rounds reached" }, 400);
  }

  // Mark current offer as countered
  await supabase
    .from("offers")
    .update({ status: "countered" as OfferStatus })
    .eq("id", offerId);

  // Calculate new expiry
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + OFFER_EXPIRY_HOURS);

  // Create new counter-offer
  // For the counter: the "buyer" and "seller" stay the same on the offer chain,
  // but the direction flips (who made this specific counter)
  const { data: counterOffer, error: insertError } = await supabase
    .from("offers")
    .insert({
      listing_id: offer.listing_id,
      buyer_id: offer.buyer_id,
      seller_id: offer.seller_id,
      amount: counterAmount,
      currency: offer.currency,
      status: "pending" as OfferStatus,
      round: offer.round + 1,
      parent_offer_id: offerId,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating counter-offer:", insertError);
    return c.json({ error: "Failed to create counter-offer" }, 500);
  }

  // Notify the counterparty
  const listing = offer.listings as Record<string, unknown>;
  const notifyUserId = isSeller ? offer.buyer_id : offer.seller_id;
  const counterTemplate = offerCounteredNotification(
    profile.display_name || "Someone",
    listing.title as string,
    counterAmount,
    offer.currency,
    offer.round + 1,
    MAX_OFFER_ROUNDS
  );
  await createNotification({
    user_id: notifyUserId,
    type: "offer_countered",
    ...counterTemplate,
    data: { listing_id: offer.listing_id, offer_id: counterOffer.id },
  });

  return c.json({ offer: counterOffer }, 201);
});

export default offers;
