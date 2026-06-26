-- ============================================================
-- Schema Migration 17 — account deletion (soft-delete)
-- ============================================================
-- Apple + Google both REQUIRE apps that allow account creation to
-- offer in-app account deletion. We use soft-delete rather than hard
-- delete because a marketplace can't physically remove a user whose
-- past orders/reviews are part of another user's history (a buyer's
-- completed purchase, a seller's received review, etc).
--
-- On deletion (see DELETE /api/profiles/me):
--   - deleted_at is stamped
--   - PII (email, display_name, phone, avatar_url, bio, payout fields)
--     is nulled / anonymised
--   - clerk_id is nulled and the Clerk user is deleted, so they can't
--     log back into the dead profile; a fresh signup makes a new one
--   - their active listings are deactivated
--
-- Transactional records (orders, reviews) are deliberately preserved
-- so the counterparties' history stays intact.
--
-- Run order: ... → schema-16.sql → schema-17.sql
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index — most queries only ever want live accounts, and the
-- deleted set is small. Lets "exclude deleted" filters stay cheap.
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at
  ON profiles(deleted_at)
  WHERE deleted_at IS NOT NULL;
