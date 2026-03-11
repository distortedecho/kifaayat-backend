-- ============================================================
-- Phase 6: Polish & Launch Readiness
-- ============================================================

-- ============================================================
-- Exchange Rates cache table
-- ============================================================

CREATE TABLE IF NOT EXISTS exchange_rates (
  id SERIAL PRIMARY KEY,
  base_currency TEXT NOT NULL,
  target_currency TEXT NOT NULL,
  rate NUMERIC(12,6) NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(base_currency, target_currency)
);

-- RLS: anyone can SELECT (read-only public cache)
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read exchange rates"
  ON exchange_rates FOR SELECT
  USING (true);

-- ============================================================
-- Reports table (user/listing reports for moderation)
-- ============================================================

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('listing', 'user')),
  target_id UUID NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('counterfeit', 'prohibited', 'misleading', 'inappropriate', 'spam', 'other')),
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for reports
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON reports(reporter_id);

-- ============================================================
-- Reports RLS
-- ============================================================

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- Authenticated users can insert their own reports
CREATE POLICY "Users can insert own reports"
  ON reports FOR INSERT
  WITH CHECK (reporter_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Users can read their own reports
CREATE POLICY "Users can read own reports"
  ON reports FOR SELECT
  USING (reporter_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Admins can read all reports
CREATE POLICY "Admins can read all reports"
  ON reports FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

-- Admins can update reports (for status changes)
CREATE POLICY "Admins can update reports"
  ON reports FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));
