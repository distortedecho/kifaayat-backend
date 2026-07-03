import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { hasDirectDb, getSql } from "../lib/db.js";

// ============================================================
// Public website endpoints
// ============================================================
// Read-only, unauthenticated marketing/discovery data for the
// public website (not the app). All cheap, cacheable responses.

const website = new Hono();

// Markets the country picker can select (same set as /api/search + /api/feed).
const VALID_MARKETS = ["AU", "US", "NZ", "CA", "GB"] as const;
type Market = (typeof VALID_MARKETS)[number];

/**
 * Read + validate the optional `?market=` param. Country filtering is
 * opt-in: no param → return everything (backward compatible, unchanged for
 * any caller not sending it). Present-but-unknown → `invalid` so the
 * handler can 400 (matching /api/search). Present-and-valid → the market.
 */
function readMarket(m: string | undefined): {
  market: Market | null;
  invalid: boolean;
} {
  if (!m) return { market: null, invalid: false };
  if (!VALID_MARKETS.includes(m as Market)) return { market: null, invalid: true };
  return { market: m as Market, invalid: false };
}

/**
 * GET /api/website/in-demand
 * "Most-saved pieces" — active listings ranked by how many times they
 * were wishlisted in the last 30 days (real recent demand, not the
 * cumulative all-time save_count). Each is annotated with discovery
 * tags:
 *   - "Trending"        saved multiple times in the window
 *   - "New with tags"   condition is brand-new-with-tags
 *   - "Receipt verified" seller uploaded a proof-of-purchase receipt
 *   - "Just landed"     listed in the last 7 days
 */
website.get("/in-demand", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const limit = Math.min(parseInt(c.req.query("limit") || "12", 10) || 12, 50);
  const { market, invalid } = readMarket(c.req.query("market"));
  if (invalid) return c.json({ error: "Invalid market" }, 400);

  if (!hasDirectDb()) {
    return c.json({ error: "Service unavailable" }, 503);
  }

  // Rank active listings by wishlist saves in the last 30 days.
  // saves_recent comes from the join so the tag logic can use the real
  // windowed figure.
  let rows: Array<{
    id: string;
    title: string;
    price_amount: number;
    price_currency: string;
    original_price_amount: number | null;
    category: string;
    condition: string;
    designer_name: string | null;
    created_at: string;
    saves_recent: number;
  }>;
  try {
    const sql = getSql();
    // Inclusive market scope (matches /api/feed): sellers local to the
    // market OR listings that ship internationally OR listings with no
    // known seller location. seller_location is the denormalized column
    // from schema-25.
    const marketFilter = market
      ? sql`AND (l.seller_location = ${market} OR l.international_shipping IS TRUE OR l.seller_location IS NULL)`
      : sql``;
    rows = await sql`
      SELECT
        l.id, l.title, l.price_amount, l.price_currency,
        l.original_price_amount, l.category, l.condition,
        l.designer_name, l.created_at,
        COUNT(w.*)::int AS saves_recent
      FROM wishlists w
      JOIN listings l ON l.id = w.listing_id
      WHERE w.created_at >= NOW() - INTERVAL '30 days'
        AND l.status = 'active'
        ${marketFilter}
      GROUP BY l.id
      ORDER BY saves_recent DESC, l.created_at DESC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error("[website/in-demand] query failed:", err);
    return c.json({ error: "Failed to load in-demand listings" }, 500);
  }

  const ids = rows.map((l) => l.id);

  // One query for all photos of these listings: pick the cover (lowest
  // product position) and detect whether a receipt photo exists.
  const coverByListing: Record<string, string> = {};
  const hasReceipt: Set<string> = new Set();
  if (ids.length > 0) {
    const { data: photos } = await supabase
      .from("listing_photos")
      .select("listing_id, url, position, photo_type")
      .in("listing_id", ids)
      .order("position", { ascending: true });
    for (const p of photos ?? []) {
      const lid = p.listing_id as string;
      if (p.photo_type === "receipt") {
        hasReceipt.add(lid);
      } else if ((p.photo_type ?? "product") === "product" && !(lid in coverByListing)) {
        coverByListing[lid] = p.url as string;
      }
    }
  }

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // "Trending" = saved 3+ times in the 30-day window.
  const TRENDING_SAVES = 3;

  const items = rows.map((l) => {
    const id = l.id;
    const tags: string[] = [];

    if (l.saves_recent >= TRENDING_SAVES) tags.push("Trending");
    if (l.condition === "New with tags") tags.push("New with tags");
    if (hasReceipt.has(id)) tags.push("Receipt verified");
    if (new Date(l.created_at).getTime() >= sevenDaysAgo) {
      tags.push("Just landed");
    }

    return {
      id,
      title: l.title,
      price_amount: l.price_amount,
      price_currency: l.price_currency,
      original_price_amount: l.original_price_amount ?? null,
      category: l.category,
      condition: l.condition,
      designer_name: l.designer_name ?? null,
      cover_photo_url: coverByListing[id] ?? null,
      saves_recent: l.saves_recent,
      tags,
    };
  });

  return c.json({ items });
});

/**
 * GET /api/website/just-sold
 * Social-proof carousel of recent sales — category, sale price, and
 * the seller's market location. No buyer/seller identity, no listing
 * title or photo: just "an Anarkali sold for A$120 in AU". Excludes
 * cancelled/refunded orders.
 */
website.get("/just-sold", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const limit = Math.min(parseInt(c.req.query("limit") || "12", 10) || 12, 50);
  const { market, invalid } = readMarket(c.req.query("market"));
  if (invalid) return c.json({ error: "Invalid market" }, 400);

  // "Just sold in <market>" = sales by sellers located in that market
  // (strict). When a market is set we INNER-join the seller so
  // `.eq("seller.location", …)` actually restricts the orders — a plain
  // embed would only null the seller and still return the row.
  const sellerEmbed = market
    ? "seller:profiles!orders_seller_id_fkey!inner(location)"
    : "seller:profiles!orders_seller_id_fkey(location)";
  let query = supabase
    .from("orders")
    .select(
      `amount, currency, created_at, listings!orders_listing_id_fkey(category), ${sellerEmbed}`
    )
    .neq("status", "cancelled");
  if (market) query = query.eq("seller.location", market);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[website/just-sold] query failed:", error);
    return c.json({ error: "Failed to load recent sales" }, 500);
  }

  const items = (data ?? []).map((o) => {
    const listing = o.listings as unknown as { category: string } | null;
    const seller = o.seller as unknown as { location: string | null } | null;
    return {
      category: listing?.category ?? null,
      price_amount: o.amount,
      price_currency: o.currency,
      location: seller?.location ?? null,
      sold_at: o.created_at,
    };
  });

  return c.json({ items });
});

/**
 * GET /api/website/designers
 * Designers people are reselling — distinct designer names across
 * active listings, ordered by how many listings each has. Returns
 * name + count; the website can render just the names.
 */
website.get("/designers", optionalClerkMiddleware, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
  const { market, invalid } = readMarket(c.req.query("market"));
  if (invalid) return c.json({ error: "Invalid market" }, 400);

  if (!hasDirectDb()) {
    return c.json({ error: "Service unavailable" }, 503);
  }

  try {
    const sql = getSql();
    // Inclusive market scope (matches /api/feed).
    const marketFilter = market
      ? sql`AND (seller_location = ${market} OR international_shipping IS TRUE OR seller_location IS NULL)`
      : sql``;
    const rows = await sql<{ name: string; count: number }[]>`
      SELECT designer_name AS name, COUNT(*)::int AS count
      FROM listings
      WHERE status = 'active'
        AND designer_name IS NOT NULL
        AND designer_name <> ''
        ${marketFilter}
      GROUP BY designer_name
      ORDER BY count DESC, designer_name ASC
      LIMIT ${limit}
    `;
    return c.json({ designers: rows });
  } catch (err) {
    console.error("[website/designers] query failed:", err);
    return c.json({ error: "Failed to load designers" }, 500);
  }
});

/**
 * GET /api/website/top-sellers
 * Top-rated sellers — ranked by average rating (buyer reviews, only
 * revealed ones), tie-broken by review count. Each includes their
 * completed-sales count.
 */
website.get("/top-sellers", optionalClerkMiddleware, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10) || 20, 100);
  const { market, invalid } = readMarket(c.req.query("market"));
  if (invalid) return c.json({ error: "Invalid market" }, 400);

  if (!hasDirectDb()) {
    return c.json({ error: "Service unavailable" }, 503);
  }

  try {
    const sql = getSql();
    // "Top sellers in <market>" = sellers located in that market (strict,
    // like the app feed's Top Wardrobes).
    const marketFilter = market ? sql`AND p.location = ${market}` : sql``;
    const rows = await sql<
      {
        id: string;
        display_name: string | null;
        avatar_url: string | null;
        location: string | null;
        avg_rating: number;
        review_count: number;
        sales_count: number;
      }[]
    >`
      SELECT
        p.id,
        p.display_name,
        p.avatar_url,
        p.location,
        ROUND(AVG(r.rating)::numeric, 2)::float AS avg_rating,
        COUNT(r.id)::int AS review_count,
        (
          SELECT COUNT(*)::int
          FROM orders o
          WHERE o.seller_id = p.id AND o.status = 'complete'
        ) AS sales_count
      FROM profiles p
      JOIN reviews r
        ON r.reviewee_id = p.id
        AND r.reviewer_role = 'buyer'
        AND r.revealed_at IS NOT NULL
      WHERE p.deleted_at IS NULL
        ${marketFilter}
      GROUP BY p.id
      HAVING COUNT(r.id) >= 1
      ORDER BY avg_rating DESC, review_count DESC
      LIMIT ${limit}
    `;
    return c.json({ sellers: rows });
  } catch (err) {
    console.error("[website/top-sellers] query failed:", err);
    return c.json({ error: "Failed to load top sellers" }, 500);
  }
});

export default website;
