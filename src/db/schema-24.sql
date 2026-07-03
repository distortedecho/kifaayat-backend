-- ============================================================
-- Schema Migration 24 — designers reference table (typeahead)
-- ============================================================
-- The canonical designer list (client's "Column C") is ~5.5k names — too
-- many for a bundled dropdown. Instead we store them in a `designers`
-- table and the app hits GET /api/designers?q=… as the seller types
-- (after ~3 chars) for a typeahead. Seeded from the cleanup CSV via
-- scripts/seed-designers.ts.
--
-- origin (Indian / Pakistani / null) mirrors listings.designer_origin so
-- picking a brand can also stamp its origin on new listings later.
--
-- Run order: ... → schema-23.sql → schema-24.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS designers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  origin TEXT CHECK (origin IS NULL OR origin IN ('Indian', 'Pakistani')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive lookups for the typeahead (prefix + substring).
CREATE INDEX IF NOT EXISTS idx_designers_name_lower ON designers (LOWER(name));

-- Public read (taxonomy isn't secret); writes are service-role only.
ALTER TABLE designers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read designers" ON designers;
CREATE POLICY "Anyone can read designers" ON designers FOR SELECT USING (true);
GRANT SELECT ON designers TO anon, authenticated;
GRANT ALL ON designers TO service_role;
