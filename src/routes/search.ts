import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { LISTING_CATEGORIES, LISTING_CONDITIONS, OCCASION_TAGS } from "../types/listings.js";
import { type ListingBadge, BADGE_PRIORITY } from "../types/trust.js";

const search = new Hono();

// ============================================================
// Types & Constants
// ============================================================

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

// Valid size values for search filter validation (all size charts merged)
const VALID_SIZES = [
  // Women's sizes
  "UK4 / US0 / AU4", "UK6 / US2 / AU6", "UK8 / US4 / AU8",
  "UK10 / US6 / AU10", "UK12 / US8 / AU12", "UK14 / US10 / AU14",
  "UK16 / US12 / AU16", "UK18 / US14 / AU18", "UK20 / US16 / AU20",
  "UK22 / US18 / AU22", "UK24 / US20 / AU24", "UK26 / US22 / AU26",
  "UK28 / US24 / AU28", "Free Size",
  // Menswear/Kidswear sizes
  "XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "Free size",
  // Footwear sizes
  "AU4 / UK2 / US5 / EU35", "AU5 / UK3 / US6 / EU36", "AU6 / UK4 / US7 / EU37",
  "AU7 / UK5 / US8 / EU38", "AU8 / UK6 / US9 / EU39", "AU9 / UK7 / US10 / EU40",
  "AU10 / UK8 / US11 / EU41", "AU11 / UK9 / US12 / EU42",
  "AU12 / UK10 / US14 / EU43", "AU13 / UK11 / US15 / EU44",
  "AU14 / UK12 / US16 / EU45",
];

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
 * Escape special characters for Postgres text search.
 */
function sanitizeSearchTerm(q: string): string {
  // Remove special characters that could break SQL/tsquery
  return q.replace(/[^a-zA-Z0-9\s-]/g, "").trim();
}

/**
 * Build a tsquery string from search terms.
 * Joins words with & for AND matching.
 */
function buildTsQuery(terms: string[]): string {
  const uniqueTerms = [...new Set(terms.map((t) => t.toLowerCase().trim()).filter(Boolean))];
  return uniqueTerms.map((t) => t.replace(/\s+/g, " & ")).join(" | ");
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/search
 * Full search with filters, FTS, fuzzy matching, and cursor pagination.
 */
search.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();

  // Fetch cached category medians for Best Value badge computation
  const { data: settingsRow } = await supabase
    .from("admin_settings")
    .select("category_medians")
    .single();
  const categoryMedians: Record<string, number> =
    (settingsRow?.category_medians as Record<string, number>) ?? {};

  // Parse query params
  const q = c.req.query("q")?.trim() || "";
  const category = c.req.query("category");
  const condition = c.req.query("condition");
  const occasion = c.req.query("occasion"); // comma-separated
  const color = c.req.query("color"); // comma-separated
  const location = c.req.query("location");
  const market = c.req.query("market"); // AU, US, NZ -- filters by seller location
  const size = c.req.query("size");
  const priceMinStr = c.req.query("price_min");
  const priceMaxStr = c.req.query("price_max");
  const sort = c.req.query("sort") || (q ? "relevance" : "newest");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

  // Validate filter values
  if (
    category &&
    !LISTING_CATEGORIES.includes(category as (typeof LISTING_CATEGORIES)[number])
  ) {
    return c.json({ error: "Invalid category filter" }, 400);
  }
  if (
    condition &&
    !LISTING_CONDITIONS.includes(condition as (typeof LISTING_CONDITIONS)[number])
  ) {
    return c.json({ error: "Invalid condition filter" }, 400);
  }
  if (location && !["AU", "US", "NZ", "CA", "UK"].includes(location)) {
    return c.json({ error: "Invalid location filter" }, 400);
  }
  if (market && !["AU", "US", "NZ", "CA", "UK"].includes(market)) {
    return c.json({ error: "Invalid market filter" }, 400);
  }
  if (size && !VALID_SIZES.includes(size)) {
    return c.json({ error: "Invalid size filter" }, 400);
  }
  if (!["newest", "price_asc", "price_desc", "relevance"].includes(sort)) {
    return c.json({ error: "Invalid sort option" }, 400);
  }

  const priceMin = priceMinStr ? parseInt(priceMinStr, 10) : null;
  const priceMax = priceMaxStr ? parseInt(priceMaxStr, 10) : null;

  // --- Resolve desi term aliases ---
  let resolvedTerms: string[] = [];
  if (q) {
    const sanitized = sanitizeSearchTerm(q);
    resolvedTerms.push(sanitized);

    // Check desi_term_aliases for canonical terms
    const { data: aliases } = await supabase
      .from("desi_term_aliases")
      .select("canonical")
      .ilike("alias", sanitized);

    if (aliases && aliases.length > 0) {
      for (const alias of aliases) {
        if (!resolvedTerms.includes(alias.canonical)) {
          resolvedTerms.push(alias.canonical);
        }
      }
    }
  }

  // --- Build the search query using RPC for complex SQL ---
  // We use a raw SQL approach via rpc for FTS + trigram combined queries
  // Build filters as a Supabase query chain

  // Base query: active listings with photos and seller info.
  // international_shipping is pulled so we can include "ships globally"
  // listings in non-local markets (matching feed behavior) and so the
  // frontend can render a "Ships internationally" badge per result.
  let query = supabase
    .from("listings")
    .select(
      "id, title, description, price_amount, price_currency, original_price_amount, category, condition, estimated_size, size_type, designer_name, international_shipping, measurements, occasion_tags, colors, created_at, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location, trust_tier)",
      { count: "estimated" }
    )
    .eq("status", "active");

  // --- Apply text search ---
  if (q && resolvedTerms.length > 0) {
    const sanitized = sanitizeSearchTerm(q);
    // Use Supabase textSearch for FTS, combined with OR for trigram
    // Build FTS query string
    const tsQueryParts = resolvedTerms
      .map((term) =>
        term
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => `'${w}'`)
          .join(" & ")
      )
      .filter(Boolean);
    const tsQueryStr = tsQueryParts.join(" | ");

    if (tsQueryStr) {
      // Use textSearch for FTS match
      // Also match via title ILIKE for simple substring + fuzzy matching
      query = query.or(
        `title.ilike.%${sanitized}%,description.ilike.%${sanitized}%,category.ilike.%${sanitized}%`
      );
    }
  }

  // --- Apply filters ---
  if (category) {
    query = query.eq("category", category);
  }

  if (condition) {
    query = query.eq("condition", condition);
  }

  if (occasion) {
    const occasionTags = occasion.split(",").map((t) => t.trim()).filter(Boolean);
    // Filter where occasion_tags array overlaps with the given tags
    query = query.overlaps("occasion_tags", occasionTags);
  }

  if (color) {
    const colorValues = color.split(",").map((c) => c.trim()).filter(Boolean);
    query = query.overlaps("colors", colorValues);
  }

  if (priceMin !== null) {
    query = query.gte("price_amount", priceMin);
  }

  if (priceMax !== null) {
    query = query.lte("price_amount", priceMax);
  }

  // Size filter: uses the standardized estimated_size column
  if (size && size !== "Free Size" && size !== "Free size") {
    query = query.eq("estimated_size", size);
  }

  // Location filter: explicit user choice (e.g. "show me only AU sellers") —
  // strict, no international shipping bypass.
  if (location) {
    query = query.eq("profiles.location", location);
  }

  // Market filter (`?market=US`): drives the home-feed/marketplace context.
  // Unlike `location` above, this is NOT strict — international-shipping
  // listings from other markets are also surfaced (matches GET /api/feed
  // behavior). The actual OR (local OR international) is applied in JS
  // after fetching since PostgREST .or() across embedded + native columns
  // is awkward. Caveat: page sizes may be slightly under `limit` when
  // many fetched rows are filtered out — acceptable trade-off for now.
  // (No DB filter applied here.)

  // --- Apply sort ---
  switch (sort) {
    case "newest":
      query = query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      break;
    case "price_asc":
      query = query
        .order("price_amount", { ascending: true })
        .order("id", { ascending: true });
      break;
    case "price_desc":
      query = query
        .order("price_amount", { ascending: false })
        .order("id", { ascending: false });
      break;
    case "relevance":
      // For relevance, just use default ordering (created_at DESC as tiebreaker)
      query = query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      break;
  }

  // --- Cursor-based pagination ---
  if (cursor) {
    const { data: cursorListing } = await supabase
      .from("listings")
      .select("created_at, price_amount, id")
      .eq("id", cursor)
      .single();

    if (cursorListing) {
      switch (sort) {
        case "newest":
        case "relevance":
          query = query.or(
            `created_at.lt.${cursorListing.created_at},and(created_at.eq.${cursorListing.created_at},id.lt.${cursorListing.id})`
          );
          break;
        case "price_asc":
          query = query.or(
            `price_amount.gt.${cursorListing.price_amount},and(price_amount.eq.${cursorListing.price_amount},id.gt.${cursorListing.id})`
          );
          break;
        case "price_desc":
          query = query.or(
            `price_amount.lt.${cursorListing.price_amount},and(price_amount.eq.${cursorListing.price_amount},id.lt.${cursorListing.id})`
          );
          break;
      }
    }
  }

  // Fetch limit + 1 for next_cursor detection
  query = query.limit(limit + 1);

  const { data: rows, error, count } = await query;

  if (error) {
    console.error("Error searching listings:", error);
    return c.json({ error: "Search failed" }, 500);
  }

  const allRows = rows || [];

  // location (strict, explicit user choice) — drop anything not in that country
  // market (inclusive) — keep local sellers OR listings that ship internationally
  let filteredRows = allRows;
  if (location) {
    filteredRows = allRows.filter((row: Record<string, unknown>) => {
      const profiles = row.profiles as Record<string, unknown> | null;
      return profiles && profiles.location === location;
    });
  } else if (market) {
    filteredRows = allRows
      .filter((row: Record<string, unknown>) => {
        const profiles = row.profiles as Record<string, unknown> | null;
        if (!profiles) return false;
        const sellerMarket = profiles.location as string | null | undefined;
        const intl = row.international_shipping === true;
        return sellerMarket === market || intl;
      })
      // Local sellers bubble to the top of search results; international fills out.
      .sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
        const aLocal =
          (a.profiles as Record<string, unknown> | null)?.location === market ? 0 : 1;
        const bLocal =
          (b.profiles as Record<string, unknown> | null)?.location === market ? 0 : 1;
        return aLocal - bLocal;
      });
  }

  const hasMore = filteredRows.length > limit;
  const pageRows = hasMore ? filteredRows.slice(0, limit) : filteredRows;

  // Batch-check active boosts for search result listings
  const searchListingIds = pageRows.map((r: Record<string, unknown>) => r.id as string);
  const searchBoostedIds = new Set<string>();
  if (searchListingIds.length > 0) {
    const { data: searchBoostRows } = await supabase
      .from("listing_boosts")
      .select("listing_id")
      .in("listing_id", searchListingIds)
      .eq("status", "active")
      .gt("ends_at", new Date().toISOString());

    if (searchBoostRows) {
      for (const row of searchBoostRows) {
        searchBoostedIds.add(row.listing_id);
      }
    }
  }

  const items: ListingSummary[] = pageRows.map(
    (row: Record<string, unknown>) => {
      const profiles = row.profiles as Record<string, unknown> | null;
      const photos = row.listing_photos as Array<Record<string, unknown>> | null;

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
        is_boosted: searchBoostedIds.has(row.id as string),
      };
    }
  ).sort((a, b) => (a.is_boosted === b.is_boosted ? 0 : a.is_boosted ? -1 : 1));

  const nextCursor = hasMore
    ? (pageRows[pageRows.length - 1] as Record<string, unknown>).id as string
    : null;

  // Fire-and-forget: log search query to search_queries table
  const clerkUserId = c.get("clerkUserId") as string | undefined;
  (async () => {
    try {
      let userId: string | null = null;
      if (clerkUserId) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("clerk_id", clerkUserId)
          .single();
        userId = profile?.id ?? null;
      }
      await supabase.from("search_queries").insert({
        term: q || "",
        user_id: userId,
        filters: { category, condition, occasion, size, market },
        result_count: items.length,
      });
    } catch {
      // Non-blocking — search logging failure is not user-facing
    }
  })();

  return c.json({
    items,
    next_cursor: nextCursor,
    total_count: count ?? null,
  });
});

/**
 * GET /api/search/suggestions
 * Search suggestions as user types: corrections, category matches, fuzzy title matches.
 */
search.get("/suggestions", optionalClerkMiddleware, async (c) => {
  const q = c.req.query("q")?.trim() || "";

  if (q.length < 2) {
    return c.json({ corrections: [], categories: [], suggestions: [] });
  }

  const supabase = createSupabaseAdmin();
  const sanitized = sanitizeSearchTerm(q);

  // --- Corrections from desi_term_aliases ---
  const { data: aliasMatches } = await supabase
    .from("desi_term_aliases")
    .select("canonical")
    .ilike("alias", `%${sanitized}%`)
    .limit(5);

  const corrections = [
    ...new Set(
      (aliasMatches || []).map(
        (a: Record<string, unknown>) => a.canonical as string
      )
    ),
  ];

  // --- Matching categories (in-memory filter) ---
  const matchingCategories = LISTING_CATEGORIES.filter((cat) =>
    cat.toLowerCase().includes(sanitized.toLowerCase())
  );

  // --- Trigram suggestions: fuzzy title matches ---
  // Use ILIKE for a simpler approach that works with Supabase client
  const { data: titleMatches } = await supabase
    .from("listings")
    .select("title")
    .eq("status", "active")
    .ilike("title", `%${sanitized}%`)
    .limit(5);

  // Get distinct titles
  const suggestions = [
    ...new Set(
      (titleMatches || []).map(
        (t: Record<string, unknown>) => t.title as string
      )
    ),
  ].slice(0, 5);

  return c.json({
    corrections,
    categories: matchingCategories,
    suggestions,
  });
});

/**
 * GET /api/search/trending
 * Returns trending search terms (hardcoded for now).
 */
search.get("/trending", optionalClerkMiddleware, async (c) => {
  const trending = [
    "Lehenga",
    "Wedding Saree",
    "Anarkali",
    "Bridal",
    "Party Wear",
    "Silk Saree",
  ];

  return c.json({ terms: trending });
});

export default search;
