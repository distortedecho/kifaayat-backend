-- ============================================================
-- Schema Migration 11 — AI assist preference
-- ============================================================
-- Adds a per-user toggle for AI-powered listing creation help
-- (e.g. the /api/ai/analyze description / category suggestions
-- and /api/ai/remove-background photo cleanup). When OFF, the
-- frontend hides the AI assist buttons in the listing form;
-- the AI endpoints themselves stay available for any client
-- that calls them directly (no server-side gating).
--
-- Default TRUE so existing users get the better experience by
-- default; can opt out from settings.
--
-- Run order: ... → schema-10.sql → schema-11.sql
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS ai_assist_enabled BOOLEAN DEFAULT TRUE;
