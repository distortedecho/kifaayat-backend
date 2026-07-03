// ============================================================
// Stripe service (Phase 2.8)
//
// Narrow extraction for Stripe Connect seller onboarding. The
// payment-intent + webhook handlers in routes/stripe.ts are tightly
// coupled to Hono request objects (raw body, signature header) and
// would require substantial adaptation to live in the service layer;
// they stay in the route file for now. This module exposes the
// reusable pieces: a singleton Stripe client and the "create
// Express account" helper that's otherwise duplicated logic.
// ============================================================

import Stripe from "stripe";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

/**
 * Idempotent: returns the existing customer id if the profile already
 * has one, otherwise creates a new Stripe Customer and persists the id.
 *
 * Created lazily on first checkout — not at signup — so users who only
 * browse never get a Customer record in Stripe (saves on Stripe-side
 * object count and keeps free-tier accounts clean). Email + display_name
 * are passed for Stripe dashboard searchability; profile_id metadata
 * lets us trace from Stripe back to our DB when debugging.
 */
export async function getOrCreateStripeCustomer(profile: {
  id: string;
  stripe_customer_id?: string | null;
  display_name?: string | null;
  email?: string | null;
}): Promise<string> {
  if (profile.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.create({
    email: profile.email ?? undefined,
    name: profile.display_name ?? undefined,
    metadata: { kifaayat_profile_id: profile.id },
  });

  const supabase = createSupabaseAdmin();
  const { error: updateError } = await supabase
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", profile.id);

  if (updateError) {
    logger.error("stripeService.store_customer_failed", {
      profile_id: profile.id,
      error: updateError.message,
    });
    // Stripe customer was already created at this point. Not fatal —
    // the worst case is one orphan customer in Stripe; next call will
    // create another. Surface as 500 so the checkout retries.
    throw new StripeServiceError("Failed to save Stripe customer", 500);
  }

  return customer.id;
}

export class StripeServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "StripeServiceError";
  }
}

/**
 * Validate a profile.location value as an ISO 3166-1 alpha-2 country
 * code Stripe accepts when creating a Connect account. We now store
 * the same codes Stripe uses (AU / US / NZ / CA / GB), so this is
 * essentially a passthrough — but we still validate so a typo in the
 * profile can never silently default Stripe to the platform country
 * (which previously gave UK sellers an Australian onboarding form).
 * Returns null if location is unset or outside our supported markets.
 */
export function profileLocationToStripeCountry(
  location: string | null
): string | null {
  if (!location) return null;
  const supported = new Set(["AU", "US", "NZ", "CA", "GB"]);
  const upper = location.toUpperCase();
  return supported.has(upper) ? upper : null;
}

/**
 * Create (or return existing) Stripe Express connected account for
 * a seller profile, persisting the account id on the profile row.
 */
export async function createExpressAccount(profile: {
  id: string;
  stripe_account_id?: string | null;
  location?: string | null;
}): Promise<string> {
  if (profile.stripe_account_id) {
    return profile.stripe_account_id;
  }

  const country = profileLocationToStripeCountry(profile.location ?? null);
  if (!country) {
    throw new StripeServiceError(
      "Set your country in profile before connecting Stripe",
      400
    );
  }

  const stripe = getStripeClient();
  const account = await stripe.accounts.create({
    type: "express",
    country,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    // Manual payout schedule = escrow. We charge on behalf of the seller
    // (destination charge), so buyer funds settle into the seller's Stripe
    // balance immediately — but with a manual schedule they can't reach the
    // seller's bank until we trigger the payout on delivery. This also keeps
    // the funds clawable (reverse_transfer) for refunds before release.
    settings: {
      payouts: { schedule: { interval: "manual" } },
    },
    metadata: {
      kifaayat_profile_id: profile.id,
    },
  });

  const supabase = createSupabaseAdmin();
  const { error: updateError } = await supabase
    .from("profiles")
    .update({ stripe_account_id: account.id })
    .eq("id", profile.id);
  if (updateError) {
    logger.error("stripeService.store_account_failed", {
      profile_id: profile.id,
      error: updateError.message,
    });
    throw new StripeServiceError("Failed to save Stripe account", 500);
  }

  return account.id;
}

/**
 * Create an account-link onboarding URL for a seller to finish
 * Express onboarding.
 */
export async function createOnboardingLink(
  stripeAccountId: string
): Promise<string> {
  const apiUrl =
    process.env.API_URL || process.env.BACKEND_URL || "http://localhost:3001";
  const stripe = getStripeClient();
  const accountLink = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${apiUrl}/api/stripe/onboarding-refresh`,
    return_url: `${apiUrl}/api/stripe/onboarding-return`,
    type: "account_onboarding",
  });
  return accountLink.url;
}
