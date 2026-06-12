import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { createNotification, orderPaidNotification } from "../lib/notifications.js";
import {
  generateOrderNumber,
  VOUCHER_DISCOUNT_RATE,
  type OrderStatus,
} from "../types/transactions.js";
import { getCommissionRate, getSellerCommissionRate } from "../lib/commission.js";
import type { StripeAccountStatus, StripeStatusResponse } from "../types/stripe.js";
import { redeemCredits, recordReferralAndAwardVoucher } from "../lib/referrals.js";
import { logger } from "../lib/logger.js";
import { getStripe } from "../lib/stripeClient.js";
import { enqueueDelayed, JOB_AUTO_REJECT_ORDER } from "../lib/jobs.js";

const stripeRoutes = new Hono();

stripeRoutes.use("*", async (c, next) => {
  if (c.req.path.endsWith("/onboarding-return") || c.req.path.endsWith("/onboarding-refresh")) {
    return next();
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Stripe is not configured" }, 503);
  }
  return next();
});

// ============================================================
// Zod Schemas
// ============================================================

const paymentIntentSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  buyer_email: z.string().email("buyer_email must be a valid email").optional(),
  offer_id: z.string().uuid("offer_id must be a valid UUID").optional(),
  referral_code: z.string().max(20).optional(),
  voucher_id: z.string().uuid("voucher_id must be a valid UUID").optional(),
  // Optional note from buyer to seller, shown on the seller's order detail
  // (e.g. shipping requests). Frontend should treat this as one-shot —
  // there's no chat until the seller accepts the order.
  buyer_note: z.string().max(500).nullish(),
});

const boostPaymentIntentSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
});

const boostConfirmSchema = z.object({
  boost_id: z.string().uuid("boost_id must be a valid UUID"),
});

// ============================================================
// Helpers
// ============================================================

/**
 * Map Stripe account details to our internal status.
 */
function mapAccountToStatus(account: Stripe.Account): StripeAccountStatus {
  if (account.charges_enabled && account.payouts_enabled) {
    return "verified";
  }
  if (account.details_submitted && !account.charges_enabled) {
    return "pending_verification";
  }
  if (
    account.requirements?.currently_due &&
    account.requirements.currently_due.length > 0
  ) {
    return "action_needed";
  }
  return "onboarding_incomplete";
}

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/stripe/boost-payment-intent
 * Create a Stripe PaymentIntent for boosting a listing (direct charge -- platform revenue).
 */
stripeRoutes.post("/boost-payment-intent", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Parse and validate body
  const body = await c.req.json();
  const parsed = boostPaymentIntentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id } = parsed.data;

  // Verify listing exists and belongs to this seller
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to boost this listing" }, 403);
  }

  if (listing.status !== "active") {
    return c.json({ error: "Only active listings can be boosted" }, 400);
  }

  // Fetch boost config from admin_settings
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("boost_price_cents, boost_duration_days")
    .limit(1)
    .single();

  const boostPriceCents = settings?.boost_price_cents ?? 500;
  const boostDurationDays = settings?.boost_duration_days ?? 7;

  // Create PaymentIntent as a DIRECT charge (platform revenue, no transfer_data)
  try {
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: boostPriceCents,
      currency: "aud",
      metadata: {
        checkout_type: "boost",
        listing_id,
        seller_profile_id: profile.id,
      },
    });

    // Create a pending boost record
    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + boostDurationDays * 86400000).toISOString();

    const { data: boost, error: boostError } = await supabase
      .from("listing_boosts")
      .insert({
        listing_id,
        seller_id: profile.id,
        stripe_payment_intent_id: paymentIntent.id,
        amount_paid: boostPriceCents,
        starts_at: startsAt,
        ends_at: endsAt,
        status: "pending",
      })
      .select("id")
      .single();

    if (boostError) {
      console.error("Error creating boost record:", boostError);
      return c.json({ error: "Failed to create boost record" }, 500);
    }

    return c.json({
      clientSecret: paymentIntent.client_secret,
      boostId: boost.id,
    });
  } catch (error) {
    console.error("Error creating boost payment intent:", error);
    return c.json({ error: "Failed to create payment intent" }, 500);
  }
});

/**
 * POST /api/stripe/payment-intent
 * Create a Stripe PaymentIntent for buying a listing.
 * Uses optionalClerkMiddleware to support guest checkout.
 * Supports Destination Charges when the seller has a connected Stripe account.
 */
stripeRoutes.post("/payment-intent", optionalClerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Parse and validate body
  const body = await c.req.json();
  const parsed = paymentIntentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, offer_id, referral_code, voucher_id, buyer_note } = parsed.data;
  let buyer_email = parsed.data.buyer_email;

  // Resolve buyer identity
  let buyerProfileId: string | null = null;
  if (clerkUserId) {
    const profile = await getProfileByClerkId(clerkUserId);
    if (profile) {
      buyerProfileId = profile.id;
    }
  }

  // Guest must provide email
  if (!clerkUserId && !buyer_email) {
    return c.json(
      { error: "buyer_email is required for guest checkout" },
      400
    );
  }

  // If authenticated but no email provided, we'll use a placeholder
  // (Stripe receipt_email is optional; Clerk manages the user's email)
  if (!buyer_email) {
    buyer_email = ""; // Will be omitted from receipt_email if empty
  }

  // Validate listing exists and is purchasable
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, title, seller_id, price_amount, price_currency, status, negotiable, shipping_cost_amount, free_shipping")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // Listing must be active or reserved (reserved = accepted offer)
  if (listing.status !== "active" && listing.status !== "reserved") {
    return c.json(
      { error: `Listing is not available for purchase (status: ${listing.status})` },
      400
    );
  }

  // Prevent seller from buying their own listing
  if (buyerProfileId && buyerProfileId === listing.seller_id) {
    return c.json({ error: "You cannot buy your own listing" }, 400);
  }

  // Validate referral_code if provided
  if (referral_code) {
    const normalizedCode = referral_code.toUpperCase().trim();
    const { data: codeRow } = await supabase
      .from("referral_codes")
      .select("id, user_id, disabled")
      .eq("code", normalizedCode)
      .single();
    if (!codeRow || codeRow.disabled) {
      return c.json({ error: "Invalid or disabled referral code" }, 400);
    }
    if (buyerProfileId && codeRow.user_id === buyerProfileId) {
      return c.json({ error: "You cannot use your own referral code" }, 400);
    }
  }

  // Validate voucher_id if provided
  if (voucher_id && buyerProfileId) {
    const { data: voucher } = await supabase
      .from("referral_vouchers")
      .select("id, user_id, status")
      .eq("id", voucher_id)
      .single();
    if (!voucher || voucher.user_id !== buyerProfileId || voucher.status !== "available") {
      return c.json({ error: "Invalid or already used voucher" }, 400);
    }
  }

  // Determine payment amount (offer amount or listing price)
  let paymentAmount = listing.price_amount;
  if (offer_id) {
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .select("id, amount, status, buyer_id, listing_id")
      .eq("id", offer_id)
      .single();
    if (offerError || !offer) return c.json({ error: "Offer not found" }, 404);
    if (offer.status !== "accepted") return c.json({ error: `Offer not accepted (status: ${offer.status})` }, 400);
    if (offer.listing_id !== listing_id) return c.json({ error: "Offer does not belong to this listing" }, 400);
    if (buyerProfileId && offer.buyer_id !== buyerProfileId) return c.json({ error: "Offer belongs to different buyer" }, 403);
    paymentAmount = offer.amount;
  }

  // Look up seller's Stripe account and payout method
  const { data: sellerProfile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete, payout_method")
    .eq("id", listing.seller_id)
    .single();

  const sellerStripeAccountId = sellerProfile?.stripe_account_id || null;
  const sellerOnboardingComplete = sellerProfile?.stripe_onboarding_complete ?? false;

  // Item amount = either offer amount or listing price (negotiated price excludes shipping).
  // Shipping is added on top, charged to the buyer, and passes through to the seller.
  const itemAmount = paymentAmount; // already in cents
  const shippingAmount = (listing.free_shipping ? 0 : (listing.shipping_cost_amount as number | null) ?? 0);

  // Commission is computed on the ITEM only — shipping is not Kifaayat's revenue,
  // it's a passthrough so the seller can pay for postage.
  const commissionRate = await getSellerCommissionRate(listing.seller_id);
  const commission = Math.round(itemAmount * commissionRate / 100);

  // Seller payout — UNCHANGED by voucher. Seller always gets the full
  // item-minus-commission + shipping. Vouchers come out of Kifaayat's cut,
  // never the seller's.
  const sellerPayout = itemAmount - commission + shippingAmount;

  // Voucher discount — applied to item only, never shipping. No cap; on
  // tier sellers with a commission below VOUCHER_DISCOUNT_RATE, Kifaayat
  // absorbs the small loss as acquisition cost.
  const voucherDiscount = voucher_id
    ? Math.round(itemAmount * VOUCHER_DISCOUNT_RATE / 100)
    : 0;

  // What Stripe actually charges the buyer.
  const chargeAmount = itemAmount + shippingAmount - voucherDiscount;

  // Build PaymentIntent params
  const intentParams: Stripe.PaymentIntentCreateParams = {
    amount: chargeAmount,
    currency: listing.price_currency.toLowerCase(),
    metadata: {
      listing_id,
      buyer_email: buyer_email || "",
      buyer_profile_id: buyerProfileId || "",
      offer_id: offer_id || "",
      referral_code: referral_code ? referral_code.toUpperCase().trim() : "",
      voucher_id: voucher_id || "",
      // Pre-computed split so the webhook doesn't have to re-derive these.
      item_amount: String(itemAmount),
      shipping_amount: String(shippingAmount),
      commission_amount: String(commission),
      seller_payout: String(sellerPayout),
      voucher_discount: String(voucherDiscount),
      // Optional buyer-to-seller note shown on the seller's order detail.
      // Stripe metadata values must be strings; empty string = no note.
      buyer_note: buyer_note || "",
    },
  };

  // Add receipt_email if we have one
  if (buyer_email) {
    intentParams.receipt_email = buyer_email;
  }

  // Determine payout routing based on seller's chosen method
  const sellerPayoutMethod: string | null = sellerProfile?.payout_method ?? null;

  if (sellerStripeAccountId && sellerOnboardingComplete) {
    // Direct Stripe payouts via destination charges
    intentParams.application_fee_amount = commission;
    intentParams.transfer_data = {
      destination: sellerStripeAccountId,
    };
  } else if (sellerPayoutMethod === "kifaayat_wallet") {
    // Platform-managed: payment goes to Kifaayat's account, tracked for later payout
    intentParams.metadata!.payout_method = "kifaayat_wallet";
    intentParams.metadata!.seller_id = listing.seller_id;
    intentParams.metadata!.commission_amount = String(commission);
  } else {
    return c.json({ error: "This seller has not completed payment setup. Please contact the seller." }, 400);
  }

  try {
    const paymentIntent = await getStripe().paymentIntents.create(intentParams);

    return c.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("Error creating payment intent:", error);
    return c.json({ error: "Failed to create payment intent" }, 500);
  }
});

/**
 * POST /api/stripe/create-account
 * Create a Stripe Express account for the seller. Idempotent -- returns existing if present.
 */
stripeRoutes.post("/create-account", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");

  // If already has a Stripe account, return it
  if (profile.stripe_account_id) {
    return c.json({ account_id: profile.stripe_account_id });
  }

  try {
    // Create Stripe Express account
    const account = await getStripe().accounts.create({
      type: "express",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: {
        kifaayat_profile_id: profile.id,
      },
    });

    // Store account ID in profile
    const supabase = createSupabaseAdmin();
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ stripe_account_id: account.id })
      .eq("id", profile.id);

    if (updateError) {
      console.error("Error storing Stripe account ID:", updateError);
      return c.json({ error: "Failed to save Stripe account" }, 500);
    }

    return c.json({ account_id: account.id }, 201);
  } catch (error) {
    console.error("Error creating Stripe account:", error);
    return c.json({ error: "Failed to create Stripe account" }, 500);
  }
});

/**
 * GET /api/stripe/onboarding-url
 * Generate a Stripe AccountLink URL for the seller to complete onboarding.
 */
stripeRoutes.get("/onboarding-url", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");

  if (!profile.stripe_account_id) {
    return c.json({ error: "Create account first" }, 400);
  }

  const apiUrl =
    process.env.API_URL || process.env.BACKEND_URL || "http://localhost:3001";

  try {
    const accountLink = await getStripe().accountLinks.create({
      account: profile.stripe_account_id,
      refresh_url: `${apiUrl}/api/stripe/onboarding-refresh`,
      return_url: `${apiUrl}/api/stripe/onboarding-return`,
      type: "account_onboarding",
    });

    return c.json({
      url: accountLink.url,
      account_id: profile.stripe_account_id,
    });
  } catch (error) {
    console.error("Error creating onboarding link:", error);
    return c.json({ error: "Failed to generate onboarding URL" }, 500);
  }
});

/**
 * GET /api/stripe/onboarding-return
 * Redirect target after successful Stripe onboarding. No auth required.
 */
stripeRoutes.get("/onboarding-return", (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stripe Setup Complete</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;max-width:400px}
h1{color:#059669;font-size:1.5rem}p{color:#6b7280;margin-top:0.5rem}</style></head>
<body><div class="card">
<h1>Stripe Setup Complete!</h1>
<p>You can close this window and return to the app.</p>
</div></body></html>`);
});

/**
 * GET /api/stripe/onboarding-refresh
 * Redirect target when Stripe session expires. No auth required.
 */
stripeRoutes.get("/onboarding-refresh", (c) => {
  return c.html(`<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Expired</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{text-align:center;padding:2rem;max-width:400px}
h1{color:#d97706;font-size:1.5rem}p{color:#6b7280;margin-top:0.5rem}</style></head>
<body><div class="card">
<h1>Session Expired</h1>
<p>Please try again from the app.</p>
</div></body></html>`);
});

/**
 * GET /api/stripe/account-status
 * Return the seller's Stripe account verification status.
 */
stripeRoutes.get("/account-status", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const payoutMethod: string | null = profile.payout_method ?? null;

  if (!profile.stripe_account_id) {
    const response = {
      status: "not_connected" as const,
      account_id: null,
      charges_enabled: false,
      payouts_enabled: false,
      payout_method: payoutMethod,
      payout_ready: payoutMethod === "kifaayat_wallet",
    };
    return c.json(response);
  }

  try {
    const account = await getStripe().accounts.retrieve(
      profile.stripe_account_id
    );

    const status = mapAccountToStatus(account);
    const stripeVerified = status === "verified";

    const response = {
      status,
      account_id: profile.stripe_account_id,
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
      payout_method: payoutMethod,
      payout_ready: stripeVerified || payoutMethod === "kifaayat_wallet",
    };

    return c.json(response);
  } catch (error) {
    console.error("Error retrieving Stripe account:", error);
    return c.json({ error: "Failed to fetch account status" }, 500);
  }
});

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhook events. No auth -- uses Stripe signature verification.
 */
stripeRoutes.post("/webhook", async (c) => {
  const sig = c.req.header("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig) {
    return c.json({ error: "Missing stripe-signature header" }, 400);
  }

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  // Get raw body for signature verification
  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (error) {
    console.error("Webhook signature verification failed:", error);
    return c.json({ error: "Invalid signature" }, 400);
  }

  logger.info("stripe.webhook_received", { event_type: event.type, event_id: event.id });

  const supabase = createSupabaseAdmin();

  // Handle account.updated event (Stripe Connect onboarding)
  if (event.type === "account.updated") {
    const account = event.data.object as Stripe.Account;

    const stripeOnboardingComplete =
      (account.charges_enabled ?? false) &&
      (account.payouts_enabled ?? false);

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ stripe_onboarding_complete: stripeOnboardingComplete })
      .eq("stripe_account_id", account.id);

    if (updateError) {
      console.error("Error updating profile from webhook:", updateError);
      // Still return 200 to avoid Stripe retries for DB errors
    }
  }

  // Handle payment_intent.succeeded — create order(s), transition listing(s), notify seller(s)
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const metadata = paymentIntent.metadata;

    logger.info("stripe.payment_intent_succeeded", {
      payment_intent_id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      checkout_type: metadata.checkout_type || "single_item",
      buyer_email: metadata.buyer_email || null,
      buyer_profile_id: metadata.buyer_profile_id || null,
      listing_id: metadata.listing_id || null,
      offer_id: metadata.offer_id || null,
    });

    // --- BOOST CHECKOUT ---
    if (metadata.checkout_type === "boost") {
      const boostListingId = metadata.listing_id;
      const sellerProfileId = metadata.seller_profile_id;

      if (!boostListingId) {
        console.error("Boost payment missing listing_id in metadata");
        return c.json({ received: true });
      }

      logger.info("stripe.boost_payment_processing", { listing_id: boostListingId, seller_profile_id: sellerProfileId });

      // Fetch boost duration from admin_settings
      const { data: boostSettings } = await supabase
        .from("admin_settings")
        .select("boost_duration_days")
        .limit(1)
        .single();
      const boostDurationDays = boostSettings?.boost_duration_days ?? 7;

      // Check for existing active boost to extend
      const { data: existingBoost } = await supabase
        .from("listing_boosts")
        .select("id, ends_at")
        .eq("listing_id", boostListingId)
        .eq("status", "active")
        .gt("ends_at", new Date().toISOString())
        .limit(1)
        .single();

      if (existingBoost) {
        // Extend existing boost
        const newEndsAt = new Date(
          new Date(existingBoost.ends_at).getTime() + boostDurationDays * 86400000
        ).toISOString();
        await supabase
          .from("listing_boosts")
          .update({ ends_at: newEndsAt })
          .eq("id", existingBoost.id);
        // Cancel any pending boosts for this listing
        await supabase
          .from("listing_boosts")
          .update({ status: "cancelled" })
          .eq("listing_id", boostListingId)
          .eq("status", "pending");
      } else {
        // Activate the pending boost
        await supabase
          .from("listing_boosts")
          .update({ status: "active" })
          .eq("listing_id", boostListingId)
          .eq("status", "pending");
      }

      // Send boost_activated notification
      if (sellerProfileId) {
        await createNotification({
          user_id: sellerProfileId,
          type: "boost_activated",
          title: "Boost Activated",
          body: "Your listing boost is now active! It will appear at the top of search results.",
          // Boosts are a seller-only action.
          data: { listing_id: boostListingId, role: "seller" },
        });
      }

      return c.json({ received: true });
    }

    // --- CART CHECKOUT ---
    if (metadata.checkout_type === "cart") {
      const cartCheckoutId = metadata.cart_checkout_id;
      const buyerProfileId = metadata.buyer_profile_id;
      const currency = paymentIntent.currency.toUpperCase();

      logger.info("stripe.cart_checkout_processing", {
        cart_checkout_id: cartCheckoutId,
        buyer_profile_id: buyerProfileId,
        currency,
        amount: paymentIntent.amount,
      });

      let sellerGroups: Array<{
        seller_id: string;
        stripe_account_id: string;
        items_subtotal: number;
        shipping_total: number;
        commission_amount: number;
        commission_rate: number;
        seller_payout: number;
        listing_ids: string[];
      }>;

      try {
        sellerGroups = JSON.parse(metadata.seller_groups);
      } catch (parseError) {
        console.error("Failed to parse seller_groups metadata:", parseError);
        return c.json({ received: true });
      }

      const cartSellerDeadlineAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

      for (const group of sellerGroups) {
        // 1. Create order for this seller group
        const orderNumber = generateOrderNumber();
        const groupTotal = group.items_subtotal + group.shipping_total;

        logger.info("stripe.cart_order_creating", {
          order_number: orderNumber,
          seller_id: group.seller_id,
          listing_ids: group.listing_ids,
          group_total: groupTotal,
          seller_payout: group.seller_payout,
          commission_amount: group.commission_amount,
        });

        const { data: order, error: orderError } = await supabase
          .from("orders")
          .insert({
            order_number: orderNumber,
            listing_id: group.listing_ids[0], // primary listing
            buyer_id: buyerProfileId || null,
            seller_id: group.seller_id,
            amount: groupTotal,
            currency,
            commission_rate: group.commission_rate,
            commission_amount: group.commission_amount,
            seller_payout: group.seller_payout,
            buyer_email: metadata.buyer_email || "",
            stripe_payment_intent_id: paymentIntent.id,
            status: "paid" as OrderStatus,
            seller_deadline_at: cartSellerDeadlineAt.toISOString(),
          })
          .select()
          .single();

        if (orderError) {
          console.error(
            `Error creating order for seller ${group.seller_id}:`,
            orderError
          );
          continue;
        }

        logger.info("stripe.cart_order_created", {
          order_id: order?.id,
          order_number: orderNumber,
          seller_id: group.seller_id,
        });

        // 2. Mark all group listings as 'reserved' (seller must accept before shipping)
        await supabase
          .from("listings")
          .update({ status: "reserved" })
          .in("id", group.listing_ids);

        logger.info("stripe.listings_marked_reserved", { listing_ids: group.listing_ids });

        // 3. Create Stripe Transfer to seller
        if (group.stripe_account_id) {
          try {
            logger.info("stripe.transfer_creating", {
              seller_id: group.seller_id,
              stripe_account_id: group.stripe_account_id,
              payout_amount: group.seller_payout,
              currency,
            });
            await getStripe().transfers.create({
              amount: group.seller_payout,
              currency: currency.toLowerCase(),
              destination: group.stripe_account_id,
              transfer_group: `cart_${cartCheckoutId}`,
              metadata: {
                order_number: orderNumber,
                seller_id: group.seller_id,
              },
            });
            logger.info("stripe.transfer_created", { seller_id: group.seller_id, order_number: orderNumber });
          } catch (transferError) {
            console.error(
              `Transfer failed for seller ${group.seller_id}:`,
              transferError
            );
            // Payment already collected -- log for manual resolution
          }
        }

        // 4. Send notification to seller + enqueue auto-reject job
        if (order) {
          const paidTemplate = orderPaidNotification(
            `Order #${orderNumber}`,
            groupTotal,
            currency,
            group.seller_payout
          );
          await createNotification({
            user_id: group.seller_id,
            type: "order_paid",
            ...paidTemplate,
            data: { order_id: order.id, role: "seller" },
          });

          enqueueDelayed(JOB_AUTO_REJECT_ORDER, { orderId: order.id }, 48 * 60 * 60).catch(
            (err) => console.error("Failed to enqueue cart auto-reject job:", err)
          );
        }
      }

      // 5. Clear buyer's cart
      if (buyerProfileId) {
        await supabase
          .from("cart_items")
          .delete()
          .eq("user_id", buyerProfileId);
      }

      // 6. Redeem credits if any were applied
      const creditApplied = parseInt(metadata.credit_applied || "0", 10);
      if (creditApplied > 0 && buyerProfileId) {
        await redeemCredits(buyerProfileId, creditApplied).catch((err) => {
          console.error("Error redeeming credits in cart webhook:", err);
        });
      }

      return c.json({ received: true });
    }

    // --- EXISTING SINGLE-ITEM LOGIC (unchanged) ---
    const listingId = metadata.listing_id;
    const buyerEmail = metadata.buyer_email || "";
    const buyerProfileId = metadata.buyer_profile_id || null;
    const offerId = metadata.offer_id || null;

    if (!listingId) {
      console.error("payment_intent.succeeded missing listing_id in metadata");
      return c.json({ received: true });
    }

    logger.info("stripe.single_item_checkout_processing", {
      payment_intent_id: paymentIntent.id,
      listing_id: listingId,
      buyer_email: buyerEmail,
      buyer_profile_id: buyerProfileId,
      offer_id: offerId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
    });

    // Fetch listing for seller_id, title, and shipping cost
    const { data: listing } = await supabase
      .from("listings")
      .select("id, seller_id, title, shipping_cost_amount")
      .eq("id", listingId)
      .single();

    if (!listing) {
      console.error(`Listing ${listingId} not found for payment ${paymentIntent.id}`);
      return c.json({ received: true });
    }

    logger.info("stripe.single_item_listing_found", {
      listing_id: listing.id,
      seller_id: listing.seller_id,
      title: listing.title,
    });

    // Total charged includes both the item price and shipping. Commission is
    // computed on the ITEM portion only — shipping is a passthrough so the
    // seller can cover postage. The split is pre-computed in metadata at
    // payment-intent creation time; we trust it here rather than re-deriving.
    // Fallbacks keep older payment intents (before this change shipped)
    // working: if metadata.item_amount is missing, the whole amount is
    // treated as item amount and shipping is zero.
    const amount = paymentIntent.amount; // total charged to buyer (post-voucher)
    const currency = paymentIntent.currency.toUpperCase();
    const commissionRate = await getSellerCommissionRate(listing.seller_id);
    const itemAmount = parseInt(metadata.item_amount || String(amount), 10);
    const shippingAmount = parseInt(metadata.shipping_amount || "0", 10);
    const voucherDiscount = parseInt(metadata.voucher_discount || "0", 10);
    const commissionAmount = metadata.commission_amount
      ? parseInt(metadata.commission_amount, 10)
      : Math.round(itemAmount * (commissionRate / 100));
    // Seller payout is UNCHANGED by voucher — they get item-net + shipping.
    // Voucher comes out of Kifaayat's net (commission - voucher_discount).
    const sellerPayout = metadata.seller_payout
      ? parseInt(metadata.seller_payout, 10)
      : itemAmount - commissionAmount + shippingAmount;
    // Optional buyer note from checkout. Empty string in metadata = no note.
    const buyerNote = metadata.buyer_note ? metadata.buyer_note : null;

    logger.info("stripe.single_item_commission_calculated", {
      amount,
      item_amount: itemAmount,
      shipping_amount: shippingAmount,
      voucher_discount: voucherDiscount,
      currency,
      commission_rate: commissionRate,
      commission_amount: commissionAmount,
      seller_payout: sellerPayout,
    });

    // Generate order number
    const orderNumber = generateOrderNumber();

    logger.info("stripe.single_item_order_creating", {
      order_number: orderNumber,
      listing_id: listingId,
      seller_id: listing.seller_id,
      offer_id: offerId,
    });

    // Seller has 48h to accept; enqueue auto-reject job at that deadline
    const sellerDeadlineAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Create order
    const { data: order, error: insertError } = await supabase
      .from("orders")
      .insert({
        order_number: orderNumber,
        listing_id: listingId,
        buyer_id: buyerProfileId || null,
        seller_id: listing.seller_id,
        buyer_email: buyerEmail,
        offer_id: offerId,
        amount,
        item_amount: itemAmount,
        shipping_amount: shippingAmount,
        voucher_discount: voucherDiscount,
        buyer_note: buyerNote,
        currency,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        seller_payout: sellerPayout,
        stripe_payment_intent_id: paymentIntent.id,
        status: "paid" as OrderStatus,
        seller_deadline_at: sellerDeadlineAt.toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error("Error creating order from webhook:", insertError);
      return c.json({ received: true });
    }

    logger.info("stripe.single_item_order_created", {
      order_id: order?.id,
      order_number: orderNumber,
      listing_id: listingId,
      seller_id: listing.seller_id,
    });

    // Transition listing to 'reserved' (seller must accept before shipping)
    await supabase
      .from("listings")
      .update({ status: "reserved" })
      .eq("id", listingId);

    logger.info("stripe.listing_marked_reserved", { listing_id: listingId });

    // Enqueue delayed auto-reject job (fires in 48h if seller hasn't responded)
    if (order) {
      enqueueDelayed(JOB_AUTO_REJECT_ORDER, { orderId: order.id }, 48 * 60 * 60).catch(
        (err) => console.error("Failed to enqueue auto-reject job:", err)
      );
    }

    // If offer_id, mark offer as completed
    if (offerId) {
      await supabase
        .from("offers")
        .update({ status: "completed" })
        .eq("id", offerId);
      logger.info("stripe.offer_marked_completed", { offer_id: offerId });
    }

    // Create notification for seller
    const shippingCost = (listing.shipping_cost_amount as number) || 0;
    const paidTemplate = orderPaidNotification(listing.title, amount, currency, sellerPayout, shippingCost);
    await createNotification({
      user_id: listing.seller_id,
      type: "order_paid",
      ...paidTemplate,
      data: { listing_id: listingId, order_id: order.id, role: "seller" },
    });

    // Record referral and award voucher to referrer if a referral code was used
    const referralCode = metadata.referral_code;
    if (referralCode && buyerProfileId) {
      await recordReferralAndAwardVoucher({
        supabase,
        referralCode,
        buyerId: buyerProfileId,
        orderId: order.id,
      }).catch((err: unknown) => console.error("Error recording referral:", err));
    }

    // Mark voucher as used if buyer applied one
    const usedVoucherId = metadata.voucher_id;
    if (usedVoucherId) {
      await supabase
        .from("referral_vouchers")
        .update({ status: "used", used_order_id: order.id, used_at: new Date().toISOString() })
        .eq("id", usedVoucherId)
        .eq("status", "available");
    }
  }

  // Handle payment_intent.payment_failed — log for debugging, no action needed
  if (event.type === "payment_intent.payment_failed") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    logger.error("stripe.payment_failed", {
      payment_intent_id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      error_code: paymentIntent.last_payment_error?.code || null,
      error_message: paymentIntent.last_payment_error?.message || "Unknown error",
      buyer_email: paymentIntent.metadata?.buyer_email || null,
      listing_id: paymentIntent.metadata?.listing_id || null,
    });
  }

  return c.json({ received: true });
});

export default stripeRoutes;
