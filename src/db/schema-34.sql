-- ============================================================
-- Schema Migration 34 — listing_updated notification type
-- ============================================================
-- Admin listing edits notify the seller (Screen 05: "the reason is sent to
-- them"). Extend the notifications type CHECK with 'listing_updated'.
-- The list below is the EXACT live constraint + the one new value, so no
-- existing type is dropped.
--
-- Run order: … → schema-33.sql → schema-34.sql
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (ARRAY[
  'offer_received', 'offer_accepted', 'offer_declined', 'offer_countered', 'offer_expired',
  'order_paid', 'order_accepted', 'order_rejected', 'order_shipped', 'order_delivered', 'order_complete',
  'listing_approved', 'listing_rejected', 'listing_updated',
  'review_reminder', 'review_revealed',
  'tier_upgrade', 'tier_downgrade',
  'boost_activated', 'boost_expiring',
  'sale_applied', 'referral_credit_earned',
  'iso_match', 'iso_response',
  'new_message', 'price_drop_wishlist', 'new_matching_listing', 'new_listing_your_size',
  'listing_stale_reminder', 'milestone_achieved', 'weekly_digest', 'referral_nudge', 're_engagement',
  'account_suspended', 'followed_seller_new_listing',
  'listing_comment', 'comment_reply', 'welcome_back'
]::text[]));
