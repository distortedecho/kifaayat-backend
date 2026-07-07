-- ============================================================
-- Schema Migration 28 — listings.quality_checks (Phase 0.3)
-- ============================================================
-- The auto quality-score's explainable breakdown (Screens 03/04). A JSONB
-- blob holding the per-check results + a 0–100 roll-up, computed alongside
-- the existing risk_score but kept SEPARATE so the two engines don't
-- entangle (risk_score still drives auto-approve untouched).
--
-- Shape:
--   {
--     "checks": [ { "key": "image_count", "label": "...", "score": 0-100,
--                   "verdict": "pass|near|fail|unknown", "weight": 15,
--                   "detail": "3 product photos" }, ... ],
--     "score": 0-100 | null,          -- weighted roll-up (null if none scored)
--     "scored_at": "2026-07-08T..."
--   }
--
-- Run order: … → schema-27.sql → schema-28.sql
-- ============================================================

ALTER TABLE listings ADD COLUMN IF NOT EXISTS quality_checks JSONB;

-- Partial index for "sort by quality" in the review queue (Screen 03).
CREATE INDEX IF NOT EXISTS idx_listings_quality_score
  ON listings (((quality_checks->>'score')::int))
  WHERE quality_checks IS NOT NULL;
