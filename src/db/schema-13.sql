-- ============================================================
-- Schema Migration 13 — Stripe webhook event.id dedup
-- ============================================================
-- Stripe redelivers webhook events on any non-2xx response, on
-- timeout, or just occasionally on its own — Stripe's own docs
-- explicitly say "your endpoint will receive duplicate events".
-- Without an event.id-keyed dedup table the second delivery of
-- payment_intent.succeeded re-runs the whole handler and fires
-- the "You Made a Sale!" push to the seller a second time.
--
-- Standard Stripe pattern: insert event.id into a table with a
-- PRIMARY KEY constraint at the very top of the handler. If the
-- INSERT conflicts the event was already processed → return 200
-- silently. Otherwise proceed.
--
-- The table is intentionally minimal: we only need the event id
-- for idempotency. event_type and received_at help debugging.
--
-- Run order: ... → schema-12.sql → schema-13.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_received_at
  ON stripe_events(received_at);

-- Lock out anon + authenticated. Only the backend (service role)
-- ever touches this table; service role bypasses RLS. Enabling RLS
-- without adding any policy denies access to the public PostgREST
-- roles, which is exactly what we want — this table is a
-- server-internal idempotency ledger, never queryable by clients.
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
