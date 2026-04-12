// ============================================================
// Order service (Phase 2.8)
//
// Extracts business logic from routes/orders.ts into reusable
// service functions. Routes stay thin (parse -> call service ->
// return). Side effects (notifications) are now emitted via the
// typed appEvents emitter in lib/events.ts.
//
// When DATABASE_URL is configured, createOrder runs the multi-step
// write as a single atomic transaction through the direct
// Postgres client in lib/db.ts. Otherwise we fall back to sequential
// Supabase JS calls so local dev without Supavisor still works.
// ============================================================

import Stripe from "stripe";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { hasDirectDb, getSql } from "../lib/db.js";
import { emit } from "../lib/events.js";
import { getCommissionRate } from "../lib/commission.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import {
  type OrderStatus,
  generateOrderNumber,
} from "../types/transactions.js";
import { logger } from "../lib/logger.js";

// Shared Stripe client -- same config as routes/orders.ts
let _stripe: Stripe | null = null;
function getStripeClient(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
      apiVersion: "2026-02-25.clover",
    });
  }
  return _stripe;
}

export class OrderServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "OrderServiceError";
  }
}

export interface CreateOrderParams {
  listing_id: string;
  buyer_email: string;
  amount: number;
  currency: string;
  offer_id?: string;
  stripe_payment_intent_id: string;
  stripe_checkout_session_id?: string;
  clerkUserId: string | null;
}

export interface CreatedOrder {
  [key: string]: unknown;
}

/**
 * Verify payment with Stripe and create the order in an atomic
 * transaction. Emits `order:created` for async follow-up.
 *
 * Throws OrderServiceError for caller-facing errors so the route
 * handler can translate to the correct HTTP status.
 */
export async function createOrder(
  params: CreateOrderParams
): Promise<CreatedOrder> {
  const {
    listing_id,
    buyer_email,
    amount,
    currency,
    offer_id,
    stripe_payment_intent_id,
    stripe_checkout_session_id,
    clerkUserId,
  } = params;

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new OrderServiceError("Server configuration error", 500);
  }

  // --- Stripe verification -----------------------------------
  let intent: Stripe.PaymentIntent;
  try {
    intent = await getStripeClient().paymentIntents.retrieve(
      stripe_payment_intent_id
    );
  } catch (err) {
    logger.error("orderService.stripe_retrieve_failed", {
      payment_intent_id: stripe_payment_intent_id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new OrderServiceError("Could not verify payment", 400);
  }

  if (intent.status !== "succeeded") {
    throw new OrderServiceError(
      `Payment not completed (status: ${intent.status})`,
      400
    );
  }
  if (intent.amount !== amount) {
    logger.error("orderService.stripe_amount_mismatch", {
      intent_amount: intent.amount,
      body_amount: amount,
      payment_intent_id: stripe_payment_intent_id,
    });
    throw new OrderServiceError("Payment amount mismatch", 400);
  }
  if (intent.currency?.toLowerCase() !== currency.toLowerCase()) {
    logger.error("orderService.stripe_currency_mismatch", {
      intent_currency: intent.currency,
      body_currency: currency,
      payment_intent_id: stripe_payment_intent_id,
    });
    throw new OrderServiceError("Payment currency mismatch", 400);
  }
  const intentListingId = intent.metadata?.listing_id;
  if (!intentListingId || intentListingId !== listing_id) {
    logger.error("orderService.stripe_listing_mismatch", {
      intent_listing_id: intentListingId,
      body_listing_id: listing_id,
      payment_intent_id: stripe_payment_intent_id,
    });
    throw new OrderServiceError("Payment listing mismatch", 400);
  }

  // --- Buyer resolution --------------------------------------
  let buyerId: string | null = null;
  if (clerkUserId) {
    const profile = await getProfileByClerkId(clerkUserId);
    if (profile) buyerId = profile.id;
  }

  // --- Listing lookup ----------------------------------------
  const supabase = createSupabaseAdmin();
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, title, status")
    .eq("id", listing_id)
    .single();
  if (listingError || !listing) {
    throw new OrderServiceError("Listing not found", 404);
  }

  // --- Commission --------------------------------------------
  const commissionRate = await getCommissionRate();
  const commissionAmount = Math.round(amount * (commissionRate / 100));
  const sellerPayout = amount - commissionAmount;
  const orderNumber = generateOrderNumber();

  // --- Atomic write (direct PG if available) ------------------
  let order: CreatedOrder | null = null;

  if (hasDirectDb()) {
    try {
      const sql = getSql();
      const rows = await sql.begin(async (tx) => {
        const inserted = await tx<CreatedOrder[]>`
          INSERT INTO orders (
            order_number, listing_id, buyer_id, seller_id, buyer_email,
            offer_id, amount, currency, commission_rate, commission_amount,
            seller_payout, stripe_payment_intent_id, stripe_checkout_session_id,
            status
          ) VALUES (
            ${orderNumber}, ${listing_id}, ${buyerId}, ${listing.seller_id},
            ${buyer_email}, ${offer_id || null}, ${amount}, ${currency},
            ${commissionRate}, ${commissionAmount}, ${sellerPayout},
            ${stripe_payment_intent_id},
            ${stripe_checkout_session_id || null},
            ${"paid" as OrderStatus}
          )
          RETURNING *
        `;
        await tx`UPDATE listings SET status = 'sold' WHERE id = ${listing_id}`;
        if (offer_id) {
          await tx`UPDATE offers SET status = 'completed' WHERE id = ${offer_id}`;
        }
        return inserted;
      });
      order = rows[0] || null;
    } catch (err) {
      logger.error("orderService.atomic_create_failed", {
        listing_id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new OrderServiceError("Failed to create order", 500);
    }
  } else {
    // Fallback: sequential Supabase JS calls. Not atomic but dev-friendly.
    const { data: insertedOrder, error: insertError } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        listing_id,
        buyer_id: buyerId,
        seller_id: listing.seller_id,
        buyer_email,
        offer_id: offer_id || null,
        amount,
        currency,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        seller_payout: sellerPayout,
        stripe_payment_intent_id,
        stripe_checkout_session_id: stripe_checkout_session_id || null,
        status: "paid" as OrderStatus,
      })
      .select()
      .single();
    if (insertError) {
      logger.error("orderService.insert_failed", {
        listing_id,
        error: insertError.message,
      });
      throw new OrderServiceError("Failed to create order", 500);
    }
    order = insertedOrder as CreatedOrder;

    await supabase
      .from("listings")
      .update({ status: "sold" })
      .eq("id", listing_id);

    if (offer_id) {
      await supabase
        .from("offers")
        .update({ status: "completed" })
        .eq("id", offer_id);
    }
  }

  if (!order) {
    throw new OrderServiceError("Failed to create order", 500);
  }

  // --- Fire event for async side effects ---------------------
  emit("order:created", {
    orderId: order.id as string,
    sellerId: listing.seller_id as string,
    buyerId,
    buyerEmail: buyer_email,
    listingId: listing_id,
    listingTitle: listing.title as string,
    amount,
    currency,
    sellerPayout,
  });

  return order;
}
