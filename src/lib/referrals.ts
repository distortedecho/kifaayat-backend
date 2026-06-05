import { createSupabaseAdmin } from "./supabase.js";
import { createNotification, referralCreditEarnedNotification } from "./notifications.js";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// Constants
// ============================================================

/** Referral credit amount in cents ($10 = 1000 cents) */
export const REFERRAL_CREDIT_AMOUNT = 1000;

/** Credit expiry duration in months */
const CREDIT_EXPIRY_MONTHS = 12;

// ============================================================
// Credit Redemption
// ============================================================

/**
 * Redeem credits for a user by marking them as redeemed (FIFO by expiry).
 * Handles partial redemption by splitting the credit record.
 */
export async function redeemCredits(
  userId: string,
  amount: number,
  orderId?: string
): Promise<void> {
  const supabase = createSupabaseAdmin();

  // Get active, non-expired credits ordered by expires_at ASC (FIFO)
  const { data: credits } = await supabase
    .from("referral_credits")
    .select("id, amount, referral_code_id, type, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true });

  if (!credits || credits.length === 0) return;

  let remaining = amount;
  for (const credit of credits) {
    if (remaining <= 0) break;

    if (credit.amount <= remaining) {
      // Fully redeem this credit
      await supabase
        .from("referral_credits")
        .update({
          status: "redeemed",
          redeemed_at: new Date().toISOString(),
          redeemed_order_id: orderId || null,
        })
        .eq("id", credit.id);
      remaining -= credit.amount;
    } else {
      // Partially redeem: reduce amount on original, create redeemed record for used portion
      await supabase
        .from("referral_credits")
        .update({ amount: credit.amount - remaining })
        .eq("id", credit.id);

      await supabase.from("referral_credits").insert({
        user_id: userId,
        referral_code_id: credit.referral_code_id || null,
        amount: remaining,
        type: credit.type || "referrer_reward",
        status: "redeemed",
        redeemed_at: new Date().toISOString(),
        redeemed_order_id: orderId || null,
        expires_at: null,
      });
      remaining = 0;
    }
  }
}

// ============================================================
// Credit Balance
// ============================================================

/**
 * Get available (non-expired, non-redeemed) credit balance for a user.
 * Returns the total in cents.
 */
export async function getAvailableCreditBalance(userId: string): Promise<number> {
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("referral_credits")
    .select("amount")
    .eq("user_id", userId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString());

  if (error) {
    console.error("Error fetching referral credit balance:", error);
    return 0;
  }

  return (data || []).reduce((sum, row) => sum + (row.amount || 0), 0);
}

// ============================================================
// First Order Detection
// ============================================================

/**
 * Check if the user's most recently completed order is their first.
 * Returns true if the user has exactly 1 completed order (the one just completed).
 */
export async function isFirstCompletedOrder(userId: string): Promise<boolean> {
  const supabase = createSupabaseAdmin();

  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("buyer_id", userId)
    .eq("status", "complete");

  if (error) {
    console.error("Error checking first completed order:", error);
    return false;
  }

  return count === 1;
}

// ============================================================
// Credit Award
// ============================================================

/**
 * Award referral credits to both referrer and referred user.
 * Guards against duplicate awards.
 */
export async function awardReferralCredits(params: {
  referrer_id: string;
  referred_id: string;
  referral_code_id: string;
  qualifying_order_id: string;
}): Promise<void> {
  const supabase = createSupabaseAdmin();

  // Guard: check no existing referred_reward for this referred user
  const { data: existingCredit } = await supabase
    .from("referral_credits")
    .select("id")
    .eq("user_id", params.referred_id)
    .eq("type", "referred_reward")
    .limit(1)
    .single();

  if (existingCredit) {
    // Already awarded -- skip
    return;
  }

  // Look up the referral record
  const { data: referral } = await supabase
    .from("referrals")
    .select("id")
    .eq("referred_id", params.referred_id)
    .eq("referral_code_id", params.referral_code_id)
    .single();

  if (!referral) {
    console.error("No referral record found for credit award");
    return;
  }

  // Update referral status to 'credited' and set qualifying order
  await supabase
    .from("referrals")
    .update({
      status: "credited",
      qualifying_order_id: params.qualifying_order_id,
      qualified_at: new Date().toISOString(),
    })
    .eq("id", referral.id);

  // Calculate expiry date (12 months from now)
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + CREDIT_EXPIRY_MONTHS);
  const expiresAtISO = expiresAt.toISOString();

  // Insert credit for referrer
  await supabase.from("referral_credits").insert({
    user_id: params.referrer_id,
    referral_code_id: params.referral_code_id,
    referral_id: referral.id,
    order_id: params.qualifying_order_id,
    amount: REFERRAL_CREDIT_AMOUNT,
    type: "referrer_reward",
    status: "active",
    expires_at: expiresAtISO,
  });

  // Insert credit for referred user
  await supabase.from("referral_credits").insert({
    user_id: params.referred_id,
    referral_code_id: params.referral_code_id,
    referral_id: referral.id,
    order_id: params.qualifying_order_id,
    amount: REFERRAL_CREDIT_AMOUNT,
    type: "referred_reward",
    status: "active",
    expires_at: expiresAtISO,
  });

  // Fire-and-forget notification to referrer
  // Look up referred user's name for notification
  const { data: referredProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", params.referred_id)
    .single();

  const referredName = referredProfile?.display_name || "Someone";
  const template = referralCreditEarnedNotification(referredName);

  createNotification({
    user_id: params.referrer_id,
    type: "referral_credit_earned",
    ...template,
    // Vouchers are spent when buying, so this surfaces in the buying tab.
    data: {
      referral_id: referral.id,
      referred_id: params.referred_id,
      amount: REFERRAL_CREDIT_AMOUNT,
      role: "buyer",
    },
  }).catch((err) => {
    console.error("Error sending referral credit notification:", err);
  });
}

/** Max number of successful referrals a user can make */
export const MAX_REFERRALS = 20;

/**
 * Record a referral from a checkout and award a voucher to the referrer.
 * Called from the Stripe webhook after payment_intent.succeeded.
 * Guards: duplicate referral, self-referral, max cap, invalid/disabled code.
 */
export async function recordReferralAndAwardVoucher(params: {
  supabase: SupabaseClient;
  referralCode: string;
  buyerId: string;
  orderId: string;
}): Promise<void> {
  const { supabase, referralCode, buyerId, orderId } = params;

  // Look up the referral code
  const { data: codeRow } = await supabase
    .from("referral_codes")
    .select("id, user_id, disabled")
    .eq("code", referralCode)
    .single();

  if (!codeRow || codeRow.disabled) return;
  if (codeRow.user_id === buyerId) return; // self-referral guard

  const referrerId = codeRow.user_id;

  // Guard: buyer already has a referral recorded
  const { data: existingReferral } = await supabase
    .from("referrals")
    .select("id")
    .eq("referred_id", buyerId)
    .single();
  if (existingReferral) return;

  // Guard: referrer has already hit the 20-referral cap
  const { count } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_id", referrerId);
  if ((count ?? 0) >= MAX_REFERRALS) return;

  // Insert referral record
  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .insert({
      referrer_id: referrerId,
      referred_id: buyerId,
      referral_code_id: codeRow.id,
      qualifying_order_id: orderId,
      status: "qualified",
      qualified_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (referralError || !referral) {
    console.error("Error inserting referral:", referralError);
    return;
  }

  // Award voucher to referrer
  await supabase.from("referral_vouchers").insert({
    user_id: referrerId,
    referred_id: buyerId,
    referral_id: referral.id,
    status: "available",
  });

  // Notify referrer
  const { data: referredProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", buyerId)
    .single();

  const referredName = referredProfile?.display_name || "Someone";
  const template = referralCreditEarnedNotification(referredName);
  createNotification({
    user_id: referrerId,
    type: "referral_credit_earned",
    ...template,
    data: { referral_id: referral.id, referred_id: buyerId, role: "buyer" },
  }).catch((err) => console.error("Referral notification error:", err));
}
