-- ============================================================
-- Schema Migration 09 — Sharetribe legacy import support
-- ============================================================
-- Adds columns, indexes, and tables needed to import the existing
-- Sharetribe-based Kifaayat data into this Supabase backend.
--
-- Strategy:
--   - profiles.clerk_id becomes nullable so we can pre-create
--     profiles for legacy users before they sign up via Clerk
--   - Email is stored explicitly so we can match-on-signup
--   - Every entity carries the original Sharetribe UUID in
--     legacy_sharetribe_id so the importer is idempotent (re-run
--     safely) and admin can correlate back to old support tickets
--   - legacy_numeric_id preserves the pre-Sharetribe sequential IDs
--     for users who emailed support quoting "I am user 1900057"
--   - legacy_inquiries archives the 946 pre-transaction chat threads
--     that the new app deliberately doesn't support (private
--     messaging is post-order-only to prevent offline-deal evasion).
--     Visible only to admins / helpdesk.
--
-- Run order: schema.sql → ... → schema-08.sql → schema-09.sql
-- All statements use IF NOT EXISTS / IF EXISTS so re-running is safe.
-- See MIGRATION.md for the full migration plan.
-- ============================================================


-- -------------------------
-- notifications: add 'welcome_back' type for Sharetribe-claim flow
-- -------------------------
-- Fired once when a returning user signs up via Clerk and we claim
-- their pre-migrated profile. Lets them land in the app with a
-- single notification instead of an empty inbox.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'offer_received', 'offer_accepted', 'offer_declined', 'offer_countered', 'offer_expired',
  'order_paid', 'order_accepted', 'order_rejected', 'order_shipped', 'order_delivered', 'order_complete',
  'listing_approved', 'listing_rejected',
  'review_reminder', 'review_revealed',
  'tier_upgrade', 'tier_downgrade',
  'boost_activated', 'boost_expiring',
  'sale_applied', 'referral_credit_earned',
  'iso_match', 'iso_response',
  'new_message', 'price_drop_wishlist',
  'new_matching_listing', 'new_listing_your_size',
  'listing_stale_reminder', 'milestone_achieved',
  'weekly_digest', 'referral_nudge',
  're_engagement', 'account_suspended',
  'followed_seller_new_listing',
  'listing_comment',
  'comment_reply',
  'welcome_back'
));


-- -------------------------
-- currency constraints: widen across the board to include CAD + GBP
-- -------------------------
-- Schema originally allowed only AUD / USD / NZD for currency-bearing
-- columns. Sharetribe data has CAD + GBP too (~2,500 listings, plus
-- a handful of historic transactions), and schema-08 already added
-- those values to the Wise payout currency list — so the platform is
-- prepared. Widening the check constraints to match.

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_price_currency_check;
ALTER TABLE listings ADD CONSTRAINT listings_price_currency_check
  CHECK (price_currency IN ('AUD', 'USD', 'NZD', 'CAD', 'GBP'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_currency_check;
ALTER TABLE orders ADD CONSTRAINT orders_currency_check
  CHECK (currency IN ('AUD', 'USD', 'NZD', 'CAD', 'GBP'));

ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_currency_check;
ALTER TABLE offers ADD CONSTRAINT offers_currency_check
  CHECK (currency IN ('AUD', 'USD', 'NZD', 'CAD', 'GBP'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_currency_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_currency_check
  CHECK (currency IS NULL OR currency IN ('AUD', 'USD', 'NZD', 'CAD', 'GBP'));


-- -------------------------
-- listings: widen category check to include 'Footwear'
-- -------------------------
-- 82 Sharetribe footwear listings map to this; the original check
-- didn't include it. Easier to widen the constraint than collapse
-- 82 listings into "Other" and lose the categorisation.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_category_check;
ALTER TABLE listings ADD CONSTRAINT listings_category_check
  CHECK (category IN (
    'Lehenga', 'Saree', 'Suit/Salwar', 'Anarkali', 'Indowestern',
    'Sharara', 'Jewellery', 'Dupatta', 'Blouse', 'Menswear', 'Kidswear',
    'Footwear', 'Other'
  ));

-- -------------------------
-- profiles: widen location check to include CA + UK
-- -------------------------
-- The original constraint was ('AU', 'US', 'NZ') only. Markets CA + UK
-- were added in app code but the DB constraint was never widened. The
-- importer (and runtime profile updates) need these values to land.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_location_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_location_check
  CHECK (location IS NULL OR location IN ('AU', 'US', 'NZ', 'CA', 'UK'));

-- -------------------------
-- profiles: legacy import columns
-- -------------------------

-- clerk_id must be nullable so we can pre-create profile rows for
-- legacy users before they sign up to Clerk on the new app. Real
-- uniqueness is enforced via a partial UNIQUE INDEX so multiple
-- rows can carry NULL while every actual Clerk ID is still unique.
ALTER TABLE profiles ALTER COLUMN clerk_id DROP NOT NULL;

-- Email — the join key for "user signs up via Clerk, we match them
-- against the pre-created legacy profile". Stored lower-case at the
-- application layer for case-insensitive lookups.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;

-- Legacy identifiers preserved for support / audit / idempotency.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS legacy_sharetribe_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS legacy_numeric_id TEXT;

-- Buyer "Looking For" preferences from Sharetribe's iso* fields.
-- Stored as user preferences (used to personalise recommendations);
-- we do NOT auto-create ISO posts from these per client decision.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS looking_for_categories TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS usual_sizes TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS buy_preferences TEXT[];
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS budget_ceiling INTEGER;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_notes TEXT;

-- Stripe customer ID for the 49 historic buyers who completed purchases
-- on Sharetribe. Preserves the Stripe-side correlation if we ever need
-- to look up or refund a historic order through Stripe dashboard.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Terms acceptance — preserved from Sharetribe's protectedData.terms
-- field (15,513 users had it). Soft compliance signal so we don't
-- re-prompt them on first signin.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Replace the original (presumed) unique constraint on clerk_id with
-- a partial unique index so NULLs are allowed for legacy rows.
-- The named constraint may or may not exist depending on schema
-- history — both DROPs are safe no-ops if absent.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_clerk_id_key;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_clerk_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_clerk_id_unique
  ON profiles(clerk_id) WHERE clerk_id IS NOT NULL;

-- Email lookup index — used on every Clerk signup to find any
-- pre-existing legacy profile to merge into.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email_unique
  ON profiles(LOWER(email)) WHERE email IS NOT NULL;

-- Legacy ID lookups — used by the importer for idempotency and by
-- admin/helpdesk for "find me user 1900057".
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_legacy_sharetribe_id_unique
  ON profiles(legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_legacy_numeric_id
  ON profiles(legacy_numeric_id) WHERE legacy_numeric_id IS NOT NULL;


-- -------------------------
-- listings: legacy import columns
-- -------------------------

ALTER TABLE listings ADD COLUMN IF NOT EXISTS legacy_sharetribe_id TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS legacy_numeric_id TEXT;

-- Preserves Sharetribe's old `productTypeOptional` field, which carried
-- values like 'wedding', 'bridal', 'groomswear', 'vintagePre2000'. The
-- new app doesn't expose this field in the listing form today; per
-- client (Q13) we keep the data here in case they want to revive it.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS legacy_product_type TEXT[];

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_legacy_sharetribe_id_unique
  ON listings(legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_legacy_numeric_id
  ON listings(legacy_numeric_id) WHERE legacy_numeric_id IS NOT NULL;


-- -------------------------
-- orders: legacy import columns
-- -------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS legacy_sharetribe_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_legacy_sharetribe_id_unique
  ON orders(legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL;


-- -------------------------
-- reviews: legacy import column (for idempotency)
-- -------------------------
-- Reviews table has no natural unique key — without this, re-running
-- the importer would duplicate the 56 historic reviews. Add the same
-- pattern as other entities.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS legacy_sharetribe_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_legacy_sharetribe_id_unique
  ON reviews(legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL;


-- -------------------------
-- legacy_inquiries — archived pre-transaction chat threads
-- -------------------------
-- 946 of 1,026 Sharetribe transactions were pure inquiries
-- (transition/inquire) with no payment. The new app deliberately
-- doesn't support pre-transaction chat (prevents offline-deal
-- evasion of commission). We archive these threads admin-only so
-- helpdesk can look them up if a user asks "what did so-and-so
-- say to me last year".

CREATE TABLE IF NOT EXISTS legacy_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_sharetribe_id TEXT NOT NULL UNIQUE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  buyer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  seller_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Email fallbacks for when the buyer/seller wasn't migrated
  -- (zero-signal accounts won't have a profile row)
  buyer_email TEXT,
  seller_email TEXT,
  -- Full message thread preserved as JSONB:
  --   [{ id, created_at, content, sender_email, sender_legacy_id }, ...]
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_transitioned_at TIMESTAMPTZ,
  legacy_created_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legacy_inquiries_buyer_id
  ON legacy_inquiries(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_inquiries_seller_id
  ON legacy_inquiries(seller_id) WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_inquiries_listing_id
  ON legacy_inquiries(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_inquiries_buyer_email
  ON legacy_inquiries(LOWER(buyer_email)) WHERE buyer_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_legacy_inquiries_seller_email
  ON legacy_inquiries(LOWER(seller_email)) WHERE seller_email IS NOT NULL;

ALTER TABLE legacy_inquiries ENABLE ROW LEVEL SECURITY;
GRANT ALL ON legacy_inquiries TO service_role;
-- No grant to authenticated — admin/helpdesk only via service role.
