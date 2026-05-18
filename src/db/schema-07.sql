-- ============================================================
-- Schema Sync — Live DB → Local Files
-- ============================================================
-- Captures everything added directly in the Supabase dashboard
-- and never committed to schema files.
-- Discovered via API introspection on 2026-05-17.
--
-- Run order: schema.sql → schema-06.sql → schema-07.sql
-- All statements use IF NOT EXISTS so re-running is safe.
-- ============================================================


-- ============================================================
-- SECTION 1 — Extra columns on existing tables
-- ============================================================

-- -------------------------
-- listings
-- -------------------------

ALTER TABLE listings ADD COLUMN IF NOT EXISTS designer_name TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_known_designer BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS designer_verification_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS country_of_origin TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS dry_cleaning_status TEXT
  CHECK (dry_cleaning_status IN (
    'Dry-cleaned less than 1 month ago',
    'Dry-cleaned over 1 month ago',
    'Pre-loved and not dry cleaned',
    'New, therefore not dry cleaned'
  ));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS alteration_room TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fit_tips TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS fabric_types TEXT[] DEFAULT '{}';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS work_types TEXT[] DEFAULT '{}';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS items_included TEXT[] DEFAULT '{}';
-- NOTE: Sharetribe has THREE separate size fields (size_women, size_kids_mens,
-- size_footwear). Collapsed into two columns here. Needs proper three-column
-- approach before Sharetribe data migration can run.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS estimated_size TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS size_type TEXT CHECK (size_type IN ('womens', 'mens_kids', 'footwear'));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS video_storage_path TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS shipping_cost_amount INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS free_shipping BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS pickup_available BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS international_shipping BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS save_count INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS inquiry_count INTEGER DEFAULT 0;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS sale_percentage INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS risk_score NUMERIC(5,2);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS risk_scored_at TIMESTAMPTZ;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS curation_tags TEXT[] DEFAULT '{}';
-- Rental columns: feature removed from backend code but columns remain in DB.
-- Do not use in new code.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_rentable BOOLEAN DEFAULT FALSE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_daily_rate INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_4to7_rate INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_8to14_rate INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_cleaning_fee INTEGER;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rental_security_deposit INTEGER;

CREATE INDEX IF NOT EXISTS idx_listings_view_count ON listings(view_count DESC);
CREATE INDEX IF NOT EXISTS idx_listings_save_count ON listings(save_count DESC);
CREATE INDEX IF NOT EXISTS idx_listings_curation_tags ON listings USING GIN(curation_tags);
CREATE INDEX IF NOT EXISTS idx_listings_risk_score ON listings(risk_score) WHERE risk_score IS NOT NULL;

-- -------------------------
-- profiles
-- -------------------------

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trust_tier INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trust_tier_override INTEGER;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS user_intents TEXT[] DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wishlist_public BOOLEAN DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS payout_method TEXT;

-- -------------------------
-- orders
-- -------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount INTEGER;

-- -------------------------
-- messages
-- -------------------------

ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'
  CHECK (message_type IN ('text', 'image', 'photo_request', 'payment_link'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Allow image-only messages (no content required when message_type != text)
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_check;
ALTER TABLE messages ADD CONSTRAINT messages_content_check
  CHECK (
    (message_type = 'text' AND content IS NOT NULL AND char_length(content) > 0 AND char_length(content) <= 2000)
    OR (message_type != 'text')
  );


-- ============================================================
-- SECTION 2 — Tables built in live DB but missing from files
-- ============================================================

-- -------------------------
-- reviews
-- -------------------------

CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  reviewer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reviewee_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  reviewer_role TEXT NOT NULL CHECK (reviewer_role IN ('buyer', 'seller')),
  visible BOOLEAN DEFAULT FALSE,
  revealed_at TIMESTAMPTZ,
  seller_reply TEXT,
  seller_reply_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_id ON reviews(reviewee_id);
CREATE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews(order_id);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read visible reviews"
  ON reviews FOR SELECT USING (visible = true);

CREATE POLICY "Users can read own reviews"
  ON reviews FOR SELECT
  USING (
    reviewer_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub')
    OR reviewee_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub')
  );

CREATE POLICY "Buyers and sellers can insert reviews"
  ON reviews FOR INSERT
  WITH CHECK (reviewer_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

CREATE POLICY "Reviewers can update own reviews"
  ON reviews FOR UPDATE
  USING (reviewer_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- listing_comments
-- -------------------------

CREATE TABLE IF NOT EXISTS listing_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_comments_listing_id ON listing_comments(listing_id);

ALTER TABLE listing_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read listing comments"
  ON listing_comments FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert comments"
  ON listing_comments FOR INSERT
  WITH CHECK (author_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- seller_follows
-- -------------------------

CREATE TABLE IF NOT EXISTS seller_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(follower_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_follows_follower_id ON seller_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_seller_follows_seller_id ON seller_follows(seller_id);

ALTER TABLE seller_follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read seller follows"
  ON seller_follows FOR SELECT USING (true);

CREATE POLICY "Users can follow sellers"
  ON seller_follows FOR INSERT
  WITH CHECK (follower_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

CREATE POLICY "Users can unfollow sellers"
  ON seller_follows FOR DELETE
  USING (follower_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- cart_items
-- -------------------------

CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_user_id ON cart_items(user_id);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own cart"
  ON cart_items FOR ALL
  USING (user_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- listing_boosts
-- -------------------------

CREATE TABLE IF NOT EXISTS listing_boosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_payment_intent_id TEXT,
  amount_paid INTEGER NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_boosts_listing_id ON listing_boosts(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_boosts_seller_id ON listing_boosts(seller_id);
CREATE INDEX IF NOT EXISTS idx_listing_boosts_ends_at ON listing_boosts(ends_at) WHERE status = 'active';

ALTER TABLE listing_boosts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sellers can read own boosts"
  ON listing_boosts FOR SELECT
  USING (seller_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- boost_pricing_tiers
-- -------------------------

CREATE TABLE IF NOT EXISTS boost_pricing_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  duration_days INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  display_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE boost_pricing_tiers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read boost pricing"
  ON boost_pricing_tiers FOR SELECT USING (is_active = true);

-- -------------------------
-- editorial_tags + listing_editorial_tags
-- (replaces Sharetribe kifaayatonly JSON field as proper relational tables)
-- -------------------------

CREATE TABLE IF NOT EXISTS editorial_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listing_editorial_tags (
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES editorial_tags(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (listing_id, tag_id)
);

ALTER TABLE editorial_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_editorial_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read editorial tags"
  ON editorial_tags FOR SELECT USING (is_active = true);

CREATE POLICY "Anyone can read listing editorial tags"
  ON listing_editorial_tags FOR SELECT USING (true);

-- -------------------------
-- categories (reference table for UI navigation)
-- -------------------------

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  icon_url TEXT,
  display_order INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read categories"
  ON categories FOR SELECT USING (is_active = true);

-- -------------------------
-- iso_posts (In Search Of)
-- -------------------------

CREATE TABLE IF NOT EXISTS iso_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  size TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fulfilled', 'closed')),
  market TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iso_posts_author_id ON iso_posts(author_id);
CREATE INDEX IF NOT EXISTS idx_iso_posts_status ON iso_posts(status);

ALTER TABLE iso_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read active iso posts"
  ON iso_posts FOR SELECT USING (status = 'active');

CREATE POLICY "Authors can manage own iso posts"
  ON iso_posts FOR ALL
  USING (author_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- iso_comments
-- -------------------------

CREATE TABLE IF NOT EXISTS iso_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_post_id UUID NOT NULL REFERENCES iso_posts(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iso_comments_iso_post_id ON iso_comments(iso_post_id);

ALTER TABLE iso_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read iso comments"
  ON iso_comments FOR SELECT USING (true);

CREATE POLICY "Authenticated users can insert iso comments"
  ON iso_comments FOR INSERT
  WITH CHECK (author_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- iso_matches
-- -------------------------

CREATE TABLE IF NOT EXISTS iso_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_post_id UUID NOT NULL REFERENCES iso_posts(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  match_score NUMERIC(5,2),
  match_reasons JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE iso_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read iso matches"
  ON iso_matches FOR SELECT USING (true);

-- -------------------------
-- iso_responses
-- -------------------------

CREATE TABLE IF NOT EXISTS iso_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_post_id UUID NOT NULL REFERENCES iso_posts(id) ON DELETE CASCADE,
  responder_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  message TEXT,
  special_price INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE iso_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read iso responses"
  ON iso_responses FOR SELECT USING (true);

CREATE POLICY "Sellers can insert iso responses"
  ON iso_responses FOR INSERT
  WITH CHECK (responder_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- fraud_flags
-- -------------------------

CREATE TABLE IF NOT EXISTS fraud_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('listing', 'user', 'order')),
  entity_id UUID NOT NULL,
  flag_type TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fraud_flags_entity ON fraud_flags(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fraud_flags_status ON fraud_flags(status);

ALTER TABLE fraud_flags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage fraud flags"
  ON fraud_flags FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub' AND is_admin = true));

-- -------------------------
-- notification_preferences
-- -------------------------

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  push_enabled BOOLEAN DEFAULT TRUE,
  email_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user_id ON notification_preferences(user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own notification preferences"
  ON notification_preferences FOR ALL
  USING (user_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- notification_type_config
-- -------------------------

CREATE TABLE IF NOT EXISTS notification_type_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  type_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  push_enabled BOOLEAN DEFAULT TRUE,
  email_enabled BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_type_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read notification type config"
  ON notification_type_config FOR SELECT USING (true);

-- -------------------------
-- referral_codes
-- -------------------------

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  disabled BOOLEAN DEFAULT FALSE,
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user_id ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);

ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own referral codes"
  ON referral_codes FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- referrals
-- -------------------------

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referral_code_id UUID REFERENCES referral_codes(id) ON DELETE SET NULL,
  qualifying_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'rewarded', 'expired')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  qualified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own referrals"
  ON referrals FOR SELECT
  USING (
    referrer_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub')
    OR referred_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub')
  );

-- -------------------------
-- referral_credits
-- -------------------------

CREATE TABLE IF NOT EXISTS referral_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referral_code_id UUID REFERENCES referral_codes(id) ON DELETE SET NULL,
  referral_id UUID REFERENCES referrals(id) ON DELETE SET NULL,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  redeemed_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'redeemed', 'expired')),
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_credits_user_id ON referral_credits(user_id);

ALTER TABLE referral_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own referral credits"
  ON referral_credits FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));

-- -------------------------
-- search_queries (analytics)
-- -------------------------

CREATE TABLE IF NOT EXISTS search_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term TEXT NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  filters JSONB DEFAULT '{}',
  result_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_queries_created_at ON search_queries(created_at DESC);

ALTER TABLE search_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read search queries"
  ON search_queries FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub' AND is_admin = true));

-- -------------------------
-- Rental tables (feature removed — kept for DB accuracy only)
-- -------------------------

CREATE TABLE IF NOT EXISTS rental_blackouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rental_blackouts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rental_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  renter_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  daily_rate INTEGER,
  total_rental_amount INTEGER,
  cleaning_fee INTEGER,
  security_deposit INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id TEXT,
  stripe_deposit_payment_intent_id TEXT,
  stripe_setup_intent_id TEXT,
  stripe_payment_method_id TEXT,
  deposit_released BOOLEAN DEFAULT FALSE,
  shipping_tracking_number TEXT,
  return_tracking_number TEXT,
  damage_claim_description TEXT,
  damage_claim_photos JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rental_bookings ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION 3 — Outstanding gaps for Sharetribe data migration
-- ============================================================
-- These must be resolved before migration scripts can run.
-- They are NOT needed for the app to function — only for moving
-- historical Sharetribe data into this DB.
-- ============================================================

-- -------------------------------------------------------------
-- 3A — Columns to ADD (run these when ready to migrate)
-- -------------------------------------------------------------

-- listings:
--
--   ADD COLUMN item_market TEXT
--     CHECK (item_market IN ('australia','newzealand','united-states','canada','united-kingdom'));
--     (Sharetribe field: countrylist — which market the item is listed in)
--
--   ADD COLUMN legacy_sharetribe_id TEXT UNIQUE;
--     (Sharetribe's original listing UUID — makes migration re-runnable/auditable)
--
--   ADD COLUMN deleted BOOLEAN DEFAULT FALSE;
--     (Sharetribe soft-deletes; hard CASCADE in current schema breaks GDPR pattern)

-- profiles:
--
--   ADD COLUMN legacy_sharetribe_id TEXT UNIQUE;
--   ADD COLUMN deleted BOOLEAN DEFAULT FALSE;
--   ADD COLUMN bio TEXT;
--   ADD COLUMN phone_number TEXT;          -- must be TEXT not number (leading zeros)
--   ADD COLUMN consent_mobile_contact BOOLEAN DEFAULT FALSE;
--   ADD COLUMN looking_for_categories TEXT[];   -- Sharetribe: isotype (MISNAMED)
--   ADD COLUMN budget_ceiling INTEGER;          -- Sharetribe: isobudget (MISNAMED)
--   ADD COLUMN buy_preferences TEXT[];          -- Sharetribe: isocountry (MISNAMED)
--   ADD COLUMN usual_sizes TEXT[];              -- Sharetribe: isosize (values: 'uk4','uk6'...)
--   ADD COLUMN search_notes TEXT;              -- Sharetribe: isopersonalised
--   ADD COLUMN stripe_connect_verified BOOLEAN DEFAULT FALSE;  -- distinct from stripe_onboarding_complete
--   ADD COLUMN terms_accepted BOOLEAN DEFAULT FALSE;
--   ADD COLUMN terms_accepted_at TIMESTAMPTZ;
--   ADD COLUMN terms_version TEXT;
--
--   ALTER location CHECK to add 'CA' and 'UK':
--   ALTER TABLE profiles DROP CONSTRAINT profiles_location_check;
--   ALTER TABLE profiles ADD CONSTRAINT profiles_location_check
--     CHECK (location IN ('AU', 'US', 'NZ', 'CA', 'UK'));

-- orders / reviews:
--
--   ADD COLUMN legacy_sharetribe_id TEXT UNIQUE on both tables.

-- -------------------------------------------------------------
-- 3B — Enum value fix required (BLOCKER — must fix before migration)
-- -------------------------------------------------------------
--
-- listings.condition currently accepts: 'New','Like New','Good','Fair'
-- Sharetribe stores:                    'preOwned','newWithoutTags','newWithTags','newWithDefects'
--
-- Fix (only safe to run if no live user data depends on old values,
-- or after a data transform updating existing rows):
--
--   UPDATE listings SET condition = CASE condition
--     WHEN 'New'      THEN 'newWithTags'
--     WHEN 'Like New' THEN 'preOwned'
--     WHEN 'Good'     THEN 'preOwned'
--     WHEN 'Fair'     THEN 'newWithDefects'
--     ELSE condition END;
--
--   ALTER TABLE listings DROP CONSTRAINT listings_condition_check;
--   ALTER TABLE listings ADD CONSTRAINT listings_condition_check
--     CHECK (condition IN ('preOwned','newWithoutTags','newWithTags','newWithDefects'));

-- -------------------------------------------------------------
-- 3C — Type mismatches to resolve
-- -------------------------------------------------------------
--
-- listings.colors is TEXT[] (multi-select array).
-- Sharetribe 'colour' is single-select from 20 specific values:
--   black, grey, white, brown, tan, cream, yellow, red, burgundy,
--   orange, pink, purple, blue, navy, green, khaki, multi, silver, gold, other
-- Decision needed: keep multi-select (new app behaviour) and store
-- migrated data as single-element array, OR rename to 'color' TEXT and
-- add a separate 'secondary_colors TEXT[]' column.
--
-- listings.occasion_tags stored values MISMATCH:
-- Live DB stores display strings: 'Wedding','Mehendi','Sangeet','Festive','Party','Formal','Casual'
-- Sharetribe stores slugs: 'bridal','casual','festive','groom','prewedding',
--                          'preweddingguest','weddingparty','weddingguest'
-- The option SETS are also different (Sharetribe has 8 options, app has 7 different ones).
-- Migration needs an explicit mapping table between the two sets.
--
-- listings size fields: Sharetribe THREE fields vs collapsed estimated_size/size_type here.
-- For full fidelity, add:
--   ADD COLUMN size_women TEXT;       -- Sharetribe stored values: '4','6','8'...'28','freeSize'
--   ADD COLUMN size_kids_mens TEXT;   -- Sharetribe stored values: 'xxs','xs','small'...'4xl','freeSize'
--   ADD COLUMN size_footwear TEXT;    -- Sharetribe stored values: '4','5'...'14'
-- and populate from Sharetribe export, then derive estimated_size/size_type from them.
--
-- listings.designer_name (TEXT) vs Sharetribe's two fields:
--   designerID: dropdown with 31 specific stored IDs (abhinavmishra, anita-dogre, etc.)
--   designer: free-text fallback for unlisted designers
-- For migration fidelity, consider adding:
--   ADD COLUMN designer_id TEXT;       -- stores the Sharetribe dropdown ID verbatim
--   (keep designer_name for the resolved display name or free-text value)

-- -------------------------------------------------------------
-- 3D — Child tables not yet built (needed for historical data)
-- -------------------------------------------------------------
--
-- listing_likes: replaces Sharetribe metadata.likedByUserIds JSON array
--   id, listing_id (FK), user_id (FK), created_at, UNIQUE(listing_id, user_id)
--
-- listing_shares: replaces Sharetribe metadata.shareBy JSON array
--   id, listing_id (FK), user_id (FK), created_at
--
-- transaction_transitions: Sharetribe state machine history
--   id, order_id (FK), transition_name, actor, created_at, params (JSONB)
--
-- transaction_line_items: Sharetribe lineItems
--   id, order_id (FK), code, unit_price, quantity, percentage, line_total,
--   reversal (bool), include_for
--
-- events / audit_log: Sharetribe provided this for free — must build fresh.
--   id, sequence_id, event_type, resource_type, resource_id, source,
--   actor_id, created_at, resource_snapshot (JSONB), previous_values (JSONB)
--   NOTE: Sharetribe audit history older than 90 days is already gone.
