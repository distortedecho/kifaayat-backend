-- ============================================================
-- Schema Migration 33 — content suite (Phase 5)
-- ============================================================
-- Screens 16–19: push copy, lifecycle email templates, website/help pages,
-- and the blog. Email templates + website pages are versioned (rollback);
-- push + blog use status + the audit log for history.
--
-- Run order: … → schema-32.sql → schema-33.sql
-- ============================================================

-- ---- Push campaigns (Screen 16) ----
CREATE TABLE IF NOT EXISTS push_campaigns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  deep_link     TEXT,
  audience      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { market?, segment? }
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sent')),
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  onesignal_id  TEXT,
  created_by    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- Email templates (Screen 17) + versions ----
CREATE TABLE IF NOT EXISTS email_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT UNIQUE NOT NULL,          -- e.g. 'order_shipped', 'welcome'
  subject     TEXT NOT NULL,
  heading     TEXT,
  body        TEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_by  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS email_template_versions (
  id          BIGSERIAL PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES email_templates(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  subject     TEXT NOT NULL,
  heading     TEXT,
  body        TEXT NOT NULL,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_tpl_versions ON email_template_versions (template_id, version DESC);

-- ---- Website / help pages (Screen 18) + versions ----
CREATE TABLE IF NOT EXISTS website_pages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  body_md          TEXT NOT NULL DEFAULT '',
  seo_title        TEXT,
  seo_description  TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version          INT NOT NULL DEFAULT 1,
  published_at     TIMESTAMPTZ,
  updated_by       UUID,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS website_page_versions (
  id         BIGSERIAL PRIMARY KEY,
  page_id    UUID NOT NULL REFERENCES website_pages(id) ON DELETE CASCADE,
  version    INT NOT NULL,
  title      TEXT NOT NULL,
  body_md    TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_page_versions ON website_page_versions (page_id, version DESC);

-- ---- Blog (Screen 19) ----
CREATE TABLE IF NOT EXISTS blog_posts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT UNIQUE NOT NULL,
  title          TEXT NOT NULL,
  body_md        TEXT NOT NULL DEFAULT '',
  cover_image_url TEXT,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published')),
  scheduled_at   TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin-only tables: enable RLS with NO anon/authenticated policy so the
-- default-deny blocks public keys. The backend uses the service role, which
-- bypasses RLS entirely, so these stay fully readable/writable server-side.
ALTER TABLE push_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_page_versions ENABLE ROW LEVEL SECURITY;

-- Public read for published website copy + blog (served to the website).
ALTER TABLE website_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public reads published pages" ON website_pages;
CREATE POLICY "public reads published pages" ON website_pages FOR SELECT USING (status = 'published');
DROP POLICY IF EXISTS "public reads published posts" ON blog_posts;
CREATE POLICY "public reads published posts" ON blog_posts FOR SELECT USING (status = 'published');
GRANT SELECT ON website_pages, blog_posts TO anon, authenticated;
GRANT ALL ON push_campaigns, email_templates, email_template_versions, website_pages, website_page_versions, blog_posts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE email_template_versions_id_seq, website_page_versions_id_seq TO service_role;
