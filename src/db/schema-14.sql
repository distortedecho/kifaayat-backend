-- ============================================================
-- Schema Migration 14 — orders.delivery_method
-- ============================================================
-- Records whether the buyer chose "shipping" or "pickup" at
-- checkout. Listings have always had pickup_available + a
-- pickup_location field, but orders didn't carry the buyer's
-- choice through to fulfilment — so the lifecycle assumed
-- shipping (paid → shipped → delivered/complete) regardless,
-- forcing the FE to track tracking-numbers on orders that
-- were actually local pickups.
--
-- New flow for pickup orders:
--   paid → (seller accepts) → complete
--   No shipped/delivered intermediate; no tracking number.
--   Buyer's "Mark as collected" goes paid → complete directly.
--   Auto-complete still fires after the same 10-day window but
--   counted from seller_accepted_at instead of shipped_at.
--
-- Default 'shipping' makes the migration safe for existing rows
-- (everything pre-this column was a shipping order).
--
-- Run order: ... → schema-13.sql → schema-14.sql
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'shipping'
    CHECK (delivery_method IN ('shipping', 'pickup'));
