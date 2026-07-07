-- ============================================================
-- Schema Migration 26 — admin audit log (Phase 0.1)
-- ============================================================
-- An append-only, write-once trail of every consequential admin action
-- (refunds, edits, bans, payouts, exports, logins, reject reasons, …).
-- Screen 23 of the desired admin console; also a prerequisite for the
-- refund / force-advance / permanent-delete flows, which must be audited.
--
-- Immutability: rows may be INSERTed and SELECTed but never UPDATEd or
-- DELETEd. Enforced by a trigger that raises on UPDATE/DELETE so even the
-- service role (which bypasses RLS) cannot rewrite history.
--
-- Run order: … → schema-25.sql → schema-26.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,           -- monotonic, cheap ordering
  actor_id     UUID,                            -- admin (profiles.id); NULL for system
  actor_email  TEXT,                            -- snapshot (actors may later be deleted)
  actor_role   TEXT,                            -- role at time of action (null until Phase 0.2)
  action       TEXT NOT NULL,                   -- e.g. 'payout.mark_sent', 'user.ban'
  target_type  TEXT NOT NULL,                   -- 'listing'|'user'|'order'|'payout'|'review'|'message'|'settings'|'export'|'team'
  target_id    TEXT,                            -- id of the thing acted on
  reason       TEXT,                            -- required for refunds/edits/force-advance/delete
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- before/after diff, amounts, etc.
  ip           TEXT,                            -- request IP (x-forwarded-for), best-effort
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target  ON admin_audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON admin_audit_log (action, created_at DESC);

-- ---- Write-once enforcement -------------------------------------------------
-- Block UPDATE and DELETE at the row level so the trail is tamper-evident even
-- for the service role. INSERT and SELECT remain allowed.
CREATE OR REPLACE FUNCTION admin_audit_log_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_log_no_update ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_no_update
  BEFORE UPDATE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable();

DROP TRIGGER IF EXISTS trg_admin_audit_log_no_delete ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_no_delete
  BEFORE DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable();

-- Service-role only (writes come from the backend with the service key).
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON admin_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE admin_audit_log_id_seq TO service_role;
