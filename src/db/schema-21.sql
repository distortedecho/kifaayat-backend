-- ============================================================
-- Schema Migration 21 — draft listings with partial data
-- ============================================================
-- Sellers should be able to save a DRAFT with just photos/video and fill
-- in the details later. Previously title/category/condition/price_amount
-- were NOT NULL, so a media-only draft couldn't be inserted at all.
--
-- These become nullable. They're still REQUIRED to PUBLISH — enforced at
-- the app layer (createListingSchema requires them when status='active',
-- and the draft→pending_review transition runs validateListingCompleteness).
-- The existing CHECK constraints stay and still apply to non-null values
-- (a CHECK passes on NULL), so a draft can't hold an invalid category/
-- condition — only an empty one.
--
-- Blast radius is small: drafts are only visible to their owner (search +
-- public views require status='active'), so a null title/category only
-- shows in the seller's own draft editor as an empty field.
--
-- Run order: ... → schema-20.sql → schema-21.sql
-- ============================================================

ALTER TABLE listings ALTER COLUMN title DROP NOT NULL;
ALTER TABLE listings ALTER COLUMN category DROP NOT NULL;
ALTER TABLE listings ALTER COLUMN condition DROP NOT NULL;
ALTER TABLE listings ALTER COLUMN price_amount DROP NOT NULL;
