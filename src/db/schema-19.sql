-- ============================================================
-- Schema Migration 19 — listing soft-delete
-- ============================================================
-- The app's "delete listing" only deactivated the row (status flip),
-- so deleted items still lingered in the seller's list. We now support
-- a real delete (DELETE /api/listings/:id):
--
--   - No orders reference the listing  → HARD delete (row removed;
--     photos / wishlists / offers / comments cascade away).
--   - Orders DO reference it           → SOFT delete: we can't hard-
--     delete because orders.listing_id is ON DELETE CASCADE, which
--     would wipe transaction history. Instead we stamp deleted_at +
--     set status='deactivated' and filter it out of listing views.
--   - In-flight order / reserved       → blocked (can't delete mid-sale).
--
-- deleted_at IS NULL is filtered in the seller's own list (GET /me) and
-- the public listing view (GET /:id). Search already excludes it (only
-- returns 'active').
--
-- Run order: ... → schema-18.sql → schema-19.sql
-- ============================================================

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index — the deleted set is small and every listing view wants
-- "not deleted", so keep that filter cheap.
CREATE INDEX IF NOT EXISTS idx_listings_deleted_at
  ON listings(deleted_at)
  WHERE deleted_at IS NOT NULL;
