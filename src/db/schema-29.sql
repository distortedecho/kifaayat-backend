-- ============================================================
-- Schema Migration 29 — admin roles & team access (Phase 0.2)
-- ============================================================
-- Role-based admin access (Screen 22). Admins authenticate via Supabase
-- Auth; this table adds a role + optional per-user permission overrides +
-- 2FA status on top. Middleware resolves the row by supabase_user_id.
--
-- Bootstrap: members of ADMIN_EMAILS are auto-provisioned as 'owner' on
-- their first authenticated request (so nobody is locked out), and
-- ADMIN_EMAILS remains a fallback until every admin exists here.
--
-- Run order: … → schema-28.sql → schema-29.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id     UUID UNIQUE NOT NULL,
  email                TEXT UNIQUE NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'support'
                         CHECK (role IN ('owner', 'admin', 'moderator', 'support')),
  permissions_override JSONB,           -- { "grant": [...], "deny": [...] }
  two_factor_enabled   BOOLEAN NOT NULL DEFAULT false,
  invited_by           UUID REFERENCES admin_users(id),
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('invited', 'active', 'disabled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_users_supabase ON admin_users (supabase_user_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users (LOWER(email));

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON admin_users TO service_role;
