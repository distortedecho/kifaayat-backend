import { Hono } from "hono";
import { z } from "zod";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { LISTING_CATEGORIES } from "../types/listings.js";

const feed = new Hono();

// ============================================================
// Types
// ============================================================

interface ListingSummary {
  id: string;
  title: string;
  price_amount: number;
  price_currency: string;
  original_price_amount: number | null;
  category: string;
  condition: string;
  cover_photo_url: string | null;
  seller_name: string | null;
  seller_location: string | null;
}

interface FeedSection {
  type: string;
  title: string;
  items: ListingSummary[];
}

interface CategoryCount {
  name: string;
  slug: string;
  count: number;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Map a raw listing+photo+profile join row to a ListingSummary.
 */
function toListingSummary(row: Record<string, unknown>): ListingSummary {
  const profiles = row.profiles as Record<string, unknown> | null;
  const photos = row.listing_photos as Array<Record<string, unknown>> | null;

  // Find cover photo (position=0) or first photo
  let coverUrl: string | null = null;
  if (photos && photos.length > 0) {
    const cover = photos.find((p) => p.position === 0) || photos[0];
    coverUrl = (cover.url as string) || null;
  }

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: row.price_amount as number,
    price_currency: row.price_currency as string,
    original_price_amount: (row.original_price_amount as number) || null,
    category: row.category as string,
    condition: row.condition as string,
    cover_photo_url: coverUrl,
    seller_name: profiles
      ? (profiles.display_name as string | null)
      : null,
    seller_location: profiles
      ? (profiles.location as string | null)
      : null,
  };
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/feed
 * Returns the home feed with sections (new arrivals, trending) and category counts.
 */
feed.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();

  // --- New Arrivals: 10 most recent active listings ---
  const { data: newArrivalsRaw, error: naError } = await supabase
    .from("listings")
    .select(
      "id, title, price_amount, price_currency, original_price_amount, category, condition, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location)"
    )
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(10);

  if (naError) {
    console.error("Error fetching new arrivals:", naError);
    return c.json({ error: "Failed to fetch feed" }, 500);
  }

  const newArrivals: ListingSummary[] = (newArrivalsRaw || []).map(
    (row: Record<string, unknown>) => toListingSummary(row)
  );

  // --- Trending: 8 listings ordered by wishlist count ---
  // First try to get listings with most wishlist saves
  const { data: trendingIds, error: trendingError } = await supabase
    .rpc("get_trending_listing_ids", { result_limit: 8 })
    .select("*");

  let trendingItems: ListingSummary[] = [];

  if (!trendingError && trendingIds && trendingIds.length > 0) {
    // Fetch full listing data for trending IDs
    const ids = trendingIds.map(
      (r: Record<string, unknown>) => r.listing_id as string
    );
    const { data: trendingRaw } = await supabase
      .from("listings")
      .select(
        "id, title, price_amount, price_currency, original_price_amount, category, condition, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location)"
      )
      .in("id", ids)
      .eq("status", "active");

    trendingItems = (trendingRaw || []).map(
      (row: Record<string, unknown>) => toListingSummary(row)
    );
  }

  // Fallback: if not enough trending data, use random active listings
  if (trendingItems.length < 8) {
    const existingIds = trendingItems.map((item) => item.id);
    const { data: fallbackRaw } = await supabase
      .from("listings")
      .select(
        "id, title, price_amount, price_currency, original_price_amount, category, condition, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location)"
      )
      .eq("status", "active")
      .not("id", "in", `(${existingIds.join(",")})`)
      .order("created_at", { ascending: false })
      .limit(8 - trendingItems.length);

    const fallbackItems = (fallbackRaw || []).map(
      (row: Record<string, unknown>) => toListingSummary(row)
    );
    trendingItems = [...trendingItems, ...fallbackItems];
  }

  // --- Categories with active listing counts ---
  const { data: categoryCountsRaw, error: catError } = await supabase
    .from("listings")
    .select("category")
    .eq("status", "active");

  if (catError) {
    console.error("Error fetching category counts:", catError);
  }

  // Count by category
  const countMap: Record<string, number> = {};
  (categoryCountsRaw || []).forEach((row: Record<string, unknown>) => {
    const cat = row.category as string;
    countMap[cat] = (countMap[cat] || 0) + 1;
  });

  // Return all 12 categories, even those with 0 listings
  const categories: CategoryCount[] = LISTING_CATEGORIES.map((cat) => ({
    name: cat,
    slug: cat.toLowerCase().replace(/[/\s]+/g, "-"),
    count: countMap[cat] || 0,
  }));

  // Build sections
  const sections: FeedSection[] = [
    {
      type: "new_arrivals",
      title: "New Arrivals",
      items: newArrivals,
    },
    {
      type: "trending",
      title: "Trending",
      items: trendingItems,
    },
  ];

  return c.json({ sections, categories });
});

/**
 * GET /api/feed/category/:category
 * Returns paginated listings for a specific category.
 */
feed.get("/category/:category", optionalClerkMiddleware, async (c) => {
  const category = c.req.param("category");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  const supabase = createSupabaseAdmin();

  // Validate category
  if (
    !LISTING_CATEGORIES.includes(category as (typeof LISTING_CATEGORIES)[number])
  ) {
    return c.json({ error: "Invalid category" }, 400);
  }

  let query = supabase
    .from("listings")
    .select(
      "id, title, price_amount, price_currency, original_price_amount, category, condition, created_at, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location)"
    )
    .eq("status", "active")
    .eq("category", category)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1); // fetch one extra to determine next_cursor

  // Cursor-based pagination
  if (cursor) {
    // Look up cursor listing's created_at
    const { data: cursorListing } = await supabase
      .from("listings")
      .select("created_at, id")
      .eq("id", cursor)
      .single();

    if (cursorListing) {
      query = query.or(
        `created_at.lt.${cursorListing.created_at},and(created_at.eq.${cursorListing.created_at},id.lt.${cursorListing.id})`
      );
    }
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error("Error fetching category listings:", error);
    return c.json({ error: "Failed to fetch listings" }, 500);
  }

  const allRows = rows || [];
  const hasMore = allRows.length > limit;
  const pageRows = hasMore ? allRows.slice(0, limit) : allRows;

  const items: ListingSummary[] = pageRows.map(
    (row: Record<string, unknown>) => toListingSummary(row)
  );

  const nextCursor = hasMore
    ? (pageRows[pageRows.length - 1] as Record<string, unknown>).id as string
    : null;

  return c.json({ items, next_cursor: nextCursor });
});

export default feed;
