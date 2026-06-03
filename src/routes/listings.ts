import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { computeRiskScore } from "../lib/risk-scoring.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  OCCASION_TAGS,
  REQUIRED_MEASUREMENTS,
  // FABRIC_TYPES,
  // WORK_TYPES,
  // DRY_CLEANING_STATUSES,
  COUNTRIES_OF_ORIGIN,
  type ListingCategory,
  type Measurements,
} from "../types/listings.js";

const listings = new Hono();

// ============================================================
// Zod Schemas — Comments
// ============================================================

const createCommentSchema = z.object({
  content: z.string().min(1, "Comment cannot be empty").max(1000, "Comment must be 1000 characters or less"),
  // Thread root (top-level comment id). May be sent alongside reply_to_comment_id,
  // or alone (legacy: treated as the tapped target).
  parent_comment_id: z.string().uuid().nullish(),
  // The specific comment the user tapped Reply on. Source of truth for @mention
  // target and notification routing. If omitted, falls back to parent_comment_id.
  reply_to_comment_id: z.string().uuid().nullish(),
});

// ============================================================
// Zod Schemas
// ============================================================

const createListingSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or less"),
  description: z.string().max(2000, "Description must be 2000 characters or less").optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
      height: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]]))
    .optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().nonnegative("Price must be a non-negative integer (in cents)"),
  price_currency: z.enum(["AUD", "USD", "NZD", "CAD", "GBP"]).optional(),
  original_price_amount: z.number().int().positive().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).optional(),
  status: z.enum(["draft", "active"]).optional().default("draft"),

  // Standardized size (live app field)
  estimated_size: z.string().max(50).optional(),
  size_type: z.enum(["womens", "menswear_kidswear", "footwear", "free_size"]).optional(),

  // v2 fields — enforced at completeness check, optional at creation for drafts
  fabric_types: z.array(z.string()).default([]),
  items_included: z.array(z.string()).default([]),

  // v2 fields — optional
  work_types: z.array(z.string()).optional(),
  designer_name: z.string().max(200).optional(),
  is_known_designer: z.boolean().optional(),
  designer_verification_url: z.string().url().optional(),
  country_of_origin: z.enum(COUNTRIES_OF_ORIGIN as unknown as [string, ...string[]]).optional(),
  dry_cleaning_status: z.string().max(200).optional(),
  alteration_room: z.string().max(500).optional(),
  fit_tips: z.string().max(1000).optional(),

  // Shipping v2
  shipping_cost_amount: z.number().int().nonnegative().optional(),
  free_shipping: z.boolean().optional(),
  pickup_available: z.boolean().optional(),
  pickup_location: z.string().max(500).optional(),
  international_shipping: z.boolean().optional(),

  // Video
  video_url: z.string().url().optional(),
  video_storage_path: z.string().optional(),
});

const updateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]).optional(),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]).optional(),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
      height: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]]))
    .optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().positive().optional(),
  price_currency: z.enum(["AUD", "USD", "NZD", "CAD", "GBP"]).optional(),
  original_price_amount: z.number().int().positive().nullable().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).nullable().optional(),
  // Status restricted — cannot set to 'reserved' or 'sold' via update
  status: z.enum(["draft", "pending_review", "active", "deactivated"]).optional(),

  // Standardized size (live app field)
  estimated_size: z.string().max(50).nullable().optional(),
  size_type: z.enum(["womens", "menswear_kidswear", "footwear", "free_size"]).nullable().optional(),

  // v2 fields — all optional on updates
  fabric_types: z.array(z.string()).min(1).optional(),
  items_included: z.array(z.string()).min(1).optional(),
  work_types: z.array(z.string()).optional(),
  designer_name: z.string().max(200).nullable().optional(),
  is_known_designer: z.boolean().optional(),
  designer_verification_url: z.string().url().nullable().optional(),
  country_of_origin: z.enum(COUNTRIES_OF_ORIGIN as unknown as [string, ...string[]]).nullable().optional(),
  dry_cleaning_status: z.string().max(200).nullable().optional(),
  alteration_room: z.string().max(500).nullable().optional(),
  fit_tips: z.string().max(1000).nullable().optional(),

  // Shipping v2
  shipping_cost_amount: z.number().int().nonnegative().nullable().optional(),
  free_shipping: z.boolean().optional(),
  pickup_available: z.boolean().optional(),
  pickup_location: z.string().max(500).nullable().optional(),
  international_shipping: z.boolean().optional(),

  // Video
  video_url: z.string().url().nullable().optional(),
  video_storage_path: z.string().nullable().optional(),
});

const statusUpdateSchema = z.object({
  status: z.enum(["draft", "active", "pending_review", "deactivated", "reserved", "sold"]),
  rejection_reason: z.string().max(1000).optional(),
});

const photoReorderSchema = z.object({
  photo_ids: z.array(z.string().uuid()),
});

// ============================================================
// Helpers
// ============================================================

/**
 * Validate that required measurements for a category are present.
 * Returns array of missing field names, or empty array if valid.
 */
function validateMeasurements(
  category: ListingCategory,
  measurements: Measurements | undefined
): string[] {
  const required = REQUIRED_MEASUREMENTS[category];
  if (required.length === 0) return [];
  if (!measurements) return [...required];
  return required.filter((field) => !measurements[field]);
}

/**
 * Check if a listing has all required fields to go active.
 * Returns an error message string if incomplete, or null if ready.
 */
async function validateListingCompleteness(
  listingId: string,
  listingData: {
    title?: string | null;
    description?: string | null;
    category?: string | null;
    condition?: string | null;
    price_amount?: number | null;
    fabric_types?: string[] | null;
    items_included?: string[] | null;
  }
): Promise<string | null> {
  const missing: string[] = [];

  if (!listingData.title) missing.push("title");
  if (!listingData.category) missing.push("category");
  if (!listingData.condition) missing.push("condition");
  if (!listingData.price_amount) missing.push("price_amount");
  if (!listingData.fabric_types?.length) missing.push("fabric_types");
  if (!listingData.items_included?.length) missing.push("items_included");

  // Check photo count (only product photos count toward the minimum)
  const supabase = createSupabaseAdmin();
  const { count } = await supabase
    .from("listing_photos")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .eq("photo_type", "product");

  if (!count || count < 3) {
    missing.push(`photos (need at least 3, have ${count || 0})`);
  }

  if (missing.length > 0) {
    return `Listing is incomplete. Missing: ${missing.join(", ")}`;
  }

  return null;
}

// Valid status transitions (Phase 3: draft -> pending_review for admin moderation)
// "active" added to draft transitions for Tier 2+ auto-approve path
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_review", "active"], // active used by auto-approve for Tier 2+ sellers
  pending_review: ["active", "draft"], // admin approves to active, or rejects back to draft
  active: ["reserved", "deactivated"],
  reserved: ["active", "sold"],
  deactivated: ["active"],             // re-activated listings skip re-review for now
  sold: [],
};

/**
 * Check if a Clerk user has admin privileges.
 * Queries the profiles table for the is_admin flag.
 */
async function isAdmin(clerkUserId: string): Promise<boolean> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return false;
  return data.is_admin === true;
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/listings/me
 * Return the current seller's listings, ordered by created_at DESC.
 * Cursor-paginated on created_at (default limit 20).
 * Query params: ?cursor=<ISO>&limit=<n>&status=<status>
 */
listings.get("/me", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const statusFilter = c.req.query("status");
  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "20", 10) || 20, 1),
    100
  );

  let query = supabase
    .from("listings")
    .select("*, listing_photos(*)")
    .eq("seller_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: listingsData, error } = await query;

  if (error) {
    console.error("Error fetching seller listings:", error);
    return c.json({ error: "Failed to fetch listings" }, 500);
  }

  // Fetch active boosts for this seller's listings in one query
  const { data: activeBoosts } = await supabase
    .from("listing_boosts")
    .select("listing_id, ends_at")
    .eq("seller_id", profile.id)
    .eq("status", "active")
    .gt("ends_at", new Date().toISOString());

  // Build a map of listing_id -> boost ends_at
  const boostMap: Record<string, string> = {};
  if (activeBoosts) {
    for (const boost of activeBoosts) {
      boostMap[boost.listing_id] = boost.ends_at;
    }
  }

  // Sort photos by position and split product gallery from brand_tag/receipt
  const result = (listingsData || []).map((listing) => {
    const allPhotos = (listing.listing_photos || []) as Array<{
      position: number;
      photo_type?: string;
    }>;
    return {
      ...listing,
      photos: allPhotos
        .filter((p) => (p.photo_type ?? "product") === "product")
        .sort((a, b) => a.position - b.position),
      brand_tag_photo:
        allPhotos.find((p) => p.photo_type === "brand_tag") || null,
      receipt_photo:
        allPhotos.find((p) => p.photo_type === "receipt") || null,
      listing_photos: undefined,
      boost_status: boostMap[listing.id] ? ("active" as const) : null,
      boost_ends_at: boostMap[listing.id] || null,
    };
  });

  const nextCursor =
    result.length === limit
      ? ((result[result.length - 1] as Record<string, unknown>).created_at as string)
      : null;

  return c.json({ items: result, listings: result, next_cursor: nextCursor });
});

/**
 * POST /api/listings
 * Create a new listing.
 */
listings.post("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Check profile completeness
  if (!profile.profile_complete) {
    console.error(`[POST /api/listings] Profile incomplete for profile_id=${profile.id}, display_name=${profile.display_name}`);
    return c.json({ error: "Profile must be complete before creating listings. Please set your display name and location in profile settings." }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const input = parsed.data;

  // Validate category-dependent measurements
  const missingMeasurements = validateMeasurements(
    input.category as ListingCategory,
    input.measurements as Measurements | undefined
  );
  if (missingMeasurements.length > 0) {
    return c.json(
      {
        error: "Missing required measurements for this category",
        details: { measurements: missingMeasurements },
      },
      400
    );
  }

  // Insert listing
  const { data: listing, error: insertError } = await supabase
    .from("listings")
    .insert({
      seller_id: profile.id,
      title: input.title,
      description: input.description || null,
      category: input.category,
      condition: input.condition,
      measurements: input.measurements || {},
      occasion_tags: input.occasion_tags || [],
      colors: input.colors || [],
      price_amount: input.price_amount,
      price_currency: input.price_currency || "AUD",
      original_price_amount: input.original_price_amount || null,
      negotiable: input.negotiable || false,
      status: input.status,
      shipping_info: input.shipping_info || null,

      // Standardized size
      estimated_size: input.estimated_size || null,
      size_type: input.size_type || null,

      // v2 fields
      fabric_types: input.fabric_types,
      items_included: input.items_included,
      work_types: input.work_types || [],
      designer_name: input.designer_name || null,
      is_known_designer: input.is_known_designer || false,
      designer_verification_url: input.designer_verification_url || null,
      country_of_origin: input.country_of_origin || null,
      dry_cleaning_status: input.dry_cleaning_status || null,
      alteration_room: input.alteration_room || null,
      fit_tips: input.fit_tips || null,

      // Shipping v2
      shipping_cost_amount: input.shipping_cost_amount || null,
      free_shipping: input.free_shipping || false,
      pickup_available: input.pickup_available || false,
      pickup_location: input.pickup_location || null,
      international_shipping: input.international_shipping || false,

      // Video
      video_url: input.video_url || null,
      video_storage_path: input.video_storage_path || null,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating listing:", insertError);
    return c.json({ error: "Failed to create listing" }, 500);
  }

  return c.json({ listing }, 201);
});

/**
 * GET /api/listings/:id
 * Fetch a single listing with photos and seller info.
 */
listings.get("/:id", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: listing, error } = await supabase
    .from("listings")
    .select("*, listing_photos(*), profiles!listings_seller_id_fkey(id, display_name, avatar_url, location, trust_tier)")
    .eq("id", listingId)
    .single();

  if (error || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // If listing is not active, only the seller can view it —
  // exception: buyer with an active paid order on a reserved listing can also view it.
  if (listing.status !== "active") {
    const clerkUserId = c.get("clerkUserId");
    if (!clerkUserId) {
      return c.json({ error: "Listing not found" }, 404);
    }
    const profile = await getProfileByClerkId(clerkUserId);
    if (!profile) {
      return c.json({ error: "Listing not found" }, 404);
    }

    const isSeller = profile.id === listing.seller_id;

    // Allow buyer viewing a reserved listing they have a paid order for
    let isBuyerWithOrder = false;
    if (!isSeller && listing.status === "reserved") {
      const { data: buyerOrder } = await createSupabaseAdmin()
        .from("orders")
        .select("id")
        .eq("listing_id", listingId)
        .eq("buyer_id", profile.id)
        .eq("status", "paid")
        .limit(1)
        .single();
      isBuyerWithOrder = !!buyerOrder;
    }

    if (!isSeller && !isBuyerWithOrder) {
      return c.json({ error: "Listing not found" }, 404);
    }
  }

  // Fire-and-forget view count increment (atomic SQL function)
  supabase.rpc("increment_view_count", { p_listing_id: listingId }).then(
    ({ error }) => { if (error) console.error("View count increment error:", error); },
    (err: unknown) => console.error("View count increment error:", err)
  );

  // Shape response — split product gallery from brand_tag/receipt singletons
  const allPhotos = (listing.listing_photos || []) as Array<{
    position: number;
    photo_type?: string;
  }>;
  const photos = allPhotos
    .filter((p) => (p.photo_type ?? "product") === "product")
    .sort((a, b) => a.position - b.position);
  const brand_tag_photo =
    allPhotos.find((p) => p.photo_type === "brand_tag") || null;
  const receipt_photo =
    allPhotos.find((p) => p.photo_type === "receipt") || null;
  const seller = listing.profiles || null;

  const result = {
    ...listing,
    photos,
    brand_tag_photo,
    receipt_photo,
    seller,
    listing_photos: undefined,
    profiles: undefined,
  };

  return c.json({ listing: result });
});

/**
 * PUT /api/listings/:id
 * Update a listing (seller only).
 */
listings.put("/:id", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to update this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = updateListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const input = parsed.data;

  // If status change to 'active', validate completeness
  if (input.status === "active" && existing.status !== "active") {
    const merged = { ...existing, ...input };
    const completenessError = await validateListingCompleteness(listingId, merged);
    if (completenessError) {
      return c.json({ error: completenessError }, 400);
    }
  }

  // Validate measurements if category is being changed or measurements are provided
  const effectiveCategory = (input.category || existing.category) as ListingCategory;
  const effectiveMeasurements = (input.measurements || existing.measurements) as Measurements;
  if (input.category || input.measurements) {
    const missingMeasurements = validateMeasurements(effectiveCategory, effectiveMeasurements);
    if (missingMeasurements.length > 0) {
      return c.json(
        {
          error: "Missing required measurements for this category",
          details: { measurements: missingMeasurements },
        },
        400
      );
    }
  }

  // Build update data (only include provided fields)
  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.category !== undefined) updateData.category = input.category;
  if (input.condition !== undefined) updateData.condition = input.condition;
  if (input.measurements !== undefined) updateData.measurements = input.measurements;
  if (input.occasion_tags !== undefined) updateData.occasion_tags = input.occasion_tags;
  if (input.colors !== undefined) updateData.colors = input.colors;
  if (input.price_amount !== undefined) updateData.price_amount = input.price_amount;
  if (input.price_currency !== undefined) updateData.price_currency = input.price_currency;
  if (input.original_price_amount !== undefined) updateData.original_price_amount = input.original_price_amount;
  if (input.negotiable !== undefined) updateData.negotiable = input.negotiable;
  if (input.shipping_info !== undefined) updateData.shipping_info = input.shipping_info;
  if (input.status !== undefined) updateData.status = input.status;

  // Standardized size
  if (input.estimated_size !== undefined) updateData.estimated_size = input.estimated_size;
  if (input.size_type !== undefined) updateData.size_type = input.size_type;

  // v2 fields
  if (input.fabric_types !== undefined) updateData.fabric_types = input.fabric_types;
  if (input.items_included !== undefined) updateData.items_included = input.items_included;
  if (input.work_types !== undefined) updateData.work_types = input.work_types;
  if (input.designer_name !== undefined) updateData.designer_name = input.designer_name;
  if (input.is_known_designer !== undefined) updateData.is_known_designer = input.is_known_designer;
  if (input.designer_verification_url !== undefined) updateData.designer_verification_url = input.designer_verification_url;
  if (input.country_of_origin !== undefined) updateData.country_of_origin = input.country_of_origin;
  if (input.dry_cleaning_status !== undefined) updateData.dry_cleaning_status = input.dry_cleaning_status;
  if (input.alteration_room !== undefined) updateData.alteration_room = input.alteration_room;
  if (input.fit_tips !== undefined) updateData.fit_tips = input.fit_tips;

  // Shipping v2
  if (input.shipping_cost_amount !== undefined) updateData.shipping_cost_amount = input.shipping_cost_amount;
  if (input.free_shipping !== undefined) updateData.free_shipping = input.free_shipping;
  if (input.pickup_available !== undefined) updateData.pickup_available = input.pickup_available;
  if (input.pickup_location !== undefined) updateData.pickup_location = input.pickup_location;
  if (input.international_shipping !== undefined) updateData.international_shipping = input.international_shipping;

  // Video
  if (input.video_url !== undefined) updateData.video_url = input.video_url;
  if (input.video_storage_path !== undefined) updateData.video_storage_path = input.video_storage_path;

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updateData)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing:", updateError);
    return c.json({ error: "Failed to update listing" }, 500);
  }

  // Fire price drop notifications if price decreased
  if (
    input.price_amount !== undefined &&
    input.price_amount < existing.price_amount
  ) {
    (async () => {
      try {
        const { createNotification, priceDropWishlistNotification } = await import("../lib/notifications.js");

        const { data: wishlistUsers } = await supabase
          .from("wishlists")
          .select("user_id")
          .eq("listing_id", listingId)
          .not("user_id", "is", null);

        if (!wishlistUsers || wishlistUsers.length === 0) return;

        const currency = (updated.price_currency as string) || "AUD";
        const template = priceDropWishlistNotification(updated.title as string, input.price_amount!, currency);

        for (const { user_id } of wishlistUsers) {
          await createNotification({
            user_id,
            type: "price_drop_wishlist",
            ...template,
            data: { listing_id: listingId },
          });
        }
      } catch (err) {
        console.error("Error sending price drop notifications:", err);
      }
    })();
  }

  return c.json({ listing: updated });
});

/**
 * PATCH /api/listings/:id/status
 * Update listing status with transition validation.
 */
listings.patch("/:id/status", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to update this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = statusUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  let { status: newStatus } = parsed.data;
  const { rejection_reason: rejectionReason } = parsed.data;

  // Enforce valid transitions
  const allowedTransitions = VALID_TRANSITIONS[existing.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    return c.json(
      {
        error: `Invalid status transition from '${existing.status}' to '${newStatus}'`,
        allowed: allowedTransitions,
      },
      400
    );
  }

  // If transitioning draft -> pending_review, validate completeness
  if (newStatus === "pending_review" && existing.status === "draft") {
    const completenessError = await validateListingCompleteness(listingId, existing);
    if (completenessError) {
      return c.json({ error: completenessError }, 400);
    }

    // Check auto-approve config: tiers with risk-based auto-approve stay in
    // pending_review (computeRiskScore will auto-approve async if risk is low).
    // Tiers without risk config or with enabled=false keep the old direct auto-approve.
    const { data: sellerProfile } = await supabase
      .from("profiles")
      .select("trust_tier")
      .eq("id", existing.seller_id)
      .single();

    const sellerTier = sellerProfile?.trust_tier ?? 0;

    const { data: adminSettings } = await supabase
      .from("admin_settings")
      .select("auto_approve_config")
      .single();

    const autoApproveConfig = (adminSettings?.auto_approve_config as Record<string, { enabled: boolean; max_risk: number }>) ?? {};
    const tierConfig = autoApproveConfig[String(sellerTier)];

    if (tierConfig?.enabled) {
      // Risk-based auto-approve: keep as pending_review, trigger async risk scoring
      // computeRiskScore will auto-approve if score < max_risk
      console.log(`Listing ${listingId} entering pending_review with risk scoring for tier ${sellerTier} seller`);
    } else if (sellerTier >= 2) {
      // Legacy auto-approve for tiers without risk config
      newStatus = "active";
      console.log(`Auto-approved listing ${listingId} for tier ${sellerTier} seller (no risk config)`);
    }
  }

  // If transitioning pending_review -> active, require admin role
  if (newStatus === "active" && existing.status === "pending_review") {
    const adminCheck = await isAdmin(clerkUserId);
    if (!adminCheck) {
      return c.json({ error: "Only admins can approve listings" }, 403);
    }
  }

  // If transitioning pending_review -> draft (rejection), require admin role and rejection_reason
  if (newStatus === "draft" && existing.status === "pending_review") {
    const adminCheck = await isAdmin(clerkUserId);
    if (!adminCheck) {
      return c.json({ error: "Only admins can reject listings" }, 403);
    }
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = { status: newStatus };

  // Set rejection_reason when rejecting (pending_review -> draft)
  if (newStatus === "draft" && existing.status === "pending_review" && rejectionReason) {
    updatePayload.rejection_reason = rejectionReason;
  }

  // Clear rejection_reason when re-submitting for review (draft -> pending_review)
  if (newStatus === "pending_review") {
    updatePayload.rejection_reason = null;
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updatePayload)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing status:", updateError);
    return c.json({ error: "Failed to update listing status" }, 500);
  }

  // Trigger async risk scoring when listing enters pending_review
  if (newStatus === "pending_review") {
    computeRiskScore(listingId).catch((err) =>
      console.error("Risk scoring failed:", err)
    );
  }

  return c.json({ listing: updated });
});

/**
 * PATCH /api/listings/:id/sale
 * Apply or remove a sale discount (1-70%) on a listing.
 */
listings.patch("/:id/sale", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const saleSchema = z.object({
    discount_percentage: z.number().int().min(1).max(70).nullable(),
  });

  const body = await c.req.json();
  const parsed = saleSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { discount_percentage } = parsed.data;

  // Fetch listing
  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("id, seller_id, price_amount, original_price_amount, sale_percentage")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to update this listing" }, 403);
  }

  let updateData: Record<string, unknown>;

  if (discount_percentage !== null) {
    // Applying a sale
    // Use original_price_amount as base if already set, otherwise use current price_amount
    const originalPrice = listing.original_price_amount ?? listing.price_amount;
    const newPrice = Math.round(originalPrice * (1 - discount_percentage / 100));

    updateData = {
      price_amount: newPrice,
      sale_percentage: discount_percentage,
      original_price_amount: originalPrice,
    };
  } else {
    // Removing a sale: restore original price
    if (listing.original_price_amount) {
      updateData = {
        price_amount: listing.original_price_amount,
        sale_percentage: null,
        original_price_amount: null,
      };
    } else {
      // No sale to remove, just clear sale_percentage
      updateData = {
        sale_percentage: null,
      };
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updateData)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing sale:", updateError);
    return c.json({ error: "Failed to update sale" }, 500);
  }

  return c.json({ listing: updated });
});

/**
 * POST /api/listings/:id/boost/confirm
 * Confirm a boost purchase after payment (activates the pending boost).
 */
listings.post("/:id/boost/confirm", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const confirmSchema = z.object({
    boost_id: z.string().uuid("boost_id must be a valid UUID"),
  });

  const body = await c.req.json();
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { boost_id } = parsed.data;

  // Verify boost exists, belongs to seller, is pending, and matches listing
  const { data: boost, error: boostError } = await supabase
    .from("listing_boosts")
    .select("id, listing_id, seller_id, status, ends_at")
    .eq("id", boost_id)
    .single();

  if (boostError || !boost) {
    return c.json({ error: "Boost not found" }, 404);
  }

  if (boost.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to confirm this boost" }, 403);
  }

  if (boost.listing_id !== listingId) {
    return c.json({ error: "Boost does not belong to this listing" }, 400);
  }

  if (boost.status !== "pending") {
    return c.json({ error: `Boost is not pending (status: ${boost.status})` }, 400);
  }

  // Check for existing active boost on this listing
  const { data: existingActive } = await supabase
    .from("listing_boosts")
    .select("id, ends_at")
    .eq("listing_id", listingId)
    .eq("status", "active")
    .gt("ends_at", new Date().toISOString())
    .limit(1)
    .single();

  // Fetch boost duration from admin_settings
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("boost_duration_days")
    .limit(1)
    .single();
  const boostDurationDays = settings?.boost_duration_days ?? 7;

  let updatedEndsAt: string;

  if (existingActive) {
    // Extend existing active boost and cancel the new pending one
    updatedEndsAt = new Date(
      new Date(existingActive.ends_at).getTime() + boostDurationDays * 86400000
    ).toISOString();

    await supabase
      .from("listing_boosts")
      .update({ ends_at: updatedEndsAt })
      .eq("id", existingActive.id);

    await supabase
      .from("listing_boosts")
      .update({ status: "cancelled" })
      .eq("id", boost_id);
  } else {
    // Activate the pending boost
    updatedEndsAt = boost.ends_at;

    await supabase
      .from("listing_boosts")
      .update({ status: "active" })
      .eq("id", boost_id);
  }

  return c.json({ success: true, ends_at: updatedEndsAt });
});

/**
 * POST /api/listings/:id/photos
 * Upload a photo for a listing (seller only).
 */
listings.post("/:id/photos", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to upload photos for this listing" }, 403);
  }

  // Parse multipart form data
  const formData = await c.req.formData();
  const photo = formData.get("photo");
  const rawPhotoType = (formData.get("photo_type") as string | null) || "product";

  const PHOTO_TYPES = ["product", "brand_tag", "receipt"] as const;
  type PhotoType = (typeof PHOTO_TYPES)[number];
  if (!PHOTO_TYPES.includes(rawPhotoType as PhotoType)) {
    return c.json(
      { error: `Invalid photo_type. Allowed: ${PHOTO_TYPES.join(", ")}` },
      400
    );
  }
  const photoType = rawPhotoType as PhotoType;

  // Enforce per-type limits: product photos cap at 15, brand_tag/receipt at 1 each
  const { count: typeCount } = await supabase
    .from("listing_photos")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId)
    .eq("photo_type", photoType);

  if (photoType === "product" && typeCount !== null && typeCount >= 15) {
    return c.json({ error: "Maximum 15 product photos per listing" }, 400);
  }
  if (photoType !== "product" && typeCount !== null && typeCount >= 1) {
    return c.json(
      { error: `Only one ${photoType} photo allowed per listing. Delete the existing one first.` },
      400
    );
  }

  if (!photo || !(photo instanceof File)) {
    return c.json({ error: "Photo file is required" }, 400);
  }

  // Validate file type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!allowedTypes.includes(photo.type)) {
    return c.json(
      { error: "Invalid file type. Allowed: JPEG, PNG, WebP, HEIC" },
      400
    );
  }

  // Validate file size (10MB max)
  const maxSize = 10 * 1024 * 1024;
  if (photo.size > maxSize) {
    return c.json({ error: "File too large. Maximum 10MB" }, 400);
  }

  // Generate unique filename
  const ext = photo.name.split(".").pop() || "jpg";
  const fileId = crypto.randomUUID();
  const storagePath = `${profile.id}/${listingId}/${fileId}.${ext}`;

  // Upload to Supabase Storage
  const fileBuffer = await photo.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from("listing-photos")
    .upload(storagePath, fileBuffer, {
      contentType: photo.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("Error uploading photo:", uploadError);
    return c.json({ error: "Failed to upload photo" }, 500);
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("listing-photos")
    .getPublicUrl(storagePath);

  // Determine next position (within this photo_type group)
  const nextPosition = typeCount ?? 0;

  // Insert photo record
  const { data: photoRecord, error: insertError } = await supabase
    .from("listing_photos")
    .insert({
      listing_id: listingId,
      storage_path: storagePath,
      url: urlData.publicUrl,
      position: nextPosition,
      photo_type: photoType,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error inserting photo record:", insertError);
    // Try to clean up uploaded file
    await supabase.storage.from("listing-photos").remove([storagePath]);
    return c.json({ error: "Failed to save photo record" }, 500);
  }

  return c.json({ photo: photoRecord }, 201);
});

/**
 * DELETE /api/listings/:id/photos/:photoId
 * Delete a photo from a listing (seller only).
 */
listings.delete("/:id/photos/:photoId", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const photoId = c.req.param("photoId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId) || !uuidRegex.test(photoId)) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to delete photos from this listing" }, 403);
  }

  // Get photo record
  const { data: photoRecord, error: photoError } = await supabase
    .from("listing_photos")
    .select("*")
    .eq("id", photoId)
    .eq("listing_id", listingId)
    .single();

  if (photoError || !photoRecord) {
    return c.json({ error: "Photo not found" }, 404);
  }

  // Enforce min 3 product photos if listing is active (brand_tag/receipt don't count)
  if (listing.status === "active" && photoRecord.photo_type === "product") {
    const { count } = await supabase
      .from("listing_photos")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId)
      .eq("photo_type", "product");

    if (count !== null && count <= 3) {
      return c.json(
        { error: "Active listings must have at least 3 product photos" },
        400
      );
    }
  }

  // Delete from Supabase storage
  const { error: storageError } = await supabase.storage
    .from("listing-photos")
    .remove([photoRecord.storage_path]);

  if (storageError) {
    console.error("Error deleting photo from storage:", storageError);
    // Continue with DB deletion even if storage delete fails
  }

  // Delete from database
  const { error: deleteError } = await supabase
    .from("listing_photos")
    .delete()
    .eq("id", photoId);

  if (deleteError) {
    console.error("Error deleting photo record:", deleteError);
    return c.json({ error: "Failed to delete photo" }, 500);
  }

  return c.body(null, 204);
});

/**
 * PUT /api/listings/:id/photos/reorder
 * Reorder photos for a listing (seller only).
 */
listings.put("/:id/photos/reorder", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to reorder photos for this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = photoReorderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { photo_ids } = parsed.data;

  // Verify all photo IDs belong to this listing
  const { data: existingPhotos, error: photosError } = await supabase
    .from("listing_photos")
    .select("id")
    .eq("listing_id", listingId);

  if (photosError) {
    return c.json({ error: "Failed to fetch photos" }, 500);
  }

  const existingIds = new Set((existingPhotos || []).map((p) => p.id));
  const invalidIds = photo_ids.filter((id) => !existingIds.has(id));
  if (invalidIds.length > 0) {
    return c.json(
      { error: "Some photo IDs do not belong to this listing", invalid: invalidIds },
      400
    );
  }

  // Update positions
  const updates = photo_ids.map((id, index) =>
    supabase
      .from("listing_photos")
      .update({ position: index })
      .eq("id", id)
  );

  await Promise.all(updates);

  // Fetch updated photos
  const { data: updatedPhotos, error: fetchError } = await supabase
    .from("listing_photos")
    .select("*")
    .eq("listing_id", listingId)
    .order("position", { ascending: true });

  if (fetchError) {
    return c.json({ error: "Failed to fetch updated photos" }, 500);
  }

  return c.json({ photos: updatedPhotos });
});

// ============================================================
// Listing Comments (public forum-style)
// ============================================================

/**
 * GET /api/listings/:id/comments
 * Fetch public comments for a listing. Guest-accessible.
 */
listings.get("/:id/comments", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const cursor = c.req.query("cursor");
  const limitStr = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitStr || "30", 10) || 30, 1), 100);

  let query = supabase
    .from("listing_comments")
    .select(
      "id, listing_id, author_id, content, parent_comment_id, reply_to_comment_id, created_at, profiles!listing_comments_author_id_fkey(id, display_name, avatar_url)"
    )
    .eq("listing_id", listingId)
    .order("created_at", { ascending: true })
    .limit(limit + 1);

  if (cursor) {
    query = query.gt("created_at", cursor);
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error("Error fetching listing comments:", error);
    return c.json({ error: "Failed to fetch comments" }, 500);
  }

  const rawList = rows || [];
  const hasMore = rawList.length > limit;
  const page = hasMore ? rawList.slice(0, limit) : rawList;

  const comments = (page as Record<string, unknown>[]).map((row) => {
    const author = row.profiles as Record<string, unknown> | null;
    return {
      id: row.id,
      listing_id: row.listing_id,
      author_id: row.author_id,
      content: row.content,
      parent_comment_id: row.parent_comment_id ?? null,
      reply_to_comment_id: row.reply_to_comment_id ?? null,
      created_at: row.created_at,
      author_name: author ? (author.display_name as string | null) : null,
      author_avatar: author ? (author.avatar_url as string | null) : null,
    };
  });

  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>).created_at as string
    : null;

  return c.json({ comments, next_cursor: nextCursor });
});

/**
 * GET /api/listings/:id/comments/count
 * Return the comment count for a listing. Guest-accessible.
 */
listings.get("/:id/comments/count", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { count, error } = await supabase
    .from("listing_comments")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId);

  if (error) {
    return c.json({ count: 0 });
  }

  return c.json({ count: count || 0 });
});

/**
 * POST /api/listings/:id/comments
 * Add a public comment to a listing. Auth required.
 */
listings.post("/:id/comments", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const body = await c.req.json();
  const parsed = createCommentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { content, parent_comment_id, reply_to_comment_id } = parsed.data;

  // Validate listing exists and is active
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status, title")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "active" && listing.status !== "reserved") {
    return c.json({ error: "Cannot comment on a listing that is not active" }, 400);
  }

  // If replying, the "tapped target" is reply_to_comment_id when sent (the actual
  // comment the user tapped Reply on), else parent_comment_id (legacy contract).
  // We always store parent_comment_id = thread root and reply_to_comment_id = tapped.
  const tappedTargetId = reply_to_comment_id || parent_comment_id || null;
  let threadRootId: string | null = null;
  let tappedTargetIdResolved: string | null = null;
  let replyToAuthorId: string | null = null;

  if (tappedTargetId) {
    const { data: target, error: targetError } = await supabase
      .from("listing_comments")
      .select("id, author_id, listing_id, parent_comment_id")
      .eq("id", tappedTargetId)
      .single();

    if (targetError || !target) {
      return c.json({ error: "Comment to reply to not found" }, 404);
    }
    if (target.listing_id !== listingId) {
      return c.json({ error: "Comment belongs to a different listing" }, 400);
    }

    // If tapped is itself a reply, the root is its parent. Otherwise tapped IS the root.
    threadRootId = target.parent_comment_id ?? target.id;
    tappedTargetIdResolved = target.id;
    replyToAuthorId = target.author_id;

    // If the frontend also sent parent_comment_id, sanity-check it matches the derived root.
    if (parent_comment_id && parent_comment_id !== threadRootId) {
      return c.json(
        { error: "parent_comment_id does not match the thread root of reply_to_comment_id" },
        400
      );
    }
  }

  const { data: comment, error: insertError } = await supabase
    .from("listing_comments")
    .insert({
      listing_id: listingId,
      author_id: profile.id,
      content,
      parent_comment_id: threadRootId,
      reply_to_comment_id: tappedTargetIdResolved,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating listing comment:", insertError);
    return c.json({ error: "Failed to create comment" }, 500);
  }

  // Fire-and-forget: notify relevant parties
  (async () => {
    try {
      const { createNotification } = await import("../lib/notifications.js");

      // Reply → notify only the author of the comment that was tapped (skip if self-reply)
      if (replyToAuthorId) {
        if (replyToAuthorId !== profile.id) {
          const snippet = content.length > 80 ? content.slice(0, 80) + "..." : content;
          await createNotification({
            user_id: replyToAuthorId,
            type: "comment_reply",
            title: `${profile.display_name || "Someone"} replied to your comment`,
            body: snippet,
            data: {
              listing_id: listingId,
              comment_id: comment.id,
              parent_comment_id: threadRootId,
              reply_to_comment_id: tappedTargetIdResolved,
            },
          });
        }
        return;
      }

      // Top-level comment → existing seller/buyer broadcast logic
      if (listing.seller_id !== profile.id) {
        await createNotification({
          user_id: listing.seller_id,
          type: "listing_comment",
          title: "New comment on your listing",
          body: `${profile.display_name || "Someone"} commented on "${listing.title}"`,
          data: { listing_id: listingId, comment_id: comment.id },
        });
      } else {
        const { data: prevComments } = await supabase
          .from("listing_comments")
          .select("author_id")
          .eq("listing_id", listingId)
          .neq("author_id", listing.seller_id)
          .neq("id", comment.id);

        const buyerIds = [...new Set((prevComments || []).map((c) => c.author_id))];

        for (const buyerId of buyerIds) {
          await createNotification({
            user_id: buyerId,
            type: "listing_comment",
            title: "Seller replied on a listing",
            body: `${profile.display_name || "The seller"} replied on "${listing.title}"`,
            data: { listing_id: listingId, comment_id: comment.id },
          });
        }
      }
    } catch (err) {
      console.error("Error sending listing comment notification:", err);
    }
  })();

  return c.json({
    comment: {
      ...comment,
      author_name: profile.display_name,
      author_avatar: profile.avatar_url,
    },
  }, 201);
});

/**
 * DELETE /api/listings/:id/comments/:commentId
 * Delete own comment or seller can delete any comment on their listing.
 */
listings.delete("/:id/comments/:commentId", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const commentId = c.req.param("commentId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId) || !uuidRegex.test(commentId)) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  // Fetch comment
  const { data: comment, error: commentError } = await supabase
    .from("listing_comments")
    .select("id, listing_id, author_id")
    .eq("id", commentId)
    .eq("listing_id", listingId)
    .single();

  if (commentError || !comment) {
    return c.json({ error: "Comment not found" }, 404);
  }

  // Allow deletion by comment author OR the listing seller
  const { data: listing } = await supabase
    .from("listings")
    .select("seller_id")
    .eq("id", listingId)
    .single();

  const isCommentAuthor = comment.author_id === profile.id;
  const isListingSeller = listing?.seller_id === profile.id;

  if (!isCommentAuthor && !isListingSeller) {
    return c.json({ error: "Not authorized to delete this comment" }, 403);
  }

  const { error: deleteError } = await supabase
    .from("listing_comments")
    .delete()
    .eq("id", commentId);

  if (deleteError) {
    console.error("Error deleting listing comment:", deleteError);
    return c.json({ error: "Failed to delete comment" }, 500);
  }

  return c.body(null, 204);
});

/**
 * GET /api/listings/:id/stats
 * Returns engagement stats for a listing. Seller-only.
 */
listings.get("/:id/stats", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, view_count, share_count")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const [
    { count: saveCount },
    { count: commentCount },
    { count: offerCount },
  ] = await Promise.all([
    supabase
      .from("wishlists")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId),
    supabase
      .from("listing_comments")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId),
    supabase
      .from("offers")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId),
  ]);

  return c.json({
    listing_id: listingId,
    views: listing.view_count ?? 0,
    shares: listing.share_count ?? 0,
    saves: saveCount ?? 0,
    comments: commentCount ?? 0,
    offers: offerCount ?? 0,
  });
});

/**
 * POST /api/listings/:id/share
 * Increments the share count for a listing. No auth required.
 */
listings.post("/:id/share", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  supabase
    .rpc("increment_share_count", { p_listing_id: listingId })
    .then(
      ({ error }) => { if (error) console.error("Share count increment error:", error); },
      (err: unknown) => console.error("Share count increment error:", err)
    );

  return c.body(null, 204);
});

// ============================================================
// Video upload (signed URL flow — client uploads directly to storage)
// ============================================================

const VIDEO_BUCKET = "listing-videos";
const ALLOWED_VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "m4v"] as const;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

const videoUploadUrlSchema = z.object({
  file_name: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100).optional(),
  size_bytes: z.number().int().positive().optional(),
});

/**
 * POST /api/listings/:id/video/upload-url
 * Returns a signed URL the client can PUT the video to directly.
 * Server verifies seller owns the listing and chooses the storage path
 * so users can't write outside their own folder.
 */
listings.post("/:id/video/upload-url", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = videoUploadUrlSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }
  const { file_name, size_bytes } = parsed.data;

  if (size_bytes !== undefined && size_bytes > MAX_VIDEO_BYTES) {
    return c.json(
      { error: `Video too large. Maximum ${MAX_VIDEO_BYTES / 1024 / 1024} MB` },
      400
    );
  }

  const ext = (file_name.split(".").pop() || "mp4").toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext as typeof ALLOWED_VIDEO_EXTENSIONS[number])) {
    return c.json(
      { error: `Invalid file extension. Allowed: ${ALLOWED_VIDEO_EXTENSIONS.join(", ")}` },
      400
    );
  }

  // Verify caller owns the listing
  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }
  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to upload video for this listing" }, 403);
  }

  // Path layout: <profile_id>/<listing_id>/<random>.<ext>
  // Random suffix prevents collision when replacing a video — old one stays
  // until explicitly deleted, so partial uploads don't clobber the live video.
  const fileId = crypto.randomUUID();
  const storagePath = `${profile.id}/${listingId}/${fileId}.${ext}`;

  const { data: signed, error: signError } = await supabase.storage
    .from(VIDEO_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signError || !signed) {
    console.error("Error creating signed upload URL:", signError);
    return c.json({ error: "Failed to create upload URL" }, 500);
  }

  const { data: publicUrlData } = supabase.storage
    .from(VIDEO_BUCKET)
    .getPublicUrl(storagePath);

  return c.json({
    signed_url: signed.signedUrl,
    token: signed.token,
    storage_path: storagePath,
    public_url: publicUrlData.publicUrl,
  });
});

/**
 * DELETE /api/listings/:id/video
 * Removes the video file from storage and clears the URL columns on the listing.
 */
listings.delete("/:id/video", clerkMiddleware, requireProfile, async (c) => {
  const listingId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("id, seller_id, video_storage_path")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }
  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to delete video for this listing" }, 403);
  }

  if (listing.video_storage_path) {
    const { error: removeError } = await supabase.storage
      .from(VIDEO_BUCKET)
      .remove([listing.video_storage_path]);
    if (removeError) {
      console.error("Error removing video from storage:", removeError);
      // Continue — still clear the DB columns so the listing isn't broken
    }
  }

  const { error: updateError } = await supabase
    .from("listings")
    .update({ video_url: null, video_storage_path: null })
    .eq("id", listingId);

  if (updateError) {
    console.error("Error clearing video columns:", updateError);
    return c.json({ error: "Failed to clear video on listing" }, 500);
  }

  return c.body(null, 204);
});

export default listings;
