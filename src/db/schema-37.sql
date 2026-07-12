-- ============================================================
-- schema-37: Reversible background-removed cover override
--
-- Admin can remove the background on a listing's cover photo (Screen 04).
-- We keep the original photos untouched and store the processed image as an
-- override on the listing itself, so it's fully reversible (set → apply,
-- null → revert) and audited. Additive; app/web read paths are unaffected
-- until they choose to prefer this override.
-- ============================================================

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS cover_bg_removed_url  TEXT,
  ADD COLUMN IF NOT EXISTS cover_bg_removed_path TEXT,
  ADD COLUMN IF NOT EXISTS cover_bg_removed_by   UUID,
  ADD COLUMN IF NOT EXISTS cover_bg_removed_at   TIMESTAMPTZ;
