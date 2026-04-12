// ============================================================
// Typed application event emitter (Phase 2.7)
//
// Route handlers emit domain events through `appEvents` instead of
// doing side effects inline. Listeners in backend/src/listeners/
// subscribe to these events and handle notifications/emails/etc
// asynchronously so the HTTP response can return immediately.
//
// The typed `emit(...)` wrapper enforces payload shape at the call
// site so a typo in the event name or payload fails at compile time,
// not in production.
// ============================================================

import { EventEmitter } from "events";
import { logger } from "./logger.js";

// ------------------------------------------------------------
// Event map -- single source of truth for every domain event
// ------------------------------------------------------------
export interface AppEventMap {
  "order:created": {
    orderId: string;
    sellerId: string;
    buyerId: string | null;
    buyerEmail: string | null;
    listingId: string;
    listingTitle: string;
    amount: number;
    currency: string;
    sellerPayout: number;
  };
  "offer:received": {
    offerId: string;
    sellerId: string;
    buyerId: string;
    buyerName: string;
    listingId: string;
    listingTitle: string;
    amount: number;
    currency: string;
  };
  "offer:accepted": {
    offerId: string;
    listingId: string;
    listingTitle: string;
    notifyUserId: string;
    amount: number;
    currency: string;
  };
  "offer:rejected": {
    offerId: string;
    listingId: string;
    listingTitle: string;
    notifyUserId: string;
    amount: number;
    currency: string;
  };
  "listing:approved": {
    listingId: string;
    sellerId: string;
    title: string;
  };
  "listing:rejected": {
    listingId: string;
    sellerId: string;
    title: string;
    reason?: string;
  };
  "message:sent": {
    conversationId: string;
    listingId: string;
    recipientId: string;
    senderId: string;
    senderName: string;
    preview: string;
  };
  "review:created": {
    reviewId: string;
    orderId: string;
    revieweeId: string;
    reviewerId: string;
  };
  "user:signed_up": {
    userId: string;
    email: string;
  };
}

// Raise Node's default listener cap modestly -- each event type can
// have both a notification and an email handler registered, and we
// want to leave headroom for future listeners.
export const appEvents = new EventEmitter();
appEvents.setMaxListeners(50);

/**
 * Type-safe event emission. Use this instead of appEvents.emit(...)
 * so the compiler checks the event name + payload shape.
 */
export function emit<K extends keyof AppEventMap>(
  event: K,
  payload: AppEventMap[K]
): void {
  appEvents.emit(event, payload);
}

/**
 * Type-safe subscription. Listeners should use this so their handler
 * payload is strongly typed.
 */
export function on<K extends keyof AppEventMap>(
  event: K,
  handler: (payload: AppEventMap[K]) => void | Promise<void>
): void {
  appEvents.on(event, (payload) => {
    Promise.resolve(handler(payload as AppEventMap[K])).catch((err) => {
      logger.error("events.listener_failed", {
        event,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
