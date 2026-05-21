import { createSupabaseAdmin } from "./supabase.js";
import type { NotificationType } from "../types/transactions.js";

// ============================================================
// Types
// ============================================================

interface CreateNotificationParams {
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface SendPushParams {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface NotificationTemplate {
  title: string;
  body: string;
}

// ============================================================
// Notification Category Map
// ============================================================

type NotificationCategory = 'transaction' | 'engagement' | 'seller' | 'marketing';

export const NOTIFICATION_CATEGORY_MAP: Record<string, NotificationCategory> = {
  // Transaction (always on, user cannot disable)
  offer_received: 'transaction',
  offer_accepted: 'transaction',
  offer_declined: 'transaction',
  offer_countered: 'transaction',
  offer_expired: 'transaction',
  order_paid: 'transaction',
  order_accepted: 'transaction',
  order_rejected: 'transaction',
  order_shipped: 'transaction',
  order_delivered: 'transaction',
  order_complete: 'transaction',
  account_suspended: 'transaction',
  // Engagement (default on)
  new_message: 'engagement',
  price_drop_wishlist: 'engagement',
  new_matching_listing: 'engagement',
  iso_match: 'engagement',
  iso_response: 'engagement',
  new_listing_your_size: 'engagement',
  review_reminder: 'engagement',
  review_revealed: 'engagement',
  // Seller (default on)
  listing_approved: 'seller',
  listing_rejected: 'seller',
  listing_stale_reminder: 'seller',
  boost_activated: 'seller',
  boost_expiring: 'seller',
  sale_applied: 'seller',
  tier_upgrade: 'seller',
  tier_downgrade: 'seller',
  milestone_achieved: 'seller',
  referral_credit_earned: 'seller',
  // Marketing (default off)
  weekly_digest: 'marketing',
  referral_nudge: 'marketing',
  re_engagement: 'marketing',
  // Seller follow (engagement)
  followed_seller_new_listing: 'engagement',
};

/** Default push_enabled value for categories without an explicit user preference */
const CATEGORY_DEFAULTS: Record<NotificationCategory, boolean> = {
  transaction: true,
  engagement: true,
  seller: true,
  marketing: false,
};

// ============================================================
// OneSignal Push Notification Sender
// ============================================================

const ONESIGNAL_API_URL = "https://onesignal.com/api/v1/notifications";

/**
 * Send push notification via OneSignal REST API.
 * Silently skips if user has no player ID or env vars are missing.
 * Push failure never throws -- it's fire-and-forget.
 */
async function sendPush(params: SendPushParams): Promise<void> {
  const appId = process.env.ONESIGNAL_APP_ID;
  const restApiKey = process.env.ONESIGNAL_REST_API_KEY;

  if (!appId || !restApiKey) {
    // OneSignal not configured -- skip push silently
    return;
  }

  try {
    const supabase = createSupabaseAdmin();

    // Look up user's OneSignal player ID
    const { data: profile } = await supabase
      .from("profiles")
      .select("onesignal_player_id")
      .eq("id", params.userId)
      .single();

    const playerId = profile?.onesignal_player_id;
    if (!playerId) {
      // User hasn't granted push permission -- skip silently
      return;
    }

    const response = await fetch(ONESIGNAL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Basic ${restApiKey}`,
      },
      body: JSON.stringify({
        app_id: appId,
        include_player_ids: [playerId],
        headings: { en: params.title },
        contents: { en: params.body },
        data: params.data || {},
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error("OneSignal push failed:", response.status, errorBody);
    }
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
}

// ============================================================
// Core Notification Creator
// ============================================================

/**
 * Insert an in-app notification for a user and optionally send push via OneSignal.
 * Checks admin toggles and user notification preferences before sending push.
 * Transaction category notifications always send. Marketing defaults to off.
 * Silently logs errors rather than throwing -- notifications
 * should never block the primary operation.
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<void> {
  try {
    const supabase = createSupabaseAdmin();
    const category = NOTIFICATION_CATEGORY_MAP[params.type] || 'engagement';

    // 1. Check admin toggles -- if admin disabled this type, skip entirely
    const { data: settings } = await supabase
      .from("admin_settings")
      .select("notification_toggles")
      .limit(1)
      .single();

    const toggles = (settings?.notification_toggles || {}) as Record<string, boolean>;
    if (toggles[params.type] === false) {
      // Admin has disabled this notification type entirely
      return;
    }

    // 2. Always insert in-app notification row (visible in notification center)
    const { error } = await supabase.from("notifications").insert({
      user_id: params.user_id,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data || {},
    });

    if (error) {
      console.error("Error creating notification:", error);
    }

    // 3. Determine if push should be sent based on user preferences
    let pushEnabled = true;

    if (category !== 'transaction') {
      // Check user preference for this category
      const { data: pref } = await supabase
        .from("notification_preferences")
        .select("push_enabled")
        .eq("user_id", params.user_id)
        .eq("category", category)
        .single();

      if (pref) {
        pushEnabled = pref.push_enabled;
      } else {
        // No explicit preference -- use category default
        pushEnabled = CATEGORY_DEFAULTS[category];
      }
    }

    // 4. Send push only if enabled
    if (pushEnabled) {
      sendPush({
        userId: params.user_id,
        title: params.title,
        body: params.body,
        data: params.data,
      }).catch((err) => {
        console.error("Push notification error (fire-and-forget):", err);
      });
    }
  } catch (err) {
    console.error("createNotification error (fire-and-forget):", err);
  }
}

// ============================================================
// Notification Template Helpers
// ============================================================

function formatPrice(amountCents: number, currency: string): string {
  const symbols: Record<string, string> = {
    AUD: "A$",
    USD: "US$",
    NZD: "NZ$",
  };
  const symbol = symbols[currency] || `${currency} `;
  return `${symbol}${(amountCents / 100).toFixed(2)}`;
}

export function offerReceivedNotification(
  buyerName: string,
  listingTitle: string,
  amount: number,
  currency: string
): NotificationTemplate {
  return {
    title: "New Offer Received",
    body: `${buyerName} offered ${formatPrice(amount, currency)} for "${listingTitle}"`,
  };
}

export function offerAcceptedNotification(
  listingTitle: string,
  amount: number,
  currency: string
): NotificationTemplate {
  return {
    title: "Offer Accepted!",
    body: `Your offer of ${formatPrice(amount, currency)} for "${listingTitle}" was accepted. You have 24 hours to complete payment.`,
  };
}

export function offerDeclinedNotification(
  listingTitle: string,
  amount: number,
  currency: string
): NotificationTemplate {
  return {
    title: "Offer Declined",
    body: `Your offer of ${formatPrice(amount, currency)} for "${listingTitle}" was declined.`,
  };
}

export function offerCounteredNotification(
  counterpartyName: string,
  listingTitle: string,
  amount: number,
  currency: string,
  round: number,
  maxRounds: number
): NotificationTemplate {
  return {
    title: "Counter-Offer Received",
    body: `${counterpartyName} countered with ${formatPrice(amount, currency)} for "${listingTitle}" (Round ${round} of ${maxRounds})`,
  };
}

export function offerExpiredNotification(
  listingTitle: string
): NotificationTemplate {
  return {
    title: "Offer Expired",
    body: `The offer on "${listingTitle}" has expired.`,
  };
}

export function orderPaidNotification(
  listingTitle: string,
  amount: number,
  currency: string,
  sellerPayout: number,
  shippingCost?: number
): NotificationTemplate {
  const totalEarnings = sellerPayout + (shippingCost || 0);
  const earningsText = shippingCost && shippingCost > 0
    ? `${formatPrice(totalEarnings, currency)} (incl. ${formatPrice(shippingCost, currency)} shipping)`
    : formatPrice(sellerPayout, currency);
  return {
    title: "You Made a Sale!",
    body: `"${listingTitle}" was purchased for ${formatPrice(amount, currency)}. Ship it to earn ${earningsText}.`,
  };
}

export function orderShippedNotification(
  listingTitle: string,
  trackingNumber?: string | null
): NotificationTemplate {
  return {
    title: "Your Order Has Shipped!",
    body: `"${listingTitle}" is on its way.${trackingNumber ? ` Tracking: ${trackingNumber}` : ""}`,
  };
}

export function orderDeliveredNotification(
  listingTitle: string
): NotificationTemplate {
  return {
    title: "Order Delivered",
    body: `"${listingTitle}" has been delivered to the buyer.`,
  };
}

export function orderCompleteNotification(
  listingTitle: string,
  variant: "buyer" | "seller",
  sellerPayout?: number,
  currency?: string
): NotificationTemplate {
  if (variant === "seller" && sellerPayout !== undefined && currency) {
    return {
      title: "Sale Complete - Payout Released",
      body: `Your sale of "${listingTitle}" is complete. Payout of ${formatPrice(sellerPayout, currency)} released.`,
    };
  }
  return {
    title: "Order Complete",
    body: `Your order for "${listingTitle}" is complete.`,
  };
}

export function orderAutoCompleteNotification(
  listingTitle: string,
  variant: "buyer" | "seller",
  sellerPayout?: number,
  currency?: string
): NotificationTemplate {
  if (variant === "seller" && sellerPayout !== undefined && currency) {
    return {
      title: "Sale Auto-Completed - Payout Released",
      body: `Sale of "${listingTitle}" auto-completed. Payout of ${formatPrice(sellerPayout, currency)} released.`,
    };
  }
  return {
    title: "Order Auto-Completed",
    body: `Your order for "${listingTitle}" has been automatically completed after 7 days.`,
  };
}

export function reviewRevealNotification(
  otherPartyName: string
): NotificationTemplate {
  return {
    title: "Reviews are in!",
    body: `See what ${otherPartyName} said about your transaction`,
  };
}

export function reviewReminderNotification(
  itemTitle: string,
  daysLeft: number
): NotificationTemplate {
  return {
    title: "How was your experience?",
    body: `Leave a review for "${itemTitle}" — ${daysLeft} days left`,
  };
}

export function sellerReplyNotification(
  sellerName: string
): NotificationTemplate {
  return {
    title: `${sellerName} replied to your review`,
    body: "See their response",
  };
}

export function tierUpgradeNotification(
  _sellerName: string,
  _newTier: number,
  tierLabel: string,
  commissionRate: number,
  autoApprove: boolean
): NotificationTemplate {
  return {
    title: `Congratulations! You're now a ${tierLabel}!`,
    body: `Your commission rate is now ${commissionRate}%.${autoApprove ? " Your listings are now auto-approved!" : ""}`,
  };
}

export function tierDowngradeNotification(
  _sellerName: string,
  _newTier: number,
  tierLabel: string,
  previousTierLabel: string
): NotificationTemplate {
  return {
    title: "Your seller tier has changed",
    body: `You've moved from ${previousTierLabel} to ${tierLabel}. Maintain your ratings and activity to regain your previous tier.`,
  };
}

export function referralCreditEarnedNotification(
  referredName: string
): NotificationTemplate {
  return {
    title: "You earned $10!",
    body: `${referredName} made their first purchase. $10 credit added to your account!`,
  };
}

// ============================================================
// ISO Notification Templates
// ============================================================

export function isoMatchFoundNotification(
  description: string
): NotificationTemplate {
  const snippet =
    description.length > 50 ? description.slice(0, 50) + "..." : description;
  return {
    title: "New match for your ISO!",
    body: `A listing matching "${snippet}" was found`,
  };
}

export function isoResponseReceivedNotification(
  sellerName: string,
  description: string
): NotificationTemplate {
  const snippet =
    description.length > 40 ? description.slice(0, 40) + "..." : description;
  return {
    title: `${sellerName} has what you're looking for!`,
    body: `Someone responded to your ISO: "${snippet}"`,
  };
}

export function listingApprovedNotification(
  listingTitle: string
): NotificationTemplate {
  return {
    title: "Listing Approved!",
    body: `Your listing "${listingTitle}" has been approved and is now live.`,
  };
}

export function listingRejectedNotification(
  listingTitle: string,
  reason?: string
): NotificationTemplate {
  return {
    title: "Listing Needs Changes",
    body: `Your listing "${listingTitle}" was not approved.${reason ? ` Reason: ${reason}` : ""}`,
  };
}

// ============================================================
// Messaging & Engagement Notification Templates
// ============================================================

export function newMessageNotification(senderName: string): NotificationTemplate {
  return {
    title: `New message from ${senderName}`,
    body: "You have a new message. Tap to read.",
  };
}

export function priceDropWishlistNotification(
  listingTitle: string,
  newPrice: number,
  currency: string
): NotificationTemplate {
  return {
    title: "Price Drop Alert!",
    body: `"${listingTitle}" is now ${formatPrice(newPrice, currency)}`,
  };
}

export function newMatchingListingNotification(
  listingTitle: string
): NotificationTemplate {
  return {
    title: "New listing matches your search",
    body: `Check out "${listingTitle}"`,
  };
}

export function isoMatchNotification(
  isoTitle: string
): NotificationTemplate {
  return {
    title: "Match found for your ISO!",
    body: `A listing matches your request: "${isoTitle}"`,
  };
}

export function newListingYourSizeNotification(
  listingTitle: string,
  category: string
): NotificationTemplate {
  return {
    title: `New ${category} in your size`,
    body: `"${listingTitle}" just listed and fits your measurements`,
  };
}

export function listingStaleReminderNotification(
  listingTitle: string,
  daysSinceActivity: number
): NotificationTemplate {
  return {
    title: "Your listing needs attention",
    body: `"${listingTitle}" hasn't had activity in ${daysSinceActivity} days. Consider adjusting the price.`,
  };
}

export function milestoneAchievedNotification(
  milestone: string
): NotificationTemplate {
  return {
    title: "Milestone achieved!",
    body: milestone,
  };
}

export function weeklyDigestNotification(
  newListings: number,
  views: number
): NotificationTemplate {
  return {
    title: "Your weekly digest",
    body: `${newListings} new listings this week. Your listings got ${views} views.`,
  };
}

export function referralNudgeNotification(): NotificationTemplate {
  return {
    title: "Share & earn $10",
    body: "Invite a friend to Kifaayat. You both get $10 credit!",
  };
}

export function reEngagementNotification(): NotificationTemplate {
  return {
    title: "We miss you!",
    body: "New arrivals are waiting for you. Come take a look.",
  };
}

export function followedSellerNewListingNotification(
  sellerName: string,
  listingTitle: string
): NotificationTemplate {
  return {
    title: `${sellerName} listed something new`,
    body: `Check out "${listingTitle}"`,
  };
}

export function orderAcceptedNotification(
  listingTitle: string
): NotificationTemplate {
  return {
    title: "Order Accepted!",
    body: `The seller has accepted your order for "${listingTitle}". It will be shipped soon.`,
  };
}

export function orderRejectedNotification(
  listingTitle: string,
  reason?: string
): NotificationTemplate {
  return {
    title: "Order Cancelled",
    body: reason
      ? `Your order for "${listingTitle}" was cancelled. Reason: ${reason}. A refund has been issued.`
      : `Your order for "${listingTitle}" was cancelled and a refund has been issued.`,
  };
}
