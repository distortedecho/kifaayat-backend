-- ============================================================
-- Schema Migration 25 — denormalized listings.seller_location
-- ============================================================
-- Country filtering (search + feed) needs to page over listings by the
-- SELLER's location. That attribute lives on profiles, so filtering it via
-- an embedded PostgREST join can't restrict the top-level listings before
-- pagination — the filter had to run in JS *after* fetching one page, which
-- silently dropped any match past the first DB page (e.g. an AU Lehenga
-- ranked #73 of 79 by newest never appeared) and killed pagination.
--
-- Fix: denormalize the seller's location onto listings as a native column
-- so both the strict `location` filter and the inclusive `market` filter
-- (seller_location = market OR international_shipping) become native,
-- indexable, paginatable DB filters.
--
-- Kept in sync by triggers:
--   - BEFORE INSERT/UPDATE OF seller_id ON listings → stamp from profiles
--   - AFTER UPDATE OF location ON profiles → propagate to all their listings
--
-- Run order: … → schema-24.sql → schema-25.sql
-- ============================================================

ALTER TABLE listings ADD COLUMN IF NOT EXISTS seller_location TEXT;

-- Index the country filter (partial: null locations are never filtered TO).
CREATE INDEX IF NOT EXISTS idx_listings_seller_location
  ON listings (seller_location)
  WHERE seller_location IS NOT NULL;

-- ---- Backfill existing rows from the seller's current location ----
UPDATE listings l
SET seller_location = p.location
FROM profiles p
WHERE p.id = l.seller_id
  AND l.seller_location IS DISTINCT FROM p.location;

-- ---- Sync trigger 1: stamp seller_location whenever a listing's seller
--      is set or changed (covers new listings, importer, admin reassigns).
CREATE OR REPLACE FUNCTION set_listing_seller_location()
RETURNS TRIGGER AS $$
BEGIN
  SELECT p.location INTO NEW.seller_location
  FROM profiles p
  WHERE p.id = NEW.seller_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_listing_seller_location ON listings;
CREATE TRIGGER trg_set_listing_seller_location
  BEFORE INSERT OR UPDATE OF seller_id ON listings
  FOR EACH ROW
  EXECUTE FUNCTION set_listing_seller_location();

-- ---- Sync trigger 2: when a seller changes their location, propagate it
--      to all of their listings (sellers rarely relocate, so this is cheap).
CREATE OR REPLACE FUNCTION propagate_seller_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.location IS DISTINCT FROM OLD.location THEN
    UPDATE listings
    SET seller_location = NEW.location
    WHERE seller_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_seller_location ON profiles;
CREATE TRIGGER trg_propagate_seller_location
  AFTER UPDATE OF location ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION propagate_seller_location();
