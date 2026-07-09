-- ============================================================
-- Schema Migration 35 — newsletter subscribers (web footer signup)
-- ============================================================
-- Captures footer newsletter signups. Idempotent by email (lowercased);
-- re-subscribing just flips status back to 'subscribed'. No double opt-in
-- for v1 — plain capture. status supports a future unsubscribe flow.
--
-- Run order: … → schema-34.sql → schema-35.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,        -- stored lower-cased
  source      TEXT,                        -- e.g. 'web_footer'
  market      TEXT,                        -- AU | US | NZ | CA | GB
  status      TEXT NOT NULL DEFAULT 'subscribed'
                CHECK (status IN ('subscribed', 'unsubscribed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers (status);

-- Writes go through the backend (service role). No anon/authenticated
-- policies → default-deny for public keys.
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON newsletter_subscribers TO service_role;
