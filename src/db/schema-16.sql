-- ============================================================
-- Schema Migration 16 — listings.sub_category
-- ============================================================
-- Second-level taxonomy under three of the existing categories
-- (Jewellery, Other, Footwear) so the filter sheet can drill in
-- from "Jewellery" to "Earrings", etc.
--
-- TEXT column, nullable, no CHECK constraint. The vocabulary
-- lives in src/types/listings.ts (SUB_CATEGORIES_BY_CATEGORY)
-- and the validator (isValidSubCategoryPair) is invoked by the
-- listings create/update endpoints. Keeping validation in TS
-- means we can rename "Other Jewellery" → "Anklets/Other"
-- without a migration — just an app deploy.
--
-- Existing listings stay NULL. The filter UI treats null as
-- "untagged" — they show under the parent category but not
-- under any specific sub-category filter (this is the
-- documented "legacy listings not in sub-filter" behaviour).
--
-- Run order: ... → schema-15.sql → schema-16.sql
-- ============================================================

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS sub_category TEXT;

-- Indexed because the filter sheet sends this on every search
-- request once enabled. Partial WHERE NOT NULL keeps the index
-- tiny — only counts the small sub-set of tagged listings.
CREATE INDEX IF NOT EXISTS idx_listings_sub_category
  ON listings(sub_category)
  WHERE sub_category IS NOT NULL;
