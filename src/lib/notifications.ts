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
 * Insert an in-app notification for a user and send push via OneSignal.
 * Silently logs errors rather than throwing -- notifications
 * should never block the primary operation.
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<void> {
  const supabase = createSupabaseAdmin();

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

  // Fire-and-forget push notification
  sendPush({
    userId: params.user_id,
    title: params.title,
    body: params.body,
    data: params.data,
  }).catch((err) => {
    console.error("Push notification error (fire-and-forget):", err);
  });
}

// ============================================================
// Notification Template Helpers
// ============================================================

function formatPrice(amountCents: number, currency: string): string {
  const symbols: Record<string, string> = {
    AUD: "A$",
    USD: "$",
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
  sellerPayout: number
): NotificationTemplate {
  return {
    title: "You Made a Sale!",
    body: `"${listingTitle}" was purchased for ${formatPrice(amount, currency)}. Ship it to earn ${formatPrice(sellerPayout, currency)}.`,
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
