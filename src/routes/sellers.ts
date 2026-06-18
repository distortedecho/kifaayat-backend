import { Hono } from "hono";
import { optionalClerkMiddleware, clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const sellers = new Hono();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/sellers/dashboard
 * Authenticated seller dashboard metrics.
 * Returns total earned, items sold, avg price, response time, and activity tabs.
 */
sellers.get("/dashboard", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Fetch completed order stats for this seller
  const { data: orderStats } = await supabase
    .from("orders")
    .select("seller_payout, amount, created_at, shipped_at")
    .eq("seller_id", profile.id)
    .in("status", ["paid", "shipped", "delivered", "complete"]);

  const orders = orderStats || [];

  const totalEarned = orders.reduce(
    (sum: number, o: Record<string, unknown>) => sum + ((o.seller_payout as number) || 0),
    0
  );
  const itemsSold = orders.length;
  const avgPrice =
    itemsSold > 0
      ? Math.round(
          orders.reduce(
            (sum: number, o: Record<string, unknown>) => sum + ((o.amount as number) || 0),
            0
          ) / itemsSold
        )
      : 0;

  // Response time: average hours between created_at and shipped_at
  const shippedOrders = orders.filter(
    (o: Record<string, unknown>) => o.shipped_at != null
  );
  let responseTimeHours = 0;
  if (shippedOrders.length > 0) {
    const totalHours = shippedOrders.reduce(
      (sum: number, o: Record<string, unknown>) => {
        const created = new Date(o.created_at as string).getTime();
        const shipped = new Date(o.shipped_at as string).getTime();
        return sum + (shipped - created) / (1000 * 60 * 60);
      },
      0
    );
    responseTimeHours = parseFloat((totalHours / shippedOrders.length).toFixed(1));
  }

  // Check buyer activity
  const { count: buyerOrderCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("buyer_id", profile.id);

  // Check seller has any active/sold listings
  const { count: sellerListingCount } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", profile.id)
    .in("status", ["active", "sold"]);

  return c.json({
    metrics: {
      total_earned: totalEarned,
      items_sold: itemsSold,
      avg_price: avgPrice,
      response_time_hours: responseTimeHours,
    },
    activity_tabs: {
      selling: (sellerListingCount || 0) > 0,
      buying: (buyerOrderCount || 0) > 0,
    },
  });
});

/**
 * POST /api/sellers/:id/follow
 * Follow a seller. Requires authentication.
 */
sellers.post("/:id/follow", clerkMiddleware, async (c) => {
  const sellerId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) return c.json({ error: "Profile not found" }, 404);

  if (profile.id === sellerId) {
    return c.json({ error: "Cannot follow yourself" }, 400);
  }

  const { error } = await supabase.from("seller_follows").upsert(
    { follower_id: profile.id, seller_id: sellerId },
    { onConflict: "follower_id,seller_id" }
  );

  if (error) {
    console.error("Error following seller:", error);
    return c.json({ error: "Failed to follow seller" }, 500);
  }

  return c.json({ following: true });
});

/**
 * DELETE /api/sellers/:id/follow
 * Unfollow a seller. Requires authentication.
 */
sellers.delete("/:id/follow", clerkMiddleware, async (c) => {
  const sellerId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) return c.json({ error: "Profile not found" }, 404);

  await supabase
    .from("seller_follows")
    .delete()
    .eq("follower_id", profile.id)
    .eq("seller_id", sellerId);

  return c.json({ following: false });
});

/**
 * GET /api/sellers/:id/wishlist
 * Public wishlist for a seller (only if they have wishlist_public enabled).
 */
sellers.get("/:id/wishlist", optionalClerkMiddleware, async (c) => {
  const sellerId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  // Check if seller has public wishlist enabled
  const { data: sellerProfile } = await supabase
    .from("profiles")
    .select("wishlist_public")
    .eq("id", sellerId)
    .single();

  if (!sellerProfile || !sellerProfile.wishlist_public) {
    return c.json({ items: [], public: false });
  }

  // Fetch their wishlisted items
  const { data: wishlistRows } = await supabase
    .from("wishlists")
    .select(
      "listing_id, created_at, listings!wishlists_listing_id_fkey(id, title, price_amount, price_currency, original_price_amount, category, condition, estimated_size, size_type, designer_name, seller_id, listing_photos(url, position, photo_type), profiles!listings_seller_id_fkey(display_name, location))"
    )
    .eq("user_id", sellerId)
    .order("created_at", { ascending: false })
    .limit(20);

  const items = (wishlistRows || [])
    .filter((row) => row.listings != null)
    .map((row) => {
      const l = row.listings as unknown as Record<string, unknown>;
      const photos = l.listing_photos as Array<Record<string, unknown>> | null;
      // Cover must be a 'product' photo only — brand_tag / receipt photos
      // are seller-side authenticity proofs, not gallery images.
      const productPhotos =
        photos?.filter((p) => (p.photo_type ?? "product") === "product") ?? [];
      const cover =
        productPhotos.find((p) => p.position === 0) || productPhotos[0];
      const sellerProf = l.profiles as unknown as Record<string, unknown> | null;

      return {
        id: l.id as string,
        title: l.title as string,
        price_amount: l.price_amount as number,
        price_currency: l.price_currency as string,
        original_price_amount: l.original_price_amount as number | null,
        category: l.category as string,
        condition: l.condition as string,
        estimated_size: (l.estimated_size as string | null) ?? null,
        size_type: (l.size_type as string | null) ?? null,
        designer_name: (l.designer_name as string | null) ?? null,
        cover_photo_url: (cover?.url as string) || null,
        seller_name: sellerProf?.display_name as string | null,
        seller_location: sellerProf?.location as string | null,
      };
    });

  return c.json({ items, public: true });
});

/**
 * GET /api/sellers/:id
 * Public seller profile endpoint.
 * Returns seller info with listing/sold counts, active listings, follow state, and follower count.
 */
sellers.get("/:id", optionalClerkMiddleware, async (c) => {
  const sellerId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId") as string | undefined;
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  // Fetch seller profile
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, location, created_at, trust_tier, wishlist_public")
    .eq("id", sellerId)
    .single();

  if (profileError || !profile) {
    return c.json({ error: "Seller not found" }, 404);
  }

  // Parallelize all counts and data fetches
  const [
    listingCountResult,
    soldCountResult,
    listingsResult,
    ratingResult,
    followerCountResult,
    isFollowingResult,
  ] = await Promise.all([
    supabase
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId)
      .eq("status", "active"),

    supabase
      .from("listings")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId)
      .eq("status", "sold"),

    supabase
      .from("listings")
      .select("id, title, price_amount, price_currency, original_price_amount, category, condition, estimated_size, size_type, designer_name")
      .eq("seller_id", sellerId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(20),

    supabase
      .from("reviews")
      .select("rating")
      .eq("reviewee_id", sellerId)
      .eq("reviewer_role", "buyer")
      .not("revealed_at", "is", null),

    supabase
      .from("seller_follows")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", sellerId),

    // Check if current user follows this seller
    clerkUserId
      ? (async () => {
          const viewer = await getProfileByClerkId(clerkUserId);
          if (!viewer) return { count: 0 };
          const { count } = await supabase
            .from("seller_follows")
            .select("id", { count: "exact", head: true })
            .eq("follower_id", viewer.id)
            .eq("seller_id", sellerId);
          return { count: count || 0 };
        })()
      : Promise.resolve({ count: 0 }),
  ]);

  if (listingsResult.error) {
    console.error("Error fetching seller listings:", listingsResult.error);
    return c.json({ error: "Failed to fetch seller listings" }, 500);
  }

  // Fetch cover photos for each listing (position 0)
  const listingsData = listingsResult.data || [];
  const listingIds = listingsData.map((l) => l.id);
  let coverPhotos: Record<string, string> = {};

  if (listingIds.length > 0) {
    // Pull product photos only — brand_tag / receipt photos are
    // seller-side authenticity proofs and must never appear as a public
    // cover image. Order by position so we pick the lowest-numbered
    // product photo per listing (typically position 0, but fall back
    // gracefully if a listing has no product at position 0 specifically).
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("listing_id, url, position")
      .in("listing_id", listingIds)
      .eq("photo_type", "product")
      .order("position", { ascending: true });

    if (photos) {
      // Keep the first (lowest-position) product photo per listing.
      for (const p of photos) {
        if (!(p.listing_id in coverPhotos)) {
          coverPhotos[p.listing_id as string] = p.url as string;
        }
      }
    }
  }

  const ratingData = ratingResult.data;
  const reviewCount = ratingData?.length || 0;
  const avgRating =
    reviewCount > 0
      ? parseFloat(
          (
            ratingData!.reduce((sum: number, r: { rating: number }) => sum + r.rating, 0) /
            reviewCount
          ).toFixed(1)
        )
      : null;

  const listings = listingsData.map((listing) => ({
    id: listing.id,
    title: listing.title,
    price_amount: listing.price_amount,
    price_currency: listing.price_currency,
    original_price_amount: listing.original_price_amount,
    category: listing.category,
    condition: listing.condition,
    estimated_size: listing.estimated_size ?? null,
    size_type: listing.size_type ?? null,
    designer_name: listing.designer_name ?? null,
    cover_photo_url: coverPhotos[listing.id] || null,
  }));

  return c.json({
    seller: {
      id: profile.id,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      location: profile.location,
      member_since: profile.created_at,
      listing_count: listingCountResult.count || 0,
      sold_count: soldCountResult.count || 0,
      avg_rating: avgRating,
      review_count: reviewCount,
      trust_tier: profile.trust_tier ?? 0,
      follower_count: followerCountResult.count || 0,
      is_following: (isFollowingResult.count || 0) > 0,
      wishlist_public: profile.wishlist_public ?? false,
    },
    listings,
  });
});

export default sellers;
