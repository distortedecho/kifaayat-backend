import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const sellers = new Hono();

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
    .select("id, display_name, avatar_url, location, created_at")
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
    },
    listings,
  });
});

export default sellers;
