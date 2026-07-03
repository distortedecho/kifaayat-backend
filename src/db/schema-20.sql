-- ============================================================
-- Schema Migration 20 — offers.offered_by
-- ============================================================
-- The app derived "who made this offer" (buyer vs seller bubble side,
-- whose turn it is) from round parity (round % 2). That's fragile:
-- `round` resets to 1 whenever a closed offer chain is re-opened on the
-- same (listing_id, buyer_id) pair, so parity reasoning breaks across
-- cycles once offers are flattened + sorted by created_at.
--
-- offered_by makes the maker explicit on every row, so the client labels
-- bubbles / turns directly instead of inferring from round:
--   - round 1 (initial offer)      → 'buyer'  (buyers always initiate)
--   - counter by seller            → 'seller'
--   - counter by buyer             → 'buyer'
--
-- Backfill for existing rows uses the (previously reliable, pre-reopen)
-- parity: odd round = buyer-made, even round = seller-made.
--
-- Run order: ... → schema-19.sql → schema-20.sql
-- ============================================================

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS offered_by TEXT
    CHECK (offered_by IN ('buyer', 'seller'));

-- Backfill existing rows from round parity.
UPDATE offers
SET offered_by = CASE WHEN (round % 2) = 1 THEN 'buyer' ELSE 'seller' END
WHERE offered_by IS NULL;
