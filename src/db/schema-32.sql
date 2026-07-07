-- ============================================================
-- Schema Migration 32 — settings policies (Phase 6)
-- ============================================================
-- Screen 21 adds commercial levers + core policies alongside the existing
-- commission_rate. All nullable/defaulted so existing rows keep working.
--
-- Run order: … → schema-31.sql → schema-32.sql
-- ============================================================

ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS cooling_off_days INT NOT NULL DEFAULT 10;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS min_listing_price_cents INT NOT NULL DEFAULT 500;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS active_regions TEXT[] NOT NULL DEFAULT ARRAY['AU','US','NZ','CA','GB'];
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS require_receipt_for_designer BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS no_publish_without_review BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS hide_fees_from_sellers BOOLEAN NOT NULL DEFAULT true;
