-- ============================================================
-- Schema Migration 18 — destination-charge payouts
-- ============================================================
-- We moved Stripe Connect sellers from "separate charges and
-- transfers" (funds held in the platform balance, transferred on
-- delivery) to DESTINATION CHARGES (charge made on_behalf_of the
-- seller, funds settle into the seller's own Stripe balance,
-- held there by a manual payout schedule). This is the only way
-- to pay non-AU sellers: an AU platform can't create a standalone
-- cross-border Transfer, but a destination charge is allowed
-- because it's traceable to the original payment.
--
-- On delivery (buyer confirms received, or 10-day auto-complete),
-- we RELEASE by creating a payout on the connected account that
-- pushes their held balance to their bank — see
-- services/payoutService.ts (releaseViaPayout).
--
-- Two additions to the seller_payouts ledger:
--   1. stripe_payout_id — the po_... id returned when we release a
--      destination-charge order (distinct from stripe_transfer_id,
--      which still records the tr_... for legacy/cart orders that
--      remain on the platform-balance transfer path).
--   2. status 'awaiting_funds' — released, but the seller's funds
--      were still `pending` (Stripe's ~2-day settlement) when we
--      tried to pay out. A retry job (JOB_RETRY_STRIPE_PAYOUT)
--      re-attempts once the funds clear.
--
-- Run order: ... → schema-17.sql → schema-18.sql
-- ============================================================

ALTER TABLE seller_payouts
  ADD COLUMN IF NOT EXISTS stripe_payout_id TEXT;

-- Extend the status CHECK to allow the new 'awaiting_funds' state.
-- Drop + re-add because there's no "ALTER CONSTRAINT" for CHECKs.
ALTER TABLE seller_payouts
  DROP CONSTRAINT IF EXISTS seller_payouts_status_check;

ALTER TABLE seller_payouts
  ADD CONSTRAINT seller_payouts_status_check
  CHECK (status IN (
    'pending',
    'ready_for_payout',
    'awaiting_funds',
    'sent',
    'paid',
    'failed',
    'cancelled'
  ));
