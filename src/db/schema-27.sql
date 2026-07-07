-- ============================================================
-- Schema Migration 27 — seller_quality (Phase 0.4)
-- ============================================================
-- Admin-only, operator-assigned quality rating for a seller (0.0–5.0),
-- shown on the user record (Screens 11/12) and fed into the listing
-- quality-score's seller-activity term (Phase 0.3, replacing the retiring
-- trust_tier). NEVER surfaced to users or in any public/app response.
--
-- Run order: … → schema-26.sql → schema-27.sql
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS seller_quality NUMERIC(2,1)
    CHECK (seller_quality IS NULL OR (seller_quality >= 0 AND seller_quality <= 5));
