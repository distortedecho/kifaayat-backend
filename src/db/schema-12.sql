-- ============================================================
-- Schema Migration 12 — UK → GB country code
-- ============================================================
-- We've been storing the United Kingdom as 'UK' across
-- user_addresses.country, profiles.location, and
-- profiles.wise_bank_country. Every external system we touch
-- (Mapbox autocomplete, Stripe Connect, ISO 3166-1 alpha-2)
-- uses 'GB' instead. This migration aligns the DB with the
-- standard before launch so we never need a coordinated
-- frontend / backend cutover after we have real users.
--
-- Steps for each constrained column:
--   1. Drop the existing CHECK constraint
--   2. UPDATE any rows currently storing 'UK' to 'GB'
--   3. Add the new CHECK constraint with 'GB'
--
-- Run order: ... → schema-11.sql → schema-12.sql
-- ============================================================

-- ----------------------------------------------------------
-- user_addresses.country
-- ----------------------------------------------------------
ALTER TABLE user_addresses
  DROP CONSTRAINT IF EXISTS user_addresses_country_check;

UPDATE user_addresses SET country = 'GB' WHERE country = 'UK';

ALTER TABLE user_addresses
  ADD CONSTRAINT user_addresses_country_check
  CHECK (country IN ('AU', 'US', 'NZ', 'CA', 'GB'));

-- ----------------------------------------------------------
-- profiles.location
-- ----------------------------------------------------------
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_location_check;

UPDATE profiles SET location = 'GB' WHERE location = 'UK';

ALTER TABLE profiles
  ADD CONSTRAINT profiles_location_check
  CHECK (location IS NULL OR location IN ('AU', 'US', 'NZ', 'CA', 'GB'));

-- ----------------------------------------------------------
-- profiles.wise_bank_country
-- ----------------------------------------------------------
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_wise_bank_country_check;

UPDATE profiles SET wise_bank_country = 'GB' WHERE wise_bank_country = 'UK';

ALTER TABLE profiles
  ADD CONSTRAINT profiles_wise_bank_country_check
  CHECK (wise_bank_country IS NULL OR wise_bank_country IN ('AU', 'GB', 'US', 'CA', 'NZ'));
