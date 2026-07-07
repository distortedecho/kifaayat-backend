-- ============================================================
-- Schema Migration 31 — moderation hold + review moderation (Phase 3)
-- ============================================================
-- Screens 14/15. Held messages are withheld from the recipient until an
-- operator publishes (or hides) them; reviews can be flagged, hidden, and
-- disputed in-console.
--
-- Run order: … → schema-30.sql → schema-31.sql
-- ============================================================

-- ---- Messages: hold / hide state (Screen 14) ----
ALTER TABLE messages ADD COLUMN IF NOT EXISTS moderation_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS moderation_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS moderated_by UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_held ON messages (conversation_id)
  WHERE moderation_hold = true;

-- ---- Reviews: flag / hide / dispute (Screen 15) ----
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS flag_reason TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS flag_source TEXT
  CHECK (flag_source IS NULL OR flag_source IN ('seller', 'auto', 'admin'));
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS hidden_by UUID;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS dispute_status TEXT
  CHECK (dispute_status IS NULL OR dispute_status IN ('open', 'resolved'));

CREATE INDEX IF NOT EXISTS idx_reviews_flagged ON reviews (flagged_at)
  WHERE flagged_at IS NOT NULL AND hidden_at IS NULL;
