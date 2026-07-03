import { Hono } from "hono";
import { hasDirectDb, getSql } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  LISTING_CATEGORIES,
  LISTING_CATEGORY_CONFIG,
  SUB_CATEGORIES_BY_CATEGORY,
  LISTING_CONDITIONS,
  FABRIC_TYPES,
  WORK_TYPES,
  DRY_CLEANING_STATUSES,
  PRIMARY_COLOURS,
  POPULAR_DESIGNERS,
  OCCASION_TAGS,
  COUNTRIES_OF_ORIGIN,
  SELLER_COUNTRIES,
  COUNTRY_CODES,
  CURATION_TAGS,
  WOMENS_SIZES,
  MENSWEAR_KIDSWEAR_SIZES,
  FOOTWEAR_SIZES,
  ITEMS_INCLUDED_OPTIONS,
  REQUIRED_MEASUREMENTS,
  PHOTO_MIN_COUNT,
} from "../types/listings.js";

const config = new Hono();

// A community brand "graduates" into the designers dropdown once at least
// this many active listings use it. Keeps typos/junk out while letting
// genuinely-used brands surface without a hardcode + deploy.
const COMMUNITY_BRAND_MIN_LISTINGS = 3;

/**
 * Distinct seller-typed brands that have caught on — designer_name values
 * used by >= COMMUNITY_BRAND_MIN_LISTINGS active listings, excluding any
 * already in the curated POPULAR_DESIGNERS list (case-insensitive).
 * Returns most-used first. Best-effort: any failure returns [] so the
 * config endpoint (critical on app start) never breaks.
 */
async function fetchCommunityBrands(): Promise<string[]> {
  if (!hasDirectDb()) return [];
  try {
    const sql = getSql();
    const rows = await sql<{ designer_name: string }[]>`
      SELECT designer_name
      FROM listings
      WHERE status = 'active'
        AND deleted_at IS NULL
        AND designer_name IS NOT NULL
        AND TRIM(designer_name) <> ''
      GROUP BY designer_name
      HAVING COUNT(*) >= ${COMMUNITY_BRAND_MIN_LISTINGS}
      ORDER BY COUNT(*) DESC
    `;
    const curated = new Set(POPULAR_DESIGNERS.map((d) => d.toLowerCase().trim()));
    return rows
      .map((r) => r.designer_name.trim())
      .filter((name) => name && !curated.has(name.toLowerCase()));
  } catch (err) {
    logger.error("config.community_brands_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * GET /api/listing-config
 *
 * Returns the full listing taxonomy + per-category field visibility map.
 * Unauthenticated — taxonomy isn't secret.
 *
 * Frontend should fetch this on app start, cache for ~1 hour, and fall back
 * to a bundled copy if the network is unavailable. Adding a new category,
 * fabric, or option becomes a backend deploy with no mobile release needed.
 */
config.get("/", async (c) => {
  // Curated list first (preserves the intended ordering), then community
  // brands that have organically caught on.
  const communityBrands = await fetchCommunityBrands();
  const designers = [...POPULAR_DESIGNERS, ...communityBrands];

  return c.json({
    categories: LISTING_CATEGORY_CONFIG,
    options: {
      conditions: LISTING_CONDITIONS,
      fabrics: FABRIC_TYPES,
      work_types: WORK_TYPES,
      dry_cleaning_statuses: DRY_CLEANING_STATUSES,
      colours: PRIMARY_COLOURS,
      designers,
      occasion_tags: OCCASION_TAGS,
      countries_of_origin: COUNTRIES_OF_ORIGIN,
      seller_countries: SELLER_COUNTRIES,
      country_codes: COUNTRY_CODES,
      curation_tags: CURATION_TAGS,
      sizes: {
        womens: WOMENS_SIZES,
        menswear_kidswear: MENSWEAR_KIDSWEAR_SIZES,
        footwear: FOOTWEAR_SIZES,
      },
      items_included: ITEMS_INCLUDED_OPTIONS,
    },
    // Second-level taxonomy per parent category (Jewellery, Footwear,
    // Accessories). The filter sheet + listing form use this to render
    // sub-category chips once a single parent is selected. Parents not
    // present here have no sub-categories.
    sub_categories: SUB_CATEGORIES_BY_CATEGORY,
    // Per-category structured measurement hints. These are not enforced by
    // the API (measurements is an optional free-text field) but the form
    // can render them as suggested input fields.
    measurement_hints: REQUIRED_MEASUREMENTS,
    // Display order — render categories in this order on the form / filters.
    category_order: LISTING_CATEGORIES,
    // Minimum number of product photos required to activate a listing.
    // Treat the `"photos"` entry in any category's required_fields as
    // "at least PHOTO_MIN_COUNT product photos uploaded."
    photo_min_count: PHOTO_MIN_COUNT,
  });
});

export default config;
