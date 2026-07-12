-- ============================================================
-- schema-38: Push delivery count
--
-- OneSignal returns how many devices a notification was delivered to
-- (`recipients`) in the send response. Persist it so the admin console can
-- show "Sent to N devices" per campaign. Additive.
-- ============================================================

ALTER TABLE push_campaigns
  ADD COLUMN IF NOT EXISTS recipients INTEGER;
