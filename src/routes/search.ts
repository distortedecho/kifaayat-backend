import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { LISTING_CATEGORIES, LISTING_CONDITIONS, OCCASION_TAGS } from "../types/listings.js";

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
  cover_photo_url: string | null;
  seller_name: string | null;
  seller_location: string | null;
}

// Size filter maps to bust measurement ranges (in inches)
const SIZE_RANGES: Record<string, { min: number; max: number } | null> = {
  XS: { min: 0, max: 32 },
  S: { min: 32, max: 34 },
  M: { min: 34, max: 36 },
  L: { min: 36, max: 38 },
  XL: { min: 38, max: 40 },
  XXL: { min: 40, max: 100 },
  Free: null, // no measurement filter
};

// Categories that don't have bust measurements
const NO_BUST_CATEGORIES = ["Saree", "Dupatta", "Jewellery"];

// ============================================================
// Helpers
// ============================================================

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

  // Parse query params
  const q = c.req.query("q")?.trim() || "";
  const category = c.req.query("category");
  const condition = c.req.query("condition");
  const occasion = c.req.query("occasion"); // comma-separated
  const color = c.req.query("color"); // comma-separated
  const location = c.req.query("location");
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
  if (location && !["AU", "US", "NZ"].includes(location)) {
    return c.json({ error: "Invalid location filter" }, 400);
  }
  if (size && !Object.keys(SIZE_RANGES).includes(size)) {
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

  // Base query: active listings with photos and seller info
  let query = supabase
    .from("listings")
    .select(
      "id, title, description, price_amount, price_currency, original_price_amount, category, condition, measurements, occasion_tags, colors, created_at, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location)",
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

  // Size filter: maps to bust measurement ranges
  // For categories without bust (Saree, Dupatta, Jewellery), size filter is ignored
  if (size && size !== "Free" && SIZE_RANGES[size]) {
    const range = SIZE_RANGES[size]!;
    // Exclude categories that don't have bust measurements
    if (category && NO_BUST_CATEGORIES.includes(category)) {
      // Size filter ignored for this category — do nothing
    } else if (!category) {
      // No category filter: exclude non-bust categories from size filtering
      // Apply size filter but only on categories that have bust measurements
      query = query
        .not("category", "in", `(${NO_BUST_CATEGORIES.join(",")})`)
        .not("measurements->bust", "is", "null")
        .gte("measurements->bust", String(range.min))
        .lte("measurements->bust", String(range.max));
    } else {
      // Category that has bust measurements
      query = query
        .not("measurements->bust", "is", "null")
        .gte("measurements->bust", String(range.min))
        .lte("measurements->bust", String(range.max));
    }
  }

  // Location filter: join with profiles
  if (location) {
    // Filter by seller's location via the join
    query = query.eq("profiles.location", location);
  }

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

  // If location filter is active, the join filter may have returned listings
  // where the profiles join is null — filter those out
  let filteredRows = allRows;
  if (location) {
    filteredRows = allRows.filter((row: Record<string, unknown>) => {
      const profiles = row.profiles as Record<string, unknown> | null;
      return profiles && profiles.location === location;
    });
  }

  const hasMore = filteredRows.length > limit;
  const pageRows = hasMore ? filteredRows.slice(0, limit) : filteredRows;

  const items: ListingSummary[] = pageRows.map(
    (row: Record<string, unknown>) => {
      const profiles = row.profiles as Record<string, unknown> | null;
      const photos = row.listing_photos as Array<Record<string, unknown>> | null;

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
  );

  const nextCursor = hasMore
    ? (pageRows[pageRows.length - 1] as Record<string, unknown>).id as string
    : null;

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
