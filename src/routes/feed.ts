import { Hono } from "hono";
import { z } from "zod";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { LISTING_CATEGORIES, OCCASION_TAGS } from "../types/listings.js";
import { type ListingBadge, BADGE_PRIORITY } from "../types/trust.js";

const feed = new Hono();

// ============================================================
// Types
// ============================================================

const VALID_MARKETS = ["AU", "US", "NZ", "CA", "GB"] as const;

interface ListingSummary {
  id: string;
  title: string;
  price_amount: number;
  price_currency: string;
  original_price_amount: number | null;
  category: string;
  condition: string;
  estimated_size: string | null;
  size_type: string | null;
  designer_name: string | null;
  international_shipping: boolean;
  cover_photo_url: string | null;
  seller_name: string | null;
  seller_location: string | null;
  badges: string[];
  seller_trust_tier: number;
  is_boosted: boolean;
}

interface ISOPostSummary {
  id: string;
  description: string;
  category: string;
  size: string | null;
  budget_min: number | null;
  budget_max: number | null;
  author_name: string | null;
  author_avatar: string | null;
  response_count: number;
  comment_count: number;
  created_at: string;
}

interface FeedSection {
  type: string;
  title: string;
  items: ListingSummary[];
  tags?: readonly string[];
  sellers?: TopWardrobe[];
  iso_posts?: ISOPostSummary[];
}

interface TopWardrobe {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  location: string | null;
  listing_count: number;
  preview_photos: string[];
}

interface CategoryCount {
  name: string;
  slug: string;
  count: number;
}

// ============================================================
// Constants
// ============================================================

// international_shipping is pulled so we can include "ships globally" listings
// in non-local feeds AND so the frontend can render a "Ships internationally"
// badge on each card.
const LISTING_SELECT =
  "id, title, price_amount, price_currency, original_price_amount, category, condition, estimated_size, size_type, designer_name, international_shipping, created_at, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location, trust_tier)";

// ============================================================
// Helpers
// ============================================================

/**
 * Compute up to 2 listing badges in priority order.
 */
function computeListingBadges(
  sellerTrustTier: number,
  createdAt: string,
  priceAmount: number,
  category: string,
  salePercentage: number | null,
  categoryMedians: Record<string, number>
): string[] {
  const badges: string[] = [];

  for (const badge of BADGE_PRIORITY) {
    if (badges.length >= 2) break;

    switch (badge) {
      case "Top Seller":
        if (sellerTrustTier >= 3) badges.push(badge);
        break;
      case "Sale":
        if (salePercentage !== null && salePercentage > 0) badges.push(badge);
        break;
      case "Best Value":
        if (
          categoryMedians[category] !== undefined &&
          priceAmount < categoryMedians[category] * 0.75
        )
          badges.push(badge);
        break;
      case "New": {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (new Date(createdAt).getTime() > sevenDaysAgo) badges.push(badge);
        break;
      }
      case "Verified":
        if (sellerTrustTier >= 1) badges.push(badge);
        break;
    }
  }

  return badges;
}

/**
 * Map a raw listing+photo+profile join row to a ListingSummary.
 */
function toListingSummary(
  row: Record<string, unknown>,
  categoryMedians: Record<string, number>,
  boostedIds?: Set<string>
): ListingSummary {
  const profiles = row.profiles as Record<string, unknown> | null;
  const photos = row.listing_photos as Array<Record<string, unknown>> | null;

  // Find cover photo (position=0) or first photo
  let coverUrl: string | null = null;
  if (photos && photos.length > 0) {
    const cover = photos.find((p) => p.position === 0) || photos[0];
    coverUrl = (cover.url as string) || null;
  }

  const trustTier = profiles ? ((profiles.trust_tier as number) ?? 0) : 0;
  const createdAt = (row.created_at as string) || new Date().toISOString();
  const priceAmount = row.price_amount as number;
  const category = row.category as string;
  const salePercentage = (row.sale_percentage as number) ?? null;

  return {
    id: row.id as string,
    title: row.title as string,
    price_amount: priceAmount,
    price_currency: row.price_currency as string,
    original_price_amount: (row.original_price_amount as number) || null,
    category,
    condition: row.condition as string,
    estimated_size: (row.estimated_size as string | null) ?? null,
    size_type: (row.size_type as string | null) ?? null,
    designer_name: (row.designer_name as string | null) ?? null,
    international_shipping: row.international_shipping === true,
    cover_photo_url: coverUrl,
    seller_name: profiles
      ? (profiles.display_name as string | null)
      : null,
    seller_location: profiles
      ? (profiles.location as string | null)
      : null,
    badges: computeListingBadges(
      trustTier,
      createdAt,
      priceAmount,
      category,
      salePercentage,
      categoryMedians
    ),
    seller_trust_tier: trustTier,
    is_boosted: boostedIds ? boostedIds.has(row.id as string) : false,
  };
}

/**
 * Filter rows to only include those with a matching seller location (market).
 * Supabase embedded filters on joins can return rows with null profiles;
 * this post-filter removes them.
 */
/**
 * Filter listings to those visible in `market`: seller is local to that market
 * OR the listing offers international shipping. Local-first sorting is applied
 * afterward so the home feed leads with nearby sellers and fills out with
 * international inventory only when local is sparse.
 */
function filterByMarket(
  rows: Record<string, unknown>[],
  market: string
): Record<string, unknown>[] {
  const filtered = rows.filter((row) => {
    const profiles = row.profiles as Record<string, unknown> | null;
    if (!profiles) return false;
    const sellerMarket = profiles.location as string | null | undefined;
    const intlShipping = row.international_shipping === true;
    return sellerMarket === market || !sellerMarket || intlShipping;
  });

  // Local-first sort: same-market sellers bubble to the top, then by recency.
  return filtered.sort((a, b) => {
    const aLocal =
      (a.profiles as Record<string, unknown> | null)?.location === market ? 0 : 1;
    const bLocal =
      (b.profiles as Record<string, unknown> | null)?.location === market ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const aDate = String(a.created_at || "");
    const bDate = String(b.created_at || "");
    return bDate.localeCompare(aDate);
  });
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/feed
 * Returns the home feed with sections and category counts, filtered by market.
 * Query params:
 *   - market: AU | US | NZ (default: AU)
 */
feed.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();

  // --- Validate market param ---
  const market = c.req.query("market") || "AU";
  if (!VALID_MARKETS.includes(market as (typeof VALID_MARKETS)[number])) {
    return c.json({ error: "Invalid market" }, 400);
  }

  // --- Fetch cached category medians for Best Value badge computation ---
  const { data: settingsRow } = await supabase
    .from("admin_settings")
    .select("category_medians")
    .single();
  const categoryMedians: Record<string, number> =
    (settingsRow?.category_medians as Record<string, number>) ?? {};

  // --- Determine authenticated user's size for in_your_size section ---
  const clerkUserId = c.get("clerkUserId") as string | undefined;
  let userBustSize: number | null = null;

  if (clerkUserId) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("size_preferences")
      .eq("clerk_id", clerkUserId)
      .single();

    if (profile?.size_preferences) {
      const prefs = profile.size_preferences as Record<string, string>;
      const bust = prefs.bust ? parseFloat(prefs.bust) : NaN;
      if (!isNaN(bust) && bust > 0) {
        userBustSize = bust;
      }
    }
  }

  // --- Parallelize all section queries ---
  const [
    newArrivalsResult,
    trendingResult,
    categoryCountsResult,
    inYourSizeResult,
    topWardrobesResult,
    isoPostsResult,
  ] = await Promise.all([
    // 1. New Arrivals: 10 most recent listings visible in this market.
    // No DB-level market filter — filterByMarket() handles "local OR ships
    // internationally" downstream so non-local sellers offering international
    // shipping reach buyers in smaller markets.
    supabase
      .from("listings")
      .select(LISTING_SELECT)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(40),

    // 2. Trending: most recent (fallback). Same market logic as above.
    supabase
      .from("listings")
      .select(LISTING_SELECT)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(40),

    // 3. Category counts: include international here too so a buyer browsing
    // categories sees categories that have ANY shoppable inventory for them.
    supabase
      .from("listings")
      .select("category, international_shipping, profiles!listings_seller_id_fkey(location)")
      .eq("status", "active"),

    // 4. In Your Size — drop DB market filter; filterByMarket + bust filter
    // both run in JS. Over-fetch to leave room for both filters to drop rows.
    userBustSize !== null
      ? supabase
          .from("listings")
          .select(LISTING_SELECT + ", measurements")
          .eq("status", "active")
          .limit(60)
      : Promise.resolve({ data: null as null, error: null as null }),

    // 5. Top Wardrobes: sellers with 10+ active listings IN this market.
    // Intentionally local-only — this section spotlights local talent, not
    // international inventory. Keep the strict market filter.
    supabase
      .from("listings")
      .select("seller_id, profiles!listings_seller_id_fkey(id, display_name, avatar_url, location)")
      .eq("status", "active")
      .eq("profiles.location", market),

    // 6. ISO Requests: recent active ISO posts for this market
    supabase
      .from("iso_posts")
      .select("id, description, category, size, budget_min, budget_max, created_at, author_id, profiles!iso_posts_author_id_fkey(display_name, avatar_url)")
      .eq("status", "active")
      .eq("market", market)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  // --- Batch-check active boosts for all fetched listing IDs ---
  const allListingIds = new Set<string>();
  for (const result of [newArrivalsResult, trendingResult]) {
    for (const row of (result.data || []) as Record<string, unknown>[]) {
      allListingIds.add(row.id as string);
    }
  }
  if (inYourSizeResult.data) {
    for (const row of (inYourSizeResult.data as unknown as Record<string, unknown>[])) {
      allListingIds.add(row.id as string);
    }
  }

  const boostedIds = new Set<string>();
  if (allListingIds.size > 0) {
    const { data: boostRows } = await supabase
      .from("listing_boosts")
      .select("listing_id")
      .in("listing_id", [...allListingIds])
      .eq("status", "active")
      .gt("ends_at", new Date().toISOString());

    if (boostRows) {
      for (const row of boostRows) {
        boostedIds.add(row.listing_id);
      }
    }
  }

  // --- Process New Arrivals ---
  if (newArrivalsResult.error) {
    console.error("Error fetching new arrivals:", newArrivalsResult.error);
    return c.json({ error: "Failed to fetch feed" }, 500);
  }
  const newArrivalsFiltered = filterByMarket(
    (newArrivalsResult.data || []) as Record<string, unknown>[],
    market
  ).slice(0, 10);
  const newArrivals: ListingSummary[] = newArrivalsFiltered
    .map((row) => toListingSummary(row, categoryMedians, boostedIds))
    .sort((a, b) => (a.is_boosted === b.is_boosted ? 0 : a.is_boosted ? -1 : 1));

  // --- Process Trending ---
  // Use market-filtered recent listings. Later could integrate wishlist counts.
  const trendingFiltered = filterByMarket(
    (trendingResult.data || []) as Record<string, unknown>[],
    market
  ).slice(0, 8);
  const trendingItems: ListingSummary[] = trendingFiltered
    .map((row) => toListingSummary(row, categoryMedians, boostedIds))
    .sort((a, b) => (a.is_boosted === b.is_boosted ? 0 : a.is_boosted ? -1 : 1));

  // --- Process Category Counts ---
  const catRows = filterByMarket(
    (categoryCountsResult.data || []) as Record<string, unknown>[],
    market
  );
  const countMap: Record<string, number> = {};
  catRows.forEach((row) => {
    const cat = row.category as string;
    countMap[cat] = (countMap[cat] || 0) + 1;
  });
  const categories: CategoryCount[] = LISTING_CATEGORIES.map((cat) => ({
    name: cat,
    slug: cat.toLowerCase().replace(/[/\s]+/g, "-"),
    count: countMap[cat] || 0,
  }));

  // --- Process In Your Size ---
  let inYourSizeSection: FeedSection | null = null;
  if (userBustSize !== null && inYourSizeResult.data) {
    const bustMin = userBustSize - 2;
    const bustMax = userBustSize + 2;

    const sizeFiltered = filterByMarket(
      ((inYourSizeResult.data as unknown) || []) as Record<string, unknown>[],
      market
    ).filter((row) => {
      const measurements = row.measurements as Record<string, string> | null;
      if (!measurements || !measurements.bust) return false;
      const bust = parseFloat(measurements.bust);
      return !isNaN(bust) && bust >= bustMin && bust <= bustMax;
    }).slice(0, 10);

    if (sizeFiltered.length > 0) {
      inYourSizeSection = {
        type: "in_your_size",
        title: "In Your Size",
        items: sizeFiltered
          .map((row) => toListingSummary(row, categoryMedians, boostedIds))
          .sort((a, b) => (a.is_boosted === b.is_boosted ? 0 : a.is_boosted ? -1 : 1)),
      };
    }
  }

  // --- Process Top Wardrobes ---
  let topWardrobes: TopWardrobe[] = [];
  const wardrobeRows = filterByMarket(
    (topWardrobesResult.data || []) as Record<string, unknown>[],
    market
  );

  // Count listings per seller
  const sellerCounts: Record<string, { count: number; profile: Record<string, unknown> }> = {};
  wardrobeRows.forEach((row) => {
    const sellerId = row.seller_id as string;
    const profiles = row.profiles as Record<string, unknown> | null;
    if (!sellerId || !profiles) return;

    if (!sellerCounts[sellerId]) {
      sellerCounts[sellerId] = { count: 0, profile: profiles };
    }
    sellerCounts[sellerId].count++;
  });

  // Filter to sellers with 10+ listings
  const qualifiedSellers = Object.entries(sellerCounts)
    .filter(([, val]) => val.count >= 10)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6); // Limit to 6 top wardrobes

  if (qualifiedSellers.length > 0) {
    // Fetch 4 preview photos per qualifying seller
    const sellerIds = qualifiedSellers.map(([id]) => id);
    const { data: previewRows } = await supabase
      .from("listings")
      .select("seller_id, listing_photos(url, position)")
      .eq("status", "active")
      .in("seller_id", sellerIds)
      .order("created_at", { ascending: false });

    // Group preview photos by seller (first 4 cover photos each)
    const sellerPhotos: Record<string, string[]> = {};
    (previewRows || []).forEach((row: Record<string, unknown>) => {
      const sid = row.seller_id as string;
      if (!sellerPhotos[sid]) sellerPhotos[sid] = [];
      if (sellerPhotos[sid].length >= 4) return;

      const photos = row.listing_photos as Array<Record<string, unknown>> | null;
      if (photos && photos.length > 0) {
        const cover = photos.find((p) => p.position === 0) || photos[0];
        const url = cover.url as string;
        if (url && !sellerPhotos[sid].includes(url)) {
          sellerPhotos[sid].push(url);
        }
      }
    });

    topWardrobes = qualifiedSellers.map(([sellerId, val]) => ({
      id: (val.profile.id as string) || sellerId,
      display_name: (val.profile.display_name as string | null) ?? null,
      avatar_url: (val.profile.avatar_url as string | null) ?? null,
      location: (val.profile.location as string | null) ?? null,
      listing_count: val.count,
      preview_photos: sellerPhotos[sellerId] || [],
    }));
  }

  // --- Process ISO Requests ---
  let formattedIsoPosts: ISOPostSummary[] = [];
  const isoRows = ((isoPostsResult.data || []) as Record<string, unknown>[]);

  if (isoRows.length > 0) {
    const isoPostIds = isoRows.map((r) => r.id as string);

    // Batch-fetch response and comment counts for ISO posts
    const [isoRespResult, isoCommResult] = await Promise.all([
      supabase
        .from("iso_responses")
        .select("iso_post_id")
        .in("iso_post_id", isoPostIds),
      supabase
        .from("iso_comments")
        .select("iso_post_id")
        .in("iso_post_id", isoPostIds),
    ]);

    const isoRespCounts: Record<string, number> = {};
    for (const r of ((isoRespResult.data || []) as Record<string, unknown>[])) {
      const pid = r.iso_post_id as string;
      isoRespCounts[pid] = (isoRespCounts[pid] || 0) + 1;
    }
    const isoCommCounts: Record<string, number> = {};
    for (const r of ((isoCommResult.data || []) as Record<string, unknown>[])) {
      const pid = r.iso_post_id as string;
      isoCommCounts[pid] = (isoCommCounts[pid] || 0) + 1;
    }

    formattedIsoPosts = isoRows.map((row) => {
      const profiles = row.profiles as Record<string, unknown> | null;
      const id = row.id as string;
      return {
        id,
        description: row.description as string,
        category: row.category as string,
        size: (row.size as string) || null,
        budget_min: (row.budget_min as number) || null,
        budget_max: (row.budget_max as number) || null,
        author_name: profiles ? (profiles.display_name as string | null) : null,
        author_avatar: profiles ? (profiles.avatar_url as string | null) : null,
        response_count: isoRespCounts[id] || 0,
        comment_count: isoCommCounts[id] || 0,
        created_at: row.created_at as string,
      };
    });
  }

  // --- Build sections in specified order ---
  // Order: occasions -> in_your_size -> iso_requests -> new_arrivals -> trending -> top_wardrobes
  const sections: FeedSection[] = [
    {
      type: "occasions",
      title: "Shop by Occasion",
      items: [],
      tags: OCCASION_TAGS,
    },
  ];

  if (inYourSizeSection) {
    sections.push(inYourSizeSection);
  }

  if (formattedIsoPosts.length > 0) {
    sections.push({
      type: "iso_requests",
      title: "In Search Of",
      items: [],
      iso_posts: formattedIsoPosts,
    });
  }

  sections.push({
    type: "new_arrivals",
    title: "New Arrivals",
    items: newArrivals,
  });

  sections.push({
    type: "trending",
    title: "Trending",
    items: trendingItems,
  });

  if (topWardrobes.length > 0) {
    sections.push({
      type: "top_wardrobes",
      title: "Top Wardrobes",
      items: [],
      sellers: topWardrobes,
    });
  }

  return c.json({ sections, categories, market });
});

/**
 * GET /api/feed/category/:category
 * Returns paginated listings for a specific category, filtered by market.
 */
feed.get("/category/:category", optionalClerkMiddleware, async (c) => {
  const category = c.req.param("category");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  const market = c.req.query("market") || "AU";
  const supabase = createSupabaseAdmin();

  // Validate market
  if (!VALID_MARKETS.includes(market as (typeof VALID_MARKETS)[number])) {
    return c.json({ error: "Invalid market" }, 400);
  }

  // Validate category
  if (
    !LISTING_CATEGORIES.includes(category as (typeof LISTING_CATEGORIES)[number])
  ) {
    return c.json({ error: "Invalid category" }, 400);
  }

  // Fetch cached category medians for Best Value badge computation
  const { data: catSettingsRow } = await supabase
    .from("admin_settings")
    .select("category_medians")
    .single();
  const catMedians: Record<string, number> =
    (catSettingsRow?.category_medians as Record<string, number>) ?? {};

  let query = supabase
    .from("listings")
    .select(LISTING_SELECT)
    .eq("status", "active")
    .eq("category", category)
    // Market filter at the DB level on the denormalized seller_location
    // column (schema-25), so it restricts BEFORE pagination and every match
    // is reachable. Inclusive like filterByMarket: local sellers OR anyone
    // who ships internationally OR listings with no known seller location.
    .or(
      `seller_location.eq.${market},international_shipping.eq.true,seller_location.is.null`
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

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

  // Market is now filtered at the DB level, so fetched rows are already the
  // correct set — no JS post-filter (which used to truncate past page 1).
  const filteredRows = (rows || []) as Record<string, unknown>[];

  const hasMore = filteredRows.length > limit;
  const pageRows = hasMore ? filteredRows.slice(0, limit) : filteredRows;

  // Batch-check active boosts for category page listings
  const catListingIds = pageRows.map((r) => r.id as string);
  const catBoostedIds = new Set<string>();
  if (catListingIds.length > 0) {
    const { data: catBoostRows } = await supabase
      .from("listing_boosts")
      .select("listing_id")
      .in("listing_id", catListingIds)
      .eq("status", "active")
      .gt("ends_at", new Date().toISOString());

    if (catBoostRows) {
      for (const row of catBoostRows) {
        catBoostedIds.add(row.listing_id);
      }
    }
  }

  const items: ListingSummary[] = pageRows
    .map((row: Record<string, unknown>) => toListingSummary(row, catMedians, catBoostedIds))
    .sort((a, b) => (a.is_boosted === b.is_boosted ? 0 : a.is_boosted ? -1 : 1));

  const nextCursor = hasMore
    ? (pageRows[pageRows.length - 1] as Record<string, unknown>).id as string
    : null;

  return c.json({ items, next_cursor: nextCursor });
});

export default feed;
