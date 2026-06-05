import { Hono } from "hono";
import {
  LISTING_CATEGORIES,
  LISTING_CATEGORY_CONFIG,
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
config.get("/", (c) => {
  return c.json({
    categories: LISTING_CATEGORY_CONFIG,
    options: {
      conditions: LISTING_CONDITIONS,
      fabrics: FABRIC_TYPES,
      work_types: WORK_TYPES,
      dry_cleaning_statuses: DRY_CLEANING_STATUSES,
      colours: PRIMARY_COLOURS,
      designers: POPULAR_DESIGNERS,
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
