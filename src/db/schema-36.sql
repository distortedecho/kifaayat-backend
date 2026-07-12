-- ============================================================
-- schema-36: Comment moderation + fraud_flags constraint fix
--
-- Wires the shared moderation engine (src/lib/moderation.ts) into
-- listing comments and gives moderators a hide/restore action + a
-- user-report flag source. App reads must filter `hidden_at IS NULL`.
--
-- ROOT-CAUSE FIX: the original fraud_flags CHECK constraints only allowed
--   entity_type IN ('listing','user','order')  and
--   status      IN ('open','reviewed','dismissed')
-- but the app code has always inserted entity_type='message' with
-- status='pending' (and later 'actioned'). Every one of those inserts
-- silently violated the constraint and was dropped — which is why the
-- moderation queue was permanently empty ("moderation doesn't work").
-- We widen both constraints to the values the code actually uses and
-- allow a NULL entity_id for content that is blocked before it is created.
-- ============================================================

-- fraud_flags: widen constraints to match real usage --------------------------
ALTER TABLE fraud_flags DROP CONSTRAINT IF EXISTS fraud_flags_entity_type_check;
ALTER TABLE fraud_flags
  ADD CONSTRAINT fraud_flags_entity_type_check
  CHECK (entity_type IN ('listing', 'user', 'order', 'message', 'listing_comment', 'review'));

ALTER TABLE fraud_flags DROP CONSTRAINT IF EXISTS fraud_flags_status_check;
ALTER TABLE fraud_flags
  ADD CONSTRAINT fraud_flags_status_check
  CHECK (status IN ('pending', 'open', 'reviewed', 'actioned', 'dismissed'));

-- BLOCK-tier comments are rejected before a row exists; we still log the
-- attempt as a flag with a NULL entity_id (content lives in details).
ALTER TABLE fraud_flags ALTER COLUMN entity_id DROP NOT NULL;

-- Comment-level moderation state ----------------------------------------------
ALTER TABLE listing_comments
  ADD COLUMN IF NOT EXISTS hidden_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_by    UUID,
  ADD COLUMN IF NOT EXISTS flagged_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS flag_source  TEXT;

-- flag_source: who/what raised the most recent flag on this comment.
--   'auto'  = moderation engine (system)
--   'user'  = reported by another user
--   'admin' = hidden manually by a moderator
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listing_comments_flag_source_check'
  ) THEN
    ALTER TABLE listing_comments
      ADD CONSTRAINT listing_comments_flag_source_check
      CHECK (flag_source IS NULL OR flag_source IN ('auto', 'user', 'admin'));
  END IF;
END $$;

-- App reads hide moderated comments; this keeps that filter fast.
CREATE INDEX IF NOT EXISTS idx_listing_comments_visible
  ON listing_comments (listing_id, created_at)
  WHERE hidden_at IS NULL;

-- Moderation queue: fraud_flags is scanned by entity_type + status.
-- Supports the three admin sections (message/system, comment/system, comment/user_report).
CREATE INDEX IF NOT EXISTS idx_fraud_flags_queue
  ON fraud_flags (entity_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fraud_flags_entity
  ON fraud_flags (entity_type, entity_id);
