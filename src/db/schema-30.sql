-- ============================================================
-- Schema Migration 30 — campaign referral codes (Phase 2)
-- ============================================================
-- The admin console mints one-off CAMPAIGN codes (not tied to a user),
-- while user/influencer codes still auto-issue on signup. Add a code_type
-- + campaign_name, and allow a null user_id for campaign codes.
--
-- Run order: … → schema-29.sql → schema-30.sql
-- ============================================================

ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS code_type TEXT NOT NULL DEFAULT 'user'
  CHECK (code_type IN ('user', 'influencer', 'campaign'));
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS campaign_name TEXT;

-- Campaign codes have no owner.
ALTER TABLE referral_codes ALTER COLUMN user_id DROP NOT NULL;
