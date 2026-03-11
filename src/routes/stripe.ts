import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { createNotification, orderPaidNotification } from "../lib/notifications.js";
import {
  generateOrderNumber,
  type OrderStatus,
} from "../types/transactions.js";
import { getCommissionRate } from "../lib/commission.js";
import type { StripeAccountStatus, StripeStatusResponse } from "../types/stripe.js";

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

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
});

// ============================================================
// Helpers
// ============================================================

/**
 * Look up the profile for a given Clerk user ID.
 * Returns profile id, stripe_account_id, stripe_onboarding_complete, and email-relevant fields.
 */
async function getProfileByClerkId(clerkUserId: string) {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, stripe_account_id, stripe_onboarding_complete")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return null;
  return data as {
    id: string;
    stripe_account_id: string | null;
    stripe_onboarding_complete: boolean;
  };
}

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

  const { listing_id, offer_id } = parsed.data;
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
    .select("id, title, seller_id, price_amount, price_currency, status, negotiable")
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

  // Look up seller's Stripe account
  const { data: sellerProfile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", listing.seller_id)
    .single();

  const sellerStripeAccountId = sellerProfile?.stripe_account_id || null;
  const sellerOnboardingComplete = sellerProfile?.stripe_onboarding_complete ?? false;

  // Calculate commission
  const amount = paymentAmount; // already in cents
  const commissionRate = await getCommissionRate();
  const commission = Math.round(amount * commissionRate / 100);

  // Build PaymentIntent params
  const intentParams: Stripe.PaymentIntentCreateParams = {
    amount,
    currency: listing.price_currency.toLowerCase(),
    metadata: {
      listing_id,
      buyer_email: buyer_email || "",
      buyer_profile_id: buyerProfileId || "",
      offer_id: offer_id || "",
    },
  };

  // Add receipt_email if we have one
  if (buyer_email) {
    intentParams.receipt_email = buyer_email;
  }

  // Use Destination Charges if seller has a connected, verified Stripe account
  if (sellerStripeAccountId && sellerOnboardingComplete) {
    intentParams.application_fee_amount = commission;
    intentParams.transfer_data = {
      destination: sellerStripeAccountId,
    };
  }
  if (!sellerStripeAccountId || !sellerOnboardingComplete) {
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
stripeRoutes.post("/create-account", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

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
stripeRoutes.get("/onboarding-url", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

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
stripeRoutes.get("/account-status", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  if (!profile.stripe_account_id) {
    const response: StripeStatusResponse = {
      status: "not_connected",
      account_id: null,
      charges_enabled: false,
      payouts_enabled: false,
    };
    return c.json(response);
  }

  try {
    const account = await getStripe().accounts.retrieve(
      profile.stripe_account_id
    );

    const status = mapAccountToStatus(account);

    const response: StripeStatusResponse = {
      status,
      account_id: profile.stripe_account_id,
      charges_enabled: account.charges_enabled ?? false,
      payouts_enabled: account.payouts_enabled ?? false,
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

  // Handle payment_intent.succeeded — create order, transition listing, notify seller
  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const metadata = paymentIntent.metadata;

    const listingId = metadata.listing_id;
    const buyerEmail = metadata.buyer_email || "";
    const buyerProfileId = metadata.buyer_profile_id || null;
    const offerId = metadata.offer_id || null;

    if (!listingId) {
      console.error("payment_intent.succeeded missing listing_id in metadata");
      return c.json({ received: true });
    }

    // Fetch listing for seller_id and title
    const { data: listing } = await supabase
      .from("listings")
      .select("id, seller_id, title")
      .eq("id", listingId)
      .single();

    if (!listing) {
      console.error(`Listing ${listingId} not found for payment ${paymentIntent.id}`);
      return c.json({ received: true });
    }

    // Calculate commission
    const amount = paymentIntent.amount;
    const currency = paymentIntent.currency.toUpperCase();
    const commissionRate = await getCommissionRate();
    const commissionAmount = Math.round(amount * (commissionRate / 100));
    const sellerPayout = amount - commissionAmount;

    // Generate order number
    const orderNumber = generateOrderNumber();

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
        currency,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        seller_payout: sellerPayout,
        stripe_payment_intent_id: paymentIntent.id,
        status: "paid" as OrderStatus,
      })
      .select()
      .single();

    if (insertError) {
      console.error("Error creating order from webhook:", insertError);
      return c.json({ received: true });
    }

    // Transition listing to 'sold'
    await supabase
      .from("listings")
      .update({ status: "sold" })
      .eq("id", listingId);

    // If offer_id, mark offer as completed
    if (offerId) {
      await supabase
        .from("offers")
        .update({ status: "completed" })
        .eq("id", offerId);
    }

    // Create notification for seller
    const paidTemplate = orderPaidNotification(listing.title, amount, currency, sellerPayout);
    await createNotification({
      user_id: listing.seller_id,
      type: "order_paid",
      ...paidTemplate,
      data: { listing_id: listingId, order_id: order.id },
    });
  }

  // Handle payment_intent.payment_failed — log for debugging, no action needed
  if (event.type === "payment_intent.payment_failed") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    console.error(
      `Payment failed for intent ${paymentIntent.id}:`,
      paymentIntent.last_payment_error?.message || "Unknown error"
    );
  }

  return c.json({ received: true });
});

export default stripeRoutes;
