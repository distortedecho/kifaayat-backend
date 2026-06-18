-- ============================================================
-- Schema Migration 10 — International shipping cost
-- ============================================================
-- Until now the schema only had ONE shipping cost (shipping_cost_amount)
-- that was charged regardless of whether the buyer was domestic or
-- international. Sellers who enabled international_shipping ended up
-- absorbing the cost difference on overseas orders, or set their
-- shipping price high enough to cover the worst case (making domestic
-- look expensive).
--
-- Adds a dedicated international cost column so sellers can price
-- domestic vs international independently. At payment-intent time
-- the backend picks the right one based on buyer vs seller country.
--
-- Fallback: if international_shipping_cost_amount is NULL, the buyer
-- pays the regular shipping_cost_amount (preserves current behaviour
-- for migrated and pre-existing listings).
--
-- Run order: schema.sql → ... → schema-09.sql → schema-10.sql
-- ============================================================

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS international_shipping_cost_amount INTEGER;
