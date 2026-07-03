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

import type Stripe from "stripe";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { getStripe } from "../lib/stripeClient.js";
import { logger } from "../lib/logger.js";
import { enqueueDelayed, JOB_RETRY_STRIPE_PAYOUT } from "../lib/jobs.js";

// Destination-charge funds sit in the seller's `pending` balance for
// Stripe's settlement window (~2 business days). If they haven't cleared
// when we release, we defer and retry roughly daily, up to this many times
// before giving up and flagging the payout for admin review.
const MAX_PAYOUT_RETRIES = 5;
const PAYOUT_RETRY_DELAY_SECONDS = 24 * 60 * 60;

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
  const hasStripe = !!(
    profile.stripe_account_id && profile.stripe_onboarding_complete
  );
  const hasWise = !!(
    profile.wise_account_holder &&
    profile.wise_account_number &&
    profile.wise_bank_country &&
    profile.wise_bank_currency &&
    profile.wise_routing_code
  );
  const hasPaypal = !!profile.paypal_email;

  // The seller's explicit choice is AUTHORITATIVE. If they picked a method,
  // we ONLY use that method — never silently pay them via a different one
  // they happen to have configured. If their chosen method isn't ready yet
  // (e.g. Stripe onboarding incomplete), return null so the purchase is
  // blocked until they finish setting it up. Resolved live at checkout, so
  // this applies to every listing (old + new) automatically.
  if (chosen === "stripe") return hasStripe ? "stripe" : null;
  if (chosen === "wise") return hasWise ? "wise" : null;
  if (chosen === "paypal") return hasPaypal ? "paypal" : null;

  // No explicit choice — fall back to whatever is configured (Stripe wins:
  // auto-payout, lowest admin lift).
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

  // How the order was charged decides how we release:
  //   - DESTINATION CHARGE (single-item checkout): the funds already
  //     transferred to the seller's Stripe balance at purchase, held by
  //     their manual payout schedule. Release = pay out to their bank.
  //   - PLATFORM-BALANCE CHARGE (cart, or legacy pre-destination-charge
  //     orders): funds are in Kifaayat's balance. Release = create a
  //     Transfer to the seller (works for AU; cross-border restricted).
  // We detect by inspecting the charge: a destination charge has a
  // `transfer` pointing at the seller's account.
  const charge = await getOrderCharge(payout.order_id);
  const destTransferId = getChargeTransferId(charge);

  if (destTransferId) {
    await releaseViaPayout(
      payout,
      sellerProfile.stripe_account_id,
      destTransferId,
      0
    );
  } else {
    await releaseViaTransfer(
      payout,
      sellerProfile.stripe_account_id,
      charge?.id
    );
  }
}

/** Pull the (expanded) charge for an order's PaymentIntent, or null. */
async function getOrderCharge(
  orderId: string
): Promise<Stripe.Charge | null> {
  const supabase = createSupabaseAdmin();
  const { data: order } = await supabase
    .from("orders")
    .select("stripe_payment_intent_id")
    .eq("id", orderId)
    .single();
  if (!order?.stripe_payment_intent_id) return null;
  try {
    const pi = await getStripe().paymentIntents.retrieve(
      order.stripe_payment_intent_id,
      { expand: ["latest_charge"] }
    );
    return (pi.latest_charge as Stripe.Charge | null) ?? null;
  } catch (err) {
    logger.error("payoutService.charge_lookup_failed", {
      order_id: orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The seller-bound transfer id on a destination charge, if any. */
function getChargeTransferId(charge: Stripe.Charge | null): string | undefined {
  if (!charge) return undefined;
  if (typeof charge.transfer === "string") return charge.transfer;
  return charge.transfer?.id;
}

/**
 * Release a DESTINATION-CHARGE order: the money already lives in the
 * seller's Stripe balance (in THEIR currency), so we pay it out to their
 * bank. The amount/currency come from the transfer the charge created —
 * NOT the ledger's amount_cents, which is in the buyer's charge currency
 * and would be wrong for a cross-currency sale.
 *
 * Funds may still be `pending` (settlement window). If not enough is
 * available yet, we mark the row `awaiting_funds` and enqueue a retry.
 */
async function releaseViaPayout(
  payout: PayoutRow,
  sellerAccountId: string,
  destTransferId: string,
  attempt: number
): Promise<void> {
  const supabase = createSupabaseAdmin();

  let transfer: Stripe.Transfer;
  try {
    transfer = await getStripe().transfers.retrieve(destTransferId);
  } catch (err) {
    await markPayoutFailed(
      payout.id,
      `Could not load destination transfer ${destTransferId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }

  const amount = transfer.amount; // seller-currency minor units
  const currency = transfer.currency; // seller currency

  // Is enough settled to pay out yet?
  const balance = await getStripe().balance.retrieve({
    stripeAccount: sellerAccountId,
  });
  const available =
    balance.available.find((b) => b.currency === currency)?.amount ?? 0;

  if (available < amount) {
    if (attempt >= MAX_PAYOUT_RETRIES) {
      await markPayoutFailed(
        payout.id,
        `Funds still pending after ${attempt} retries ` +
          `(available ${available} < needed ${amount} ${currency})`
      );
      return;
    }
    await supabase
      .from("seller_payouts")
      .update({ status: "awaiting_funds" })
      .eq("id", payout.id)
      .in("status", ["pending", "awaiting_funds"]);
    await enqueueDelayed(
      JOB_RETRY_STRIPE_PAYOUT,
      { orderId: payout.order_id, attempt: attempt + 1 },
      PAYOUT_RETRY_DELAY_SECONDS
    );
    logger.info("payoutService.payout_deferred_pending_funds", {
      payout_id: payout.id,
      order_id: payout.order_id,
      available,
      needed: amount,
      currency,
      attempt,
    });
    return;
  }

  try {
    const po = await getStripe().payouts.create(
      {
        amount,
        currency,
        metadata: {
          payout_id: payout.id,
          order_id: payout.order_id,
          seller_id: payout.seller_id,
        },
      },
      { stripeAccount: sellerAccountId }
    );

    const { error: updateError } = await supabase
      .from("seller_payouts")
      .update({
        status: "sent",
        stripe_payout_id: po.id,
        sent_at: new Date().toISOString(),
      })
      .eq("id", payout.id)
      .in("status", ["pending", "awaiting_funds"]);

    if (updateError) {
      logger.error("payoutService.stripe_update_after_payout_failed", {
        payout_id: payout.id,
        stripe_payout_id: po.id,
        error: updateError.message,
      });
      return;
    }

    logger.info("payoutService.stripe_payout_sent", {
      payout_id: payout.id,
      order_id: payout.order_id,
      stripe_payout_id: po.id,
      amount,
      currency,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("payoutService.stripe_payout_failed", {
      payout_id: payout.id,
      order_id: payout.order_id,
      error: message,
    });
    await markPayoutFailed(payout.id, message);
  }
}

/**
 * Release a PLATFORM-BALANCE order via a Transfer to the seller. Used for
 * cart orders and legacy orders that predate destination charges. Setting
 * `source_transaction` links the transfer to the original charge (populates
 * "Transferred to" in the dashboard and draws from that specific charge).
 * Cross-border restricted — only reliable AU platform → AU seller.
 */
async function releaseViaTransfer(
  payout: PayoutRow,
  sellerAccountId: string,
  sourceChargeId: string | undefined
): Promise<void> {
  const supabase = createSupabaseAdmin();
  try {
    const transfer = await getStripe().transfers.create({
      amount: payout.amount_cents,
      currency: payout.currency.toLowerCase(),
      destination: sellerAccountId,
      transfer_group: `payout_${payout.id}`,
      ...(sourceChargeId ? { source_transaction: sourceChargeId } : {}),
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

/**
 * Retry a deferred destination-charge payout (status 'awaiting_funds')
 * once the seller's funds should have cleared. Invoked by the
 * JOB_RETRY_STRIPE_PAYOUT worker.
 */
export async function retryStripePayoutRelease(
  orderId: string,
  attempt: number
): Promise<void> {
  const supabase = createSupabaseAdmin();

  const { data: payout } = await supabase
    .from("seller_payouts")
    .select("id, seller_id, order_id, amount_cents, currency, method, status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!payout) {
    logger.error("payoutService.retry_no_payout_row", { order_id: orderId });
    return;
  }
  if (payout.status !== "awaiting_funds") {
    logger.info("payoutService.retry_skipped", {
      order_id: orderId,
      status: payout.status,
    });
    return;
  }

  const { data: sellerProfile } = await supabase
    .from("profiles")
    .select("stripe_account_id")
    .eq("id", payout.seller_id)
    .single();
  if (!sellerProfile?.stripe_account_id) {
    await markPayoutFailed(payout.id, "Seller lost Stripe account before retry");
    return;
  }

  const charge = await getOrderCharge(orderId);
  const destTransferId = getChargeTransferId(charge);
  if (!destTransferId) {
    await markPayoutFailed(payout.id, "No destination transfer found on retry");
    return;
  }

  await releaseViaPayout(
    payout,
    sellerProfile.stripe_account_id,
    destTransferId,
    attempt
  );
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
    // Cancel while the payout hasn't gone out yet. 'awaiting_funds' rows
    // have a retry job queued; flipping to 'cancelled' makes that retry
    // no-op (it only proceeds for 'awaiting_funds').
    .in("status", ["pending", "awaiting_funds"]);

  if (error) {
    logger.error("payoutService.cancel_failed", {
      order_id: orderId,
      error: error.message,
    });
    return;
  }

  logger.info("payoutService.cancelled", { order_id: orderId, reason });
}

/**
 * Refund an order's payment correctly for whichever charge model it used.
 *
 * For DESTINATION CHARGES (single-item Stripe Connect orders) the funds
 * settled into the seller's balance, so the refund must:
 *   - reverse_transfer: claw the money back from the seller's balance
 *   - refund_application_fee: return Kifaayat's commission too
 * For PLATFORM-BALANCE charges (cart / Wise / PayPal orders) the money is
 * still in Kifaayat's balance, so a plain refund is correct — passing
 * reverse_transfer there would error (there's no transfer to reverse).
 *
 * We detect the model by inspecting the charge for a seller-bound transfer.
 * Best-effort: on refund failure we throw so the caller can decide.
 */
export async function refundOrderPayment(
  paymentIntentId: string
): Promise<Stripe.Refund> {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge"],
  });
  const charge = (pi.latest_charge as Stripe.Charge | null) ?? null;
  const isDestinationCharge = !!getChargeTransferId(charge);

  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    ...(isDestinationCharge
      ? { reverse_transfer: true, refund_application_fee: true }
      : {}),
  });
}
