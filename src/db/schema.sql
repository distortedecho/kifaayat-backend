-- Kifaayat Database Schema
-- Run this in Supabase SQL Editor (Dashboard -> SQL Editor -> paste and run)

-- ============================================================
-- Profiles table (extends Clerk user)
-- ============================================================
-- size_preferences JSONB structure:
--   { bust?: string, waist?: string, hip?: string,
--     garment_length?: string, sleeve_length?: string, clothing_size?: string }
--
-- occasion_tags values:
--   Wedding, Mehendi, Sangeet, Festive, Party, Formal, Casual

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  location TEXT CHECK (location IN ('AU', 'US', 'NZ')),
  currency TEXT CHECK (currency IN ('AUD', 'USD', 'NZD')) DEFAULT 'AUD',
  size_preferences JSONB DEFAULT '{}',
  occasion_tags TEXT[] DEFAULT '{}',
  profile_complete BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by clerk_id
CREATE INDEX IF NOT EXISTS idx_profiles_clerk_id ON profiles(clerk_id);

-- ============================================================
-- Auto-update updated_at trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT
  USING (clerk_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (clerk_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Users can insert their own profile
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (clerk_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- Public profiles are readable by anyone
CREATE POLICY "Public profiles are readable"
  ON profiles FOR SELECT
  USING (profile_complete = true);

-- ============================================================
-- Phase 2: Listings & Discovery
-- ============================================================

-- ============================================================
-- Listings table
-- ============================================================
-- measurements JSONB structure varies by category:
--   Lehenga: { bust, waist, length }
--   Saree: { length }
--   Suit/Salwar: { bust, waist, hip, length, sleeve_length }
--   Anarkali: { bust, waist, length }
--   Sharara: { waist, hip, length }
--   Blouse: { bust, waist, length, sleeve_length }
--   Menswear: { chest, waist, length, sleeve_length }
--   Kidswear: { chest, length, age_range }
--   Jewellery, Dupatta, Indowestern, Other: no required measurements
--
-- occasion_tags values:
--   Wedding, Mehendi, Sangeet, Festive, Party, Formal, Casual
--
-- Note on status: Phase 2 skips 'pending_review' — listings go straight
-- from draft to active. The 'pending_review' step will be added in Phase 3
-- when admin panel lands (per CONTEXT.md decision).

CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN (
    'Lehenga', 'Saree', 'Suit/Salwar', 'Anarkali', 'Indowestern',
    'Sharara', 'Jewellery', 'Dupatta', 'Blouse', 'Menswear', 'Kidswear', 'Other'
  )),
  condition TEXT NOT NULL CHECK (condition IN ('New', 'Like New', 'Good', 'Fair', 'Pre-loved', 'New without tags', 'New with tags', 'New with defects')),
  measurements JSONB DEFAULT '{}',
  occasion_tags TEXT[] DEFAULT '{}',
  colors TEXT[] DEFAULT '{}',
  price_amount INTEGER NOT NULL,  -- in cents
  price_currency TEXT NOT NULL CHECK (price_currency IN ('AUD', 'USD', 'NZD')) DEFAULT 'AUD',
  original_price_amount INTEGER,  -- in cents, for showing discount
  negotiable BOOLEAN DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'reserved', 'sold', 'deactivated')),
  shipping_info TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for listings
CREATE INDEX IF NOT EXISTS idx_listings_seller_id ON listings(seller_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_created_at ON listings(created_at DESC);

-- Full-text search index
CREATE INDEX IF NOT EXISTS idx_listings_search ON listings
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(category, '')));

-- Fuzzy search support (for DISC-03 — "lehnga" -> "lehenga")
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index for fuzzy search
CREATE INDEX IF NOT EXISTS idx_listings_title_trgm ON listings USING GIN (title gin_trgm_ops);

-- Auto-update updated_at trigger for listings
CREATE TRIGGER listings_updated_at
  BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Listing Photos table
-- ============================================================

CREATE TABLE IF NOT EXISTS listing_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,  -- Supabase storage path
  url TEXT NOT NULL,           -- Public URL
  position INTEGER NOT NULL DEFAULT 0,  -- For ordering, first = cover
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_photos_listing_id ON listing_photos(listing_id);

-- ============================================================
-- Wishlist Folders table (must be created before wishlists for FK)
-- ============================================================

CREATE TABLE IF NOT EXISTS wishlist_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at trigger for wishlist_folders
CREATE TRIGGER wishlist_folders_updated_at
  BEFORE UPDATE ON wishlist_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Wishlists table
-- ============================================================

CREATE TABLE IF NOT EXISTS wishlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,  -- nullable for guest
  guest_token TEXT,  -- for guest wishlist (UUID stored in device)
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES wishlist_folders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, listing_id),  -- prevent duplicate saves per user
  CHECK (user_id IS NOT NULL OR guest_token IS NOT NULL)  -- must have one identifier
);

CREATE INDEX IF NOT EXISTS idx_wishlists_user_id ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_guest_token ON wishlists(guest_token) WHERE guest_token IS NOT NULL;

-- ============================================================
-- Desi Term Aliases table (for fuzzy desi fashion search)
-- ============================================================

CREATE TABLE IF NOT EXISTS desi_term_aliases (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  canonical TEXT NOT NULL
);

-- Seed with common misspellings/variants
INSERT INTO desi_term_aliases (alias, canonical) VALUES
  ('lehnga', 'lehenga'), ('lehenga', 'lehenga'),
  ('sarre', 'saree'), ('sari', 'saree'), ('saree', 'saree'),
  ('salwar', 'suit/salwar'), ('kameez', 'suit/salwar'), ('churidar', 'suit/salwar'),
  ('anarkali', 'anarkali'), ('anarakali', 'anarkali'),
  ('sharara', 'sharara'), ('sharrara', 'sharara'), ('gharara', 'sharara'),
  ('sherwani', 'menswear'), ('kurta', 'menswear'), ('achkan', 'menswear'),
  ('dupatta', 'dupatta'), ('chunni', 'dupatta'),
  ('jewellery', 'jewellery'), ('jewelry', 'jewellery'), ('jhumka', 'jewellery'), ('jhumki', 'jewellery'),
  ('blouse', 'blouse'), ('choli', 'blouse'),
  ('indowestern', 'indowestern'), ('indo-western', 'indowestern'), ('fusion', 'indowestern')
ON CONFLICT (alias) DO NOTHING;

-- ============================================================
-- Row Level Security (RLS) — Phase 2 tables
-- ============================================================

-- Listings RLS
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- Anyone can read active listings
CREATE POLICY "Anyone can read active listings"
  ON listings FOR SELECT
  USING (status = 'active');

-- Sellers can read their own listings (any status)
CREATE POLICY "Sellers can read own listings"
  ON listings FOR SELECT
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Sellers can insert their own listings
CREATE POLICY "Sellers can insert own listings"
  ON listings FOR INSERT
  WITH CHECK (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Sellers can update their own listings
CREATE POLICY "Sellers can update own listings"
  ON listings FOR UPDATE
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Sellers can delete their own listings
CREATE POLICY "Sellers can delete own listings"
  ON listings FOR DELETE
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Listing Photos RLS
ALTER TABLE listing_photos ENABLE ROW LEVEL SECURITY;

-- Anyone can read photos of active listings
CREATE POLICY "Anyone can read photos of active listings"
  ON listing_photos FOR SELECT
  USING (listing_id IN (SELECT id FROM listings WHERE status = 'active'));

-- Sellers can read photos of their own listings
CREATE POLICY "Sellers can read own listing photos"
  ON listing_photos FOR SELECT
  USING (listing_id IN (
    SELECT id FROM listings WHERE seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  ));

-- Sellers can insert photos for their own listings
CREATE POLICY "Sellers can insert own listing photos"
  ON listing_photos FOR INSERT
  WITH CHECK (listing_id IN (
    SELECT id FROM listings WHERE seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  ));

-- Sellers can delete photos of their own listings
CREATE POLICY "Sellers can delete own listing photos"
  ON listing_photos FOR DELETE
  USING (listing_id IN (
    SELECT id FROM listings WHERE seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  ));

-- Wishlists RLS
ALTER TABLE wishlists ENABLE ROW LEVEL SECURITY;

-- Users can read their own wishlisted items
CREATE POLICY "Users can read own wishlists"
  ON wishlists FOR SELECT
  USING (
    user_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR guest_token IS NOT NULL
  );

-- Users can insert wishlisted items
CREATE POLICY "Users can insert wishlists"
  ON wishlists FOR INSERT
  WITH CHECK (
    user_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR guest_token IS NOT NULL
  );

-- Users can delete their own wishlisted items
CREATE POLICY "Users can delete own wishlists"
  ON wishlists FOR DELETE
  USING (
    user_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR guest_token IS NOT NULL
  );

-- Wishlist Folders RLS
ALTER TABLE wishlist_folders ENABLE ROW LEVEL SECURITY;

-- Users can CRUD their own folders
CREATE POLICY "Users can read own folders"
  ON wishlist_folders FOR SELECT
  USING (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "Users can insert own folders"
  ON wishlist_folders FOR INSERT
  WITH CHECK (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "Users can update own folders"
  ON wishlist_folders FOR UPDATE
  USING (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

CREATE POLICY "Users can delete own folders"
  ON wishlist_folders FOR DELETE
  USING (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Desi Term Aliases — read-only for all (seed data)
ALTER TABLE desi_term_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read desi term aliases"
  ON desi_term_aliases FOR SELECT
  USING (true);

-- ============================================================
-- Phase 3: AI Listing & Seller Setup
-- ============================================================

-- Update listings status CHECK to include pending_review
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status IN ('draft', 'pending_review', 'active', 'reserved', 'sold', 'deactivated'));

-- Add rejection_reason column for admin rejection feedback
ALTER TABLE listings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Add admin flag to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;

-- Add Stripe Connect columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT FALSE;

-- Add OneSignal player ID for push notifications (Phase 4)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS onesignal_player_id TEXT;

-- ============================================================
-- Admin Settings table (commission rate, platform config)
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_rate DECIMAL(5,2) NOT NULL DEFAULT 12.00,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

-- Seed with default commission rate
INSERT INTO admin_settings (commission_rate) VALUES (12.00)
ON CONFLICT DO NOTHING;

-- Auto-update updated_at trigger for admin_settings
CREATE TRIGGER admin_settings_updated_at
  BEFORE UPDATE ON admin_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Phase 3 RLS policies
-- ============================================================

-- Admin Settings RLS — only admins can read/write
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read admin settings"
  ON admin_settings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

CREATE POLICY "Admins can update admin settings"
  ON admin_settings FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

CREATE POLICY "Admins can insert admin settings"
  ON admin_settings FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

-- Admins can read ALL listings (for review queue)
CREATE POLICY "Admins can read all listings"
  ON listings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

-- Admins can update ALL listings (for approve/reject)
CREATE POLICY "Admins can update all listings"
  ON listings FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND is_admin = true
  ));

-- ============================================================
-- Supabase Storage Bucket (Manual Setup)
-- ============================================================
-- MANUAL SETUP REQUIRED: Create storage buckets in Supabase Dashboard
-- Dashboard -> Storage -> New bucket -> Name: "listing-photos", Public: true
-- Dashboard -> Storage -> New bucket -> Name: "listing-videos", Public: true
-- Policy: Authenticated users can upload (INSERT), anyone can read (SELECT)

-- ============================================================
-- Phase 4: Transactions & Offers
-- ============================================================

-- ============================================================
-- Offers table
-- ============================================================

CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,  -- in cents
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD', 'NZD')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'countered', 'expired', 'completed')),
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1 AND round <= 3),
  parent_offer_id UUID REFERENCES offers(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for offers
CREATE INDEX IF NOT EXISTS idx_offers_listing_id ON offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_buyer_id ON offers(buyer_id);
CREATE INDEX IF NOT EXISTS idx_offers_seller_id ON offers(seller_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);

-- Auto-update updated_at trigger for offers
CREATE TRIGGER offers_updated_at
  BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Orders table
-- ============================================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT UNIQUE NOT NULL,  -- format: KIF-YYYYMMDD-XXXX
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id UUID REFERENCES profiles(id) ON DELETE SET NULL,  -- nullable for guest checkout
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  buyer_email TEXT NOT NULL,
  offer_id UUID REFERENCES offers(id) ON DELETE SET NULL,  -- null means direct purchase
  amount INTEGER NOT NULL,  -- in cents
  currency TEXT NOT NULL CHECK (currency IN ('AUD', 'USD', 'NZD')),
  commission_rate NUMERIC(5,2) NOT NULL DEFAULT 12.00,  -- percentage
  commission_amount INTEGER NOT NULL,  -- in cents
  seller_payout INTEGER NOT NULL,  -- in cents
  stripe_payment_intent_id TEXT,
  stripe_checkout_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'shipped', 'delivered', 'complete', 'cancelled')),
  shipping_tracking_number TEXT,
  shipping_carrier TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  auto_complete_at TIMESTAMPTZ,  -- set to NOW() + 7 days when shipped
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for orders
CREATE INDEX IF NOT EXISTS idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller_id ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_listing_id ON orders(listing_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_payment_intent ON orders(stripe_payment_intent_id);
-- Partial index for auto-complete cron query
CREATE INDEX IF NOT EXISTS idx_orders_auto_complete ON orders(auto_complete_at) WHERE status = 'shipped' AND auto_complete_at IS NOT NULL;

-- Auto-update updated_at trigger for orders
CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Notifications table
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'offer_received', 'offer_accepted', 'offer_declined', 'offer_countered', 'offer_expired',
    'order_paid', 'order_shipped', 'order_delivered', 'order_complete',
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
    'listing_comment'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}',  -- stores reference IDs: listing_id, offer_id, order_id for deep linking
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- ============================================================
-- Phase 4 RLS policies
-- ============================================================

-- Offers RLS
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;

-- Buyers can read their own offers
CREATE POLICY "Buyers can read own offers"
  ON offers FOR SELECT
  USING (buyer_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Sellers can read offers on their listings
CREATE POLICY "Sellers can read offers on their listings"
  ON offers FOR SELECT
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Buyers can insert offers
CREATE POLICY "Buyers can insert offers"
  ON offers FOR INSERT
  WITH CHECK (buyer_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Buyers and sellers can update offers (for accept/decline/counter)
CREATE POLICY "Participants can update offers"
  ON offers FOR UPDATE
  USING (
    buyer_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Orders RLS
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Buyers can read their own orders
CREATE POLICY "Buyers can read own orders"
  ON orders FOR SELECT
  USING (buyer_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Sellers can read orders for their listings
CREATE POLICY "Sellers can read own sales"
  ON orders FOR SELECT
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Buyers can insert orders (for checkout)
CREATE POLICY "Buyers can insert orders"
  ON orders FOR INSERT
  WITH CHECK (
    buyer_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR buyer_id IS NULL  -- allow guest checkout (buyer_id is null)
  );

-- Sellers can update orders (for shipping)
CREATE POLICY "Sellers can update orders"
  ON orders FOR UPDATE
  USING (seller_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Buyers can update orders (for delivery confirmation)
CREATE POLICY "Buyers can update own orders"
  ON orders FOR UPDATE
  USING (buyer_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Notifications RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can read their own notifications
CREATE POLICY "Users can read own notifications"
  ON notifications FOR SELECT
  USING (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Users can update their own notifications (mark as read)
CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  USING (user_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- ============================================================
-- Phase 5: Messaging
-- ============================================================

-- ============================================================
-- Conversations table (one thread per buyer-seller-listing triple)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  seller_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_preview TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(listing_id, buyer_id, seller_id)
);

-- Indexes for conversations
CREATE INDEX IF NOT EXISTS idx_conversations_buyer_id ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_seller_id ON conversations(seller_id);
CREATE INDEX IF NOT EXISTS idx_conversations_listing_id ON conversations(listing_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);

-- Auto-update updated_at trigger for conversations
CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- Messages table
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) > 0 AND char_length(content) <= 2000),
  read_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for messages
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_created_at ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

-- ============================================================
-- Enable Supabase Realtime on messages table
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- ============================================================
-- Phase 5 RLS policies
-- ============================================================

-- Conversations RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Participants can read their conversations
CREATE POLICY "Participants can read conversations"
  ON conversations FOR SELECT
  USING (
    buyer_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Buyers can create conversations (buyer_id must match their profile)
CREATE POLICY "Buyers can create conversations"
  ON conversations FOR INSERT
  WITH CHECK (buyer_id IN (
    SELECT id FROM profiles
    WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
  ));

-- Messages RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Participants of the conversation can read messages
CREATE POLICY "Participants can read messages"
  ON messages FOR SELECT
  USING (conversation_id IN (
    SELECT id FROM conversations
    WHERE buyer_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  ));

-- Participants of the conversation can send messages (sender_id must match their profile)
CREATE POLICY "Participants can send messages"
  ON messages FOR INSERT
  WITH CHECK (
    sender_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    AND conversation_id IN (
      SELECT id FROM conversations
      WHERE buyer_id IN (
        SELECT id FROM profiles
        WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
      )
      OR seller_id IN (
        SELECT id FROM profiles
        WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
      )
    )
  );

-- Participants can update messages (for marking as read)
CREATE POLICY "Participants can update messages"
  ON messages FOR UPDATE
  USING (conversation_id IN (
    SELECT id FROM conversations
    WHERE buyer_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
    OR seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  ));

-- ============================================================
-- Phase 9: Admin Panel — User Moderation Columns
-- ============================================================

-- Add moderation columns to profiles for suspend/ban functionality
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ban_reason TEXT;

-- Admin RLS policy for reading ALL profiles (user management)
CREATE POLICY "Admins can read all profiles"
  ON profiles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND p.is_admin = true
  ));

-- Admin RLS policy for updating ALL profiles (suspend/ban actions)
CREATE POLICY "Admins can update all profiles"
  ON profiles FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    AND p.is_admin = true
  ));
