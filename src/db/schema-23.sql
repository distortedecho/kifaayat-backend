-- ============================================================
-- Schema Migration 23 — designer origin + cleanup support
-- ============================================================
-- The client sent a canonical designer list (Column C) plus an Origin
-- tag (Indian / Pakistani / Unknown) per brand. We backfill listings'
-- designer_name to the canonical value and record the brand origin so the
-- app can segment/filter "Indian" vs "Pakistani" designers.
--
-- designer_origin is nullable; only 'Indian' / 'Pakistani' are stored
-- (Unknown → NULL). See scripts/backfill-designers.ts.
--
-- Run order: ... → schema-22.sql → schema-23.sql
-- ============================================================

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS designer_origin TEXT
    CHECK (designer_origin IS NULL OR designer_origin IN ('Indian', 'Pakistani'));

-- Small partial index — filtering by a known origin is the only query;
-- the NULL/Unknown majority is excluded so the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_listings_designer_origin
  ON listings(designer_origin)
  WHERE designer_origin IS NOT NULL;
