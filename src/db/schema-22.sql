-- ============================================================
-- Schema Migration 22 — add 'Accessories' category
-- ============================================================
-- Per the client's data-mapping review, bags / belts / accessories become
-- their own top-level category "Accessories" (previously collapsed into
-- "Other"). Widen the listings category CHECK to allow it so the
-- sub-category backfill can move those listings.
--
-- Sub-categories (Bags/Clutches, Belts, Other accessories) live TS-side in
-- SUB_CATEGORIES_BY_CATEGORY — no DB change needed for those.
--
-- Run order: ... → schema-21.sql → schema-22.sql
-- ============================================================

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_category_check;
ALTER TABLE listings ADD CONSTRAINT listings_category_check
  CHECK (category IS NULL OR category IN (
    'Lehenga', 'Saree', 'Suit/Salwar', 'Anarkali', 'Indowestern',
    'Sharara', 'Jewellery', 'Dupatta', 'Blouse', 'Menswear', 'Kidswear',
    'Footwear', 'Accessories', 'Other'
  ));
