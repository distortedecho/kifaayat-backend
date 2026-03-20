import { Hono } from "hono";
import { optionalClerkMiddleware, clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const sellers = new Hono();

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
      renting_out: false,
      renting: false,
    },
  });
});

/**
 * GET /api/sellers/:id
 * Public seller profile endpoint.
 * Returns seller info with listing/sold counts and active listings.
 */
sellers.get("/:id", optionalClerkMiddleware, async (c) => {
  const sellerId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  // Fetch seller profile
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, location, created_at, trust_tier")
    .eq("id", sellerId)
    .single();

  if (profileError || !profile) {
    return c.json({ error: "Seller not found" }, 404);
  }

  // Count active listings
  const { count: listingCount } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("status", "active");

  // Count sold listings
  const { count: soldCount } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("status", "sold");

  // Fetch up to 20 active listings with cover photo
  const { data: listingsData, error: listingsError } = await supabase
    .from("listings")
    .select(
      "id, title, price_amount, price_currency, original_price_amount, category, condition"
    )
    .eq("seller_id", sellerId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(20);

  if (listingsError) {
    console.error("Error fetching seller listings:", listingsError);
    return c.json({ error: "Failed to fetch seller listings" }, 500);
  }

  // Fetch cover photos for each listing (position 0)
  const listingIds = (listingsData || []).map((l) => l.id);
  let coverPhotos: Record<string, string> = {};

  if (listingIds.length > 0) {
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("listing_id, url")
      .in("listing_id", listingIds)
      .eq("position", 0);

    if (photos) {
      coverPhotos = Object.fromEntries(
        photos.map((p) => [p.listing_id, p.url])
      );
    }
  }

  // Compute avg_rating and review_count from revealed buyer-to-seller reviews
  const { data: ratingData } = await supabase
    .from("reviews")
    .select("rating")
    .eq("reviewee_id", sellerId)
    .eq("reviewer_role", "buyer")
    .not("revealed_at", "is", null);

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

  // Build listings response with cover_photo_url
  const listings = (listingsData || []).map((listing) => ({
    id: listing.id,
    title: listing.title,
    price_amount: listing.price_amount,
    price_currency: listing.price_currency,
    original_price_amount: listing.original_price_amount,
    category: listing.category,
    condition: listing.condition,
    cover_photo_url: coverPhotos[listing.id] || null,
  }));

  return c.json({
    seller: {
      id: profile.id,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      location: profile.location,
      member_since: profile.created_at,
      listing_count: listingCount || 0,
      sold_count: soldCount || 0,
      avg_rating: avgRating,
      review_count: reviewCount,
      trust_tier: profile.trust_tier ?? 0,
    },
    listings,
  });
});

export default sellers;
