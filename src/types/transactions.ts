// ============================================================
// Phase 4: Transactions & Offers — Shared Types
// ============================================================

// Offer status enum
export const OFFER_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "countered",
  "expired",
  "completed",
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

// Order status enum
export const ORDER_STATUSES = [
  "paid",
  "shipped",
  "delivered",
  "complete",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// Notification type enum
export const NOTIFICATION_TYPES = [
  "offer_received",
  "offer_accepted",
  "offer_declined",
  "offer_countered",
  "offer_expired",
  "order_paid",
  "order_shipped",
  "order_delivered",
  "order_complete",
  "listing_approved",
  "listing_rejected",
  "review_reminder",
  "review_revealed",
  "tier_upgrade",
  "tier_downgrade",
  "boost_activated",
  "boost_expiring",
  "sale_applied",
  "referral_credit_earned",
  "iso_match",
  "iso_response",
  "new_message",
  "price_drop_wishlist",
  "new_matching_listing",
  "new_listing_your_size",
  "listing_stale_reminder",
  "milestone_achieved",
  "weekly_digest",
  "referral_nudge",
  "re_engagement",
  "account_suspended",
  "followed_seller_new_listing",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ============================================================
// Database row interfaces
// ============================================================

export interface Offer {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  amount: number; // cents
  currency: string;
  status: OfferStatus;
  round: number;
  parent_offer_id: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  order_number: string;
  listing_id: string;
  buyer_id: string | null; // nullable for guest checkout
  seller_id: string;
  buyer_email: string;
  offer_id: string | null; // null = direct purchase
  amount: number; // cents
  currency: string;
  commission_rate: number; // percentage (e.g. 12.00)
  commission_amount: number; // cents
  seller_payout: number; // cents
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  status: OrderStatus;
  shipping_tracking_number: string | null;
  shipping_carrier: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  auto_complete_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

// ============================================================
// API input types
// ============================================================

export interface CreateOfferInput {
  listing_id: string;
  amount: number; // cents
  currency: string;
}

export interface CreateOrderInput {
  listing_id: string;
  buyer_email: string;
  amount: number; // cents
  currency: string;
  offer_id?: string;
  stripe_payment_intent_id: string;
  stripe_checkout_session_id?: string;
}

// ============================================================
// Extended types for API responses
// ============================================================

export interface OfferWithListing extends Offer {
  listing_title: string;
  listing_cover_photo_url: string | null;
  listing_price_amount: number;
  counterparty_name: string | null;
}

export interface OrderWithListing extends Order {
  listing_title: string;
  listing_cover_photo_url: string | null;
  listing_category: string;
  counterparty_name: string | null;
}

// ============================================================
// Status transition validation
// ============================================================

/** Valid order status transitions: maps current status to allowed next statuses */
export const VALID_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  paid: ["shipped", "cancelled"],
  shipped: ["delivered", "complete"], // complete via auto-complete cron
  delivered: ["complete"],
  complete: [],
  cancelled: [],
};

// ============================================================
// Review types
// ============================================================

export interface Review {
  id: string;
  order_id: string;
  reviewer_id: string;
  reviewee_id: string;
  reviewer_role: "buyer" | "seller";
  rating: number;
  comment: string | null;
  revealed_at: string | null;
  seller_reply: string | null;
  seller_reply_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// Constants
// ============================================================

/** Platform commission rate (percentage) */
export const COMMISSION_RATE = 12;

/** Maximum offer rounds before expiry */
export const MAX_OFFER_ROUNDS = 3;

/** Hours before a pending offer expires */
export const OFFER_EXPIRY_HOURS = 48;

/** Hours buyer has to pay after offer acceptance */
export const ACCEPTED_OFFER_PAYMENT_HOURS = 24;

/** Days after shipping before auto-complete */
export const AUTO_COMPLETE_DAYS = 7;

/** Days after order completion before review window closes and auto-reveal */
export const REVIEW_WINDOW_DAYS = 14;

/** Hours after order completion to send review reminder push */
export const REVIEW_REMINDER_HOURS = 48;

/** Days after reveal before seller reply window closes */
export const SELLER_REPLY_WINDOW_DAYS = 14;

// ============================================================
// Helper functions
// ============================================================

/**
 * Generate a unique order number in format KIF-YYYYMMDD-XXXX.
 * XXXX is a random 4-character alphanumeric string.
 */
export function generateOrderNumber(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dateStr = `${year}${month}${day}`;

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 4; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return `KIF-${dateStr}-${suffix}`;
}
