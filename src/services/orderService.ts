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

  // --- Idempotency check -------------------------------------
  // The Stripe webhook ALSO creates orders for `payment_intent.succeeded`,
  // so if it landed first we'd otherwise insert a duplicate row here and
  // emit a second `order:created` event (→ duplicate `order_paid` push to
  // the seller). Return the existing order silently so the caller still
  // gets a 201 with the canonical row, but no second notification fires.
  const supabaseForCheck = createSupabaseAdmin();
  const { data: existingOrder } = await supabaseForCheck
    .from("orders")
    .select("*")
    .eq("stripe_payment_intent_id", stripe_payment_intent_id)
    .maybeSingle();

  if (existingOrder) {
    logger.info("orderService.idempotent_return", {
      payment_intent_id: stripe_payment_intent_id,
      existing_order_id: existingOrder.id,
    });
    return existingOrder as CreatedOrder;
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
  // Trust the split that was pre-computed at payment-intent creation time
  // (metadata.item_amount / shipping_amount / commission_amount). Commission
  // is calculated on the ITEM only — shipping passes through to the seller.
  //
  // Fallback for payment intents created before that change shipped (no
  // metadata): treat the whole amount as item amount, recompute commission
  // on it. Older orders still come out clean; new orders carry the right
  // item-only commission.
  const intentMetadata = (intent.metadata || {}) as Record<string, string>;
  const itemAmount = parseInt(intentMetadata.item_amount || String(amount), 10);
  const shippingAmount = parseInt(intentMetadata.shipping_amount || "0", 10);
  // Persist the buyer's fulfilment choice. Without this the column defaults
  // to 'shipping' (schema-14), so pickup orders created via this FE-confirm
  // path were mislabeled — breaking the pickup flow + the sale notification.
  const deliveryMethod =
    intentMetadata.delivery_method === "pickup" ? "pickup" : "shipping";
  const voucherDiscount = parseInt(intentMetadata.voucher_discount || "0", 10);
  // Optional buyer note from checkout — empty string in metadata = no note.
  const buyerNote = intentMetadata.buyer_note ? intentMetadata.buyer_note : null;
  const fallbackRate = await getCommissionRate();
  const commissionAmount = intentMetadata.commission_amount
    ? parseInt(intentMetadata.commission_amount, 10)
    : Math.round(itemAmount * (fallbackRate / 100));
  // Reverse out the actual rate that was applied so commission_rate stays
  // consistent with commission_amount (won't drift even if the global rate
  // changes between payment and order creation).
  const commissionRate = itemAmount > 0
    ? Math.round((commissionAmount / itemAmount) * 10000) / 100
    : fallbackRate;
  // Seller payout = item - commission + shipping. UNCHANGED by voucher —
  // voucher comes out of Kifaayat's commission, not the seller's payout.
  const sellerPayout = intentMetadata.seller_payout
    ? parseInt(intentMetadata.seller_payout, 10)
    : itemAmount - commissionAmount + shippingAmount;
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
            offer_id, amount, item_amount, shipping_amount, voucher_discount,
            buyer_note,
            currency, commission_rate, commission_amount,
            seller_payout, stripe_payment_intent_id, stripe_checkout_session_id,
            status, delivery_method
          ) VALUES (
            ${orderNumber}, ${listing_id}, ${buyerId}, ${listing.seller_id},
            ${buyer_email}, ${offer_id || null}, ${amount}, ${itemAmount}, ${shippingAmount}, ${voucherDiscount},
            ${buyerNote},
            ${currency}, ${commissionRate}, ${commissionAmount}, ${sellerPayout},
            ${stripe_payment_intent_id},
            ${stripe_checkout_session_id || null},
            ${"paid" as OrderStatus}, ${deliveryMethod}
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
      // The SELECT-then-INSERT idempotency check above isn't atomic,
      // so the webhook handler can win the race between our SELECT and
      // our INSERT. Postgres 23505 from the partial UNIQUE index on
      // stripe_payment_intent_id (schema-15) means exactly that. Return
      // the existing row WITHOUT emitting order:created — the webhook
      // path has already fired the seller's "You Made a Sale!" push.
      const pgErr = err as { code?: string };
      if (pgErr?.code === "23505") {
        const { data: raceWinner } = await supabase
          .from("orders")
          .select("*")
          .eq("stripe_payment_intent_id", stripe_payment_intent_id)
          .maybeSingle();
        if (raceWinner) {
          logger.info("orderService.race_resolved_to_existing", {
            payment_intent_id: stripe_payment_intent_id,
            existing_order_id: raceWinner.id,
          });
          return raceWinner as CreatedOrder;
        }
      }
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
        item_amount: itemAmount,
        shipping_amount: shippingAmount,
        voucher_discount: voucherDiscount,
        buyer_note: buyerNote,
        currency,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        seller_payout: sellerPayout,
        stripe_payment_intent_id,
        stripe_checkout_session_id: stripe_checkout_session_id || null,
        status: "paid" as OrderStatus,
        delivery_method: deliveryMethod,
      })
      .select()
      .single();
    if (insertError) {
      // Same race-resolution as the atomic branch above. 23505 = the
      // webhook beat us to the insert; return the existing row and
      // skip the emit so the listener doesn't fire a duplicate
      // order_paid push.
      if ((insertError as { code?: string }).code === "23505") {
        const { data: raceWinner } = await supabase
          .from("orders")
          .select("*")
          .eq("stripe_payment_intent_id", stripe_payment_intent_id)
          .maybeSingle();
        if (raceWinner) {
          logger.info("orderService.race_resolved_to_existing", {
            payment_intent_id: stripe_payment_intent_id,
            existing_order_id: raceWinner.id,
          });
          return raceWinner as CreatedOrder;
        }
      }
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
    shippingAmount,
    deliveryMethod,
  });

  return order;
}
