import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  OCCASION_TAGS,
  isValidSubCategoryPair,
  CURATION_TAGS,
} from "../types/listings.js";
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
  // category and size are comma-separated multi-select (e.g.
  // ?category=Lehenga,Saree&size=UK8 / US4 / AU8,Free Size). The size
  // labels themselves contain " / " but never commas, so splitting on
  // comma is safe. A buyer who'd accept several sizes/categories picks
  // them all and we match any (.in()). Single value still works — it
  // just becomes a one-element array.
  const categoryRaw = c.req.query("category");
  const categories = categoryRaw
    ? categoryRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // Kept for sub_category pairing + Budget-Friendly median lookup, which
  // only make sense with a single category. Null when 0 or 2+ selected.
  const category = categories.length === 1 ? categories[0] : undefined;
  // sub_category is multi-select (comma-separated), e.g. within Jewellery
  // the buyer can tick Earrings + Bangles at once — same UX as clothing
  // categories. All values must belong to the single selected parent.
  const subCategoryRaw = c.req.query("sub_category");
  const subCategories = subCategoryRaw
    ? subCategoryRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // Exact-ish designer filter (e.g. a "Sabyasachi Mukherjee" chip or
  // designer dropdown). Case-insensitive substring so minor label
  // variations still match. Independent of the free-text `q` search.
  const designer = c.req.query("designer")?.trim();
  // condition is multi-select (comma-separated), same UX as categories.
  const conditionRaw = c.req.query("condition");
  const conditions = conditionRaw
    ? conditionRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const occasion = c.req.query("occasion"); // comma-separated
  const color = c.req.query("color"); // comma-separated
  const location = c.req.query("location");
  const market = c.req.query("market"); // AU, US, NZ -- filters by seller location
  const sizeRaw = c.req.query("size");
  const sizes = sizeRaw
    ? sizeRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const priceMinStr = c.req.query("price_min");
  const priceMaxStr = c.req.query("price_max");
  const sort = c.req.query("sort") || (q ? "relevance" : "newest");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  // Curation chip the FE filter sheet sends. Six accepted values:
  //   4 admin-tagged (CURATION_TAGS) → filtered via curation_tags column
  //   "Trending" → computed via view_count + save_count on recent listings
  //   "Budget Friendly" → computed via price < category_median * 0.6
  const curation = c.req.query("curation");

  // Log + return a 400 for a rejected search. Captures the raw query so a
  // "GET /api/search 400" in the request log tells us WHICH filter the FE
  // sent that we don't accept (stale value, bad casing, wrong pairing).
  const rejectSearch = (reason: string) => {
    logger.warn("search.rejected", {
      reason,
      query: c.req.query(),
      requestId: c.get("requestId"),
      userId: c.get("clerkUserId") || "anonymous",
    });
    return c.json({ error: reason }, 400);
  };

  // Validate filter values — every category in the multi-select must be
  // a known one.
  const invalidCategory = categories.find(
    (cat) => !LISTING_CATEGORIES.includes(cat as (typeof LISTING_CATEGORIES)[number])
  );
  if (invalidCategory) {
    return rejectSearch(`Invalid category filter: ${invalidCategory}`);
  }
  // sub_category only makes sense paired with EXACTLY ONE category — the
  // FE filter sheet only surfaces sub-categories after a single parent is
  // picked. Reject if sub_category is sent with zero or multiple
  // categories (stale/malformed query).
  if (subCategories.length > 0) {
    if (categories.length !== 1) {
      return rejectSearch("sub_category requires exactly one category to be specified");
    }
    const invalidSub = subCategories.find(
      (sub) => !isValidSubCategoryPair(category!, sub)
    );
    if (invalidSub) {
      return rejectSearch(`Invalid sub_category for this category: ${invalidSub}`);
    }
  }
  const invalidCondition = conditions.find(
    (cond) => !LISTING_CONDITIONS.includes(cond as (typeof LISTING_CONDITIONS)[number])
  );
  if (invalidCondition) {
    return rejectSearch(`Invalid condition filter: ${invalidCondition}`);
  }
  if (location && !["AU", "US", "NZ", "CA", "GB"].includes(location)) {
    return rejectSearch(`Invalid location filter: ${location}`);
  }
  if (market && !["AU", "US", "NZ", "CA", "GB"].includes(market)) {
    return rejectSearch(`Invalid market filter: ${market}`);
  }
  const invalidSize = sizes.find((s) => !VALID_SIZES.includes(s));
  if (invalidSize) {
    return rejectSearch(`Invalid size filter: ${invalidSize}`);
  }
  if (!["newest", "price_asc", "price_desc", "relevance"].includes(sort)) {
    return rejectSearch(`Invalid sort option: ${sort}`);
  }
  const CURATION_COMPUTED = ["Trending", "Budget Friendly"] as const;
  const ALLOWED_CURATION = [
    ...CURATION_TAGS,
    ...CURATION_COMPUTED,
  ] as readonly string[];
  if (curation && !ALLOWED_CURATION.includes(curation)) {
    return rejectSearch(`Invalid curation filter: ${curation}`);
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
      "id, title, description, price_amount, price_currency, original_price_amount, category, sub_category, condition, estimated_size, size_type, designer_name, international_shipping, measurements, occasion_tags, colors, created_at, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location, trust_tier)",
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
      // Also match via title ILIKE for simple substring + fuzzy matching.
      // designer_name is included so typing a label name in the search
      // box (e.g. "Sabyasachi") surfaces that designer's listings even
      // when the name isn't in the title/description.
      query = query.or(
        `title.ilike.%${sanitized}%,description.ilike.%${sanitized}%,category.ilike.%${sanitized}%,designer_name.ilike.%${sanitized}%`
      );
    }
  }

  // --- Apply filters ---
  // Multi-select: match any of the chosen categories. Single value
  // collapses to a one-element .in() which behaves like .eq().
  if (categories.length > 0) {
    query = query.in("category", categories);
  }

  if (subCategories.length > 0) {
    query = query.in("sub_category", subCategories);
  }

  if (designer) {
    // Sanitize to avoid breaking PostgREST's filter syntax, then match
    // case-insensitively. ilike with no wildcards is effectively a
    // case-insensitive exact match; wrapping in % makes it a contains
    // so "Sabyasachi" matches "Sabyasachi Mukherjee".
    const safeDesigner = designer.replace(/[%,()]/g, "");
    query = query.ilike("designer_name", `%${safeDesigner}%`);
  }

  // --- Curation chip filter ---
  // 4 admin-tagged values land here as a curation_tags array containment
  // check (GIN-indexed in schema-07). Trending + Budget Friendly are
  // computed below: Trending alters the sort + adds a recency window,
  // Budget Friendly adds a price upper bound based on the category
  // median cache. Trending/BF can coexist with other filters (e.g.
  // "Trending Jewellery under $100" works).
  if (curation && (CURATION_TAGS as readonly string[]).includes(curation)) {
    query = query.contains("curation_tags", [curation]);
  }

  if (curation === "Trending") {
    // Last 30 days; popularity-weighted ranking applied below in sort.
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    query = query.gte("created_at", thirtyDaysAgo);
  }

  if (curation === "Budget Friendly") {
    // Per-category median * 0.6 = ~40% cheaper than typical. If no
    // category is specified, fall back to the *minimum* median across
    // all categories — conservative threshold that still returns
    // genuinely cheap listings instead of mid-priced ones in cheaper
    // categories. Skip the filter entirely if no medians cached yet
    // (fresh deploy, cron hasn't populated admin_settings).
    const medianValues = Object.values(categoryMedians);
    if (medianValues.length > 0) {
      let threshold: number;
      if (category && categoryMedians[category]) {
        threshold = Math.round(categoryMedians[category] * 0.6);
      } else {
        threshold = Math.round(Math.min(...medianValues) * 0.6);
      }
      query = query.lte("price_amount", threshold);
    }
  }

  if (conditions.length > 0) {
    query = query.in("condition", conditions);
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

  // Size filter: multi-select on the standardized estimated_size column.
  // "Free Size" / "Free size" are excluded from the DB filter because
  // they're catch-all labels that shouldn't constrain results — keep the
  // original single-value behaviour, just applied across the array.
  const sizesToFilter = sizes.filter(
    (s) => s !== "Free Size" && s !== "Free size"
  );
  if (sizesToFilter.length > 0) {
    query = query.in("estimated_size", sizesToFilter);
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
  // Trending overrides the default sort to a popularity-weighted order
  // so the chip actually surfaces hot listings rather than just-recent
  // ones. If the caller explicitly asked for price_asc/price_desc we
  // still respect that — Trending becomes "popular within this price
  // band" rather than fighting the user's intent.
  if (curation === "Trending" && (sort === "newest" || sort === "relevance")) {
    query = query
      .order("save_count", { ascending: false })
      .order("view_count", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
  } else switch (sort) {
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
        filters: { categories, conditions, occasion, sizes, market, designer },
        result_count: items.length,
      });
    } catch {
      // Non-blocking — search logging failure is not user-facing
    }
  })();

  // total_count: when market or location is applied, the DB-side count
  // is the pre-filter total (1247 listings in DB) because the
  // market/location filter runs in JS post-fetch. That produced the
  // wildly inflated "1247 results" with only 1 visible item bug.
  // Substitute the post-filtered length so the count matches what the
  // user actually sees. Slight under-count on paginated calls (we only
  // know this page's filtered length, not the global total) is better
  // than wildly over-counting; the FE has hasMore / next_cursor to
  // signal "there's more, paginate".
  const effectiveTotalCount =
    market || location ? filteredRows.length : count ?? null;

  return c.json({
    items,
    next_cursor: nextCursor,
    total_count: effectiveTotalCount,
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
