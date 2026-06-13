// ============================================================
// Payout service — true escrow + multi-method disbursement
//
// All buyer payments land in Kifaayat's Stripe balance. When the
// buyer confirms delivery (or the auto-complete cron fires), we
// either:
//   - Stripe Connect sellers  → stripe.transfers.create (auto)
//   - Wise / PayPal sellers   → mark ready_for_payout for the
//                               admin to disburse manually
//
// See PAYOUTS.md for the full design rationale.
// ============================================================

import { createSupabaseAdmin } from "../lib/supabase.js";
import { getStripe } from "../lib/stripeClient.js";
import { logger } from "../lib/logger.js";

export type PayoutMethod = "stripe" | "wise" | "paypal";

export interface SellerPayoutProfile {
  payout_method: string | null;
  stripe_account_id: string | null;
  stripe_onboarding_complete: boolean | null;
  wise_account_holder: string | null;
  wise_bank_country: string | null;
  wise_bank_currency: string | null;
  wise_routing_code: string | null;
  wise_account_number: string | null;
  paypal_email: string | null;
}

/**
 * The full set of profile columns the payout helpers need. Use this
 * in `.select(...)` so we never accidentally read a stale subset.
 */
export const SELLER_PAYOUT_PROFILE_FIELDS =
  "payout_method, stripe_account_id, stripe_onboarding_complete, " +
  "wise_account_holder, wise_bank_country, wise_bank_currency, " +
  "wise_routing_code, wise_account_number, paypal_email";

/**
 * Decide which payout method to use for a seller at payment-intent
 * creation time. Returns null when the seller has no usable method
 * configured (payment must be blocked).
 *
 * Stripe Connect takes precedence when both are configured — verified
 * Stripe Connect sellers continue to get auto-payouts.
 */
export function resolveSellerPayoutMethod(
  profile: SellerPayoutProfile | null
): PayoutMethod | null {
  if (!profile) return null;

  const chosen = profile.payout_method;
  const hasStripe =
    profile.stripe_account_id && profile.stripe_onboarding_complete;
  const hasWise =
    profile.wise_account_holder &&
    profile.wise_account_number &&
    profile.wise_bank_country &&
    profile.wise_bank_currency &&
    profile.wise_routing_code;
  const hasPaypal = !!profile.paypal_email;

  // Honour the seller's explicit choice when the relevant details are set.
  if (chosen === "stripe" && hasStripe) return "stripe";
  if (chosen === "wise" && hasWise) return "wise";
  if (chosen === "paypal" && hasPaypal) return "paypal";

  // Fallback chain for sellers who haven't explicitly chosen but have
  // something configured. Stripe wins (auto-payout, lowest admin lift).
  if (hasStripe) return "stripe";
  if (hasWise) return "wise";
  if (hasPaypal) return "paypal";

  return null;
}

export interface CreatePayoutLedgerParams {
  sellerId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  method: PayoutMethod;
}

/**
 * Insert a seller_payouts row in `pending` state when the order is
 * paid. UNIQUE(order_id) keeps this naturally idempotent — webhook
 * retries from Stripe won't duplicate the row.
 */
export async function createPayoutLedger(
  params: CreatePayoutLedgerParams
): Promise<void> {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase.from("seller_payouts").insert({
    seller_id: params.sellerId,
    order_id: params.orderId,
    amount_cents: params.amountCents,
    currency: params.currency.toUpperCase(),
    method: params.method,
    status: "pending",
  });

  if (error) {
    // 23505 = unique_violation. Webhook fired twice for the same payment_intent —
    // safe to swallow; the row already exists.
    if (error.code === "23505") {
      logger.info("payoutService.ledger_idempotent_skip", {
        order_id: params.orderId,
      });
      return;
    }
    logger.error("payoutService.ledger_insert_failed", {
      order_id: params.orderId,
      error: error.message,
    });
    throw new Error(`Failed to create payout ledger: ${error.message}`);
  }

  logger.info("payoutService.ledger_created", {
    order_id: params.orderId,
    seller_id: params.sellerId,
    method: params.method,
    amount_cents: params.amountCents,
    currency: params.currency,
  });
}

/**
 * Called on buyer-confirmed delivery / auto-complete. Reads the
 * existing pending payout row and either disburses (Stripe Connect)
 * or marks it ready for an admin to handle (Wise / PayPal).
 *
 * Safe to call multiple times — already-released rows are skipped.
 */
export async function releasePayoutForOrder(orderId: string): Promise<void> {
  const supabase = createSupabaseAdmin();

  const { data: payout, error: fetchError } = await supabase
    .from("seller_payouts")
    .select(
      "id, seller_id, order_id, amount_cents, currency, method, status"
    )
    .eq("order_id", orderId)
    .maybeSingle();

  if (fetchError) {
    logger.error("payoutService.release_fetch_failed", {
      order_id: orderId,
      error: fetchError.message,
    });
    return;
  }

  if (!payout) {
    // Possible for legacy orders that pre-date the seller_payouts ledger.
    // Log loudly so we can backfill but don't crash the order-completion flow.
    logger.error("payoutService.release_no_payout_row", { order_id: orderId });
    return;
  }

  if (payout.status !== "pending") {
    logger.info("payoutService.release_already_handled", {
      order_id: orderId,
      payout_id: payout.id,
      status: payout.status,
    });
    return;
  }

  if (payout.method === "stripe") {
    await disburseViaStripe(payout);
    return;
  }

  // Wise / PayPal — flip status; admin disburses out-of-band.
  const { error: updateError } = await supabase
    .from("seller_payouts")
    .update({ status: "ready_for_payout" })
    .eq("id", payout.id)
    .eq("status", "pending");

  if (updateError) {
    logger.error("payoutService.mark_ready_failed", {
      payout_id: payout.id,
      error: updateError.message,
    });
    return;
  }

  logger.info("payoutService.marked_ready_for_payout", {
    payout_id: payout.id,
    order_id: orderId,
    method: payout.method,
    amount_cents: payout.amount_cents,
  });
}

interface PayoutRow {
  id: string;
  seller_id: string;
  order_id: string;
  amount_cents: number;
  currency: string;
  method: string;
  status: string;
}

async function disburseViaStripe(payout: PayoutRow): Promise<void> {
  const supabase = createSupabaseAdmin();

  // Look up the seller's connected account at disbursement time. The
  // payout method might have changed since the order was placed (e.g.
  // seller verified Stripe Connect mid-order); we trust the snapshot
  // in the payout row's `method`, but we still need the current
  // acct_XXX id to send to.
  const { data: sellerProfile, error: profileError } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", payout.seller_id)
    .single();

  if (profileError || !sellerProfile?.stripe_account_id) {
    await markPayoutFailed(
      payout.id,
      "Seller has no Stripe Connect account at disbursement time"
    );
    return;
  }

  if (!sellerProfile.stripe_onboarding_complete) {
    await markPayoutFailed(
      payout.id,
      "Seller's Stripe Connect onboarding is no longer complete"
    );
    return;
  }

  // Look up the original charge so we can set `source_transaction` on
  // the Transfer. This (a) links the transfer to the original payment
  // in the Stripe dashboard so "Transferred to" populates on the
  // payment row, and (b) draws funds from that specific charge
  // instead of the platform's general available balance — useful if
  // the platform balance is temporarily low or held for other reasons.
  const { data: order } = await supabase
    .from("orders")
    .select("stripe_payment_intent_id")
    .eq("id", payout.order_id)
    .single();

  let sourceTransactionId: string | undefined;
  if (order?.stripe_payment_intent_id) {
    try {
      const pi = await getStripe().paymentIntents.retrieve(
        order.stripe_payment_intent_id
      );
      // latest_charge is a string id when not expanded.
      if (typeof pi.latest_charge === "string") {
        sourceTransactionId = pi.latest_charge;
      } else if (pi.latest_charge && "id" in pi.latest_charge) {
        sourceTransactionId = pi.latest_charge.id;
      }
    } catch (err) {
      // Non-fatal — we can still create the transfer without source_transaction,
      // just loses the dashboard linkage.
      logger.error("payoutService.charge_lookup_failed", {
        payout_id: payout.id,
        payment_intent_id: order.stripe_payment_intent_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    const transfer = await getStripe().transfers.create({
      amount: payout.amount_cents,
      currency: payout.currency.toLowerCase(),
      destination: sellerProfile.stripe_account_id,
      transfer_group: `payout_${payout.id}`,
      ...(sourceTransactionId ? { source_transaction: sourceTransactionId } : {}),
      metadata: {
        payout_id: payout.id,
        order_id: payout.order_id,
        seller_id: payout.seller_id,
      },
    });

    const { error: updateError } = await supabase
      .from("seller_payouts")
      .update({
        status: "sent",
        stripe_transfer_id: transfer.id,
        sent_at: new Date().toISOString(),
      })
      .eq("id", payout.id)
      .eq("status", "pending");

    if (updateError) {
      logger.error("payoutService.stripe_update_after_transfer_failed", {
        payout_id: payout.id,
        transfer_id: transfer.id,
        error: updateError.message,
      });
      return;
    }

    logger.info("payoutService.stripe_transfer_sent", {
      payout_id: payout.id,
      order_id: payout.order_id,
      transfer_id: transfer.id,
      amount_cents: payout.amount_cents,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("payoutService.stripe_transfer_failed", {
      payout_id: payout.id,
      order_id: payout.order_id,
      error: message,
    });
    await markPayoutFailed(payout.id, message);
  }
}

async function markPayoutFailed(
  payoutId: string,
  reason: string
): Promise<void> {
  const supabase = createSupabaseAdmin();
  await supabase
    .from("seller_payouts")
    .update({
      status: "failed",
      failure_reason: reason.slice(0, 1000),
    })
    .eq("id", payoutId);
}

/**
 * Called when an order is rejected / cancelled before the funds are
 * released. The Stripe refund already happens elsewhere; this just
 * cleans the ledger so the row doesn't sit in `pending` forever and
 * mislead admin dashboards.
 *
 * Skips rows already past the pending stage (e.g. seller manually
 * approved then later refunded — handled out-of-band as clawback).
 */
export async function cancelPayoutForOrder(
  orderId: string,
  reason: string
): Promise<void> {
  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("seller_payouts")
    .update({
      status: "cancelled",
      failure_reason: reason.slice(0, 1000),
    })
    .eq("order_id", orderId)
    .eq("status", "pending");

  if (error) {
    logger.error("payoutService.cancel_failed", {
      order_id: orderId,
      error: error.message,
    });
    return;
  }

  logger.info("payoutService.cancelled", { order_id: orderId, reason });
}
