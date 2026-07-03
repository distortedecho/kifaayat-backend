import { Hono } from "hono";
import { z } from "zod";
import crypto from "node:crypto";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  ensureProfile,
  fetchClerkContactInfo,
} from "../lib/profileProvisioning.js";
import {
  getStripeClient,
  getOrCreateStripeCustomer,
  createExpressAccount,
  StripeServiceError,
} from "../services/stripeService.js";

const profiles = new Hono();

/**
 * Follower / following counts attached to GET /api/profiles/me so the
 * profile screen can render them in one round-trip. Other stats
 * (avg_rating, listing_count, sold_count) already live on dedicated
 * endpoints the frontend calls separately — don't duplicate them here.
 */
async function fetchFollowCounts(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  userId: string
): Promise<{ follower_count: number; following_count: number }> {
  const [{ count: followerCount }, { count: followingCount }] = await Promise.all([
    supabase
      .from("seller_follows")
      .select("id", { count: "exact", head: true })
      .eq("seller_id", userId),
    supabase
      .from("seller_follows")
      .select("id", { count: "exact", head: true })
      .eq("follower_id", userId),
  ]);
  return {
    follower_count: followerCount || 0,
    following_count: followingCount || 0,
  };
}

// Zod schema for profile updates
const updateProfileSchema = z.object({
  display_name: z
    .string()
    .max(50, "Display name must be 50 characters or less")
    .optional(),
  avatar_url: z.string().url("Must be a valid URL").nullable().optional(),
  location: z.enum(["AU", "US", "NZ", "CA", "GB"]).optional(),
  currency: z.enum(["AUD", "USD", "NZD", "CAD", "GBP"]).optional(),
  size_preferences: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      garment_length: z.string().optional(),
      sleeve_length: z.string().optional(),
      clothing_size: z.string().optional(),
      // Single free-form string (e.g. "5'7\"") matching how listings
      // store measurements.height. FE keeps reading legacy
      // height_ft/height_in from old saves for backward compatibility,
      // but new writes go through this single key.
      height: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(
      z.enum([
        "Wedding",
        "Mehendi",
        "Sangeet",
        "Festive",
        "Party",
        "Formal",
        "Casual",
      ])
    )
    .optional(),
  onesignal_player_id: z.string().optional(),
  user_intents: z.array(z.enum(["buy", "sell"])).optional(),
  wishlist_public: z.boolean().optional(),
  // Toggles AI-powered listing help (description/category suggestions,
  // background removal etc.). Default TRUE; gating happens on the FE
  // (hides AI assist buttons when off) — backend AI endpoints aren't
  // server-side gated.
  ai_assist_enabled: z.boolean().optional(),
  // payout_method is no longer settable via the generic /me PUT — it now
  // has its own endpoint that takes method-specific details (PUT /me/payout-method).
  bio: z.string().max(500).nullish(),
  // Optional contact phone. Loose validation — accept E.164, local, or anything
  // up to 32 chars. Frontend can do per-country format hints if needed.
  phone: z.string().max(32).nullish(),
});

/**
 * GET /api/profiles/me
 * Returns the current user's profile. Creates one if it doesn't exist.
 */
profiles.get("/me", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Ensure a profile exists (find → claim legacy → create fresh). This is
  // the SAME provisioning path requireProfile uses, so whichever
  // authenticated request lands first provisions the row — no signup race.
  const result = await ensureProfile(clerkUserId);
  if (!result) {
    return c.json({ error: "Failed to fetch profile" }, 500);
  }
  const { profile, status } = result;

  // For an already-existing row, write-through sync verified Clerk
  // email/phone in case the user changed them since our last write. Clerk
  // is the source of truth; we never trust the FE to PATCH these (they'd be
  // unverified at our layer). Best-effort; failures don't block the GET.
  if (status === "existing") {
    try {
      const { email: clerkEmail, phone: clerkPhone } =
        await fetchClerkContactInfo(clerkUserId);
      const updates: Record<string, string | null> = {};
      const currentPhone = (profile.phone as string | null) || null;
      const currentEmail = (profile.email as string | null) || "";
      if (clerkPhone && clerkPhone !== currentPhone) {
        updates.phone = clerkPhone;
      }
      if (clerkEmail && clerkEmail.toLowerCase() !== currentEmail.toLowerCase()) {
        updates.email = clerkEmail;
      }
      if (Object.keys(updates).length > 0) {
        await supabase
          .from("profiles")
          .update(updates)
          .eq("id", profile.id as string);
        Object.assign(profile, updates);
      }
    } catch (err) {
      console.warn("[profiles GET /me] Clerk sync failed (non-fatal):", err);
    }
  }

  // A just-created profile has no followers yet — skip the round-trip.
  const counts =
    status === "created"
      ? { follower_count: 0, following_count: 0 }
      : await fetchFollowCounts(supabase, profile.id as string);

  return c.json(
    { profile: { ...profile, ...counts } },
    status === "created" ? 201 : 200
  );
});

/**
 * PUT /api/profiles/me
 * Updates the current user's profile fields.
 */
profiles.put("/me", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Parse and validate request body
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const updateData = parsed.data;

  // Keep currency in lockstep with country. When the user changes their
  // location and doesn't explicitly send a currency, derive it from the
  // new country (AU→AUD, GB→GBP, etc). Without this, currency stayed
  // stale on a country change — a UK seller could end up listing items
  // priced in AUD and mismatched against their GBP payout account.
  // An explicit currency in the request still wins (lets a user override
  // if they ever genuinely want a different display currency).
  const COUNTRY_TO_CURRENCY: Record<string, string> = {
    AU: "AUD",
    US: "USD",
    NZ: "NZD",
    CA: "CAD",
    GB: "GBP",
  };
  if (updateData.location && updateData.currency === undefined) {
    const derived = COUNTRY_TO_CURRENCY[updateData.location];
    if (derived) {
      (updateData as { currency?: string }).currency = derived;
    }
  }

  // Check if profile is complete (all required fields present)
  // Required for selling: display_name, avatar_url, location, size_preferences
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("*")
    .eq("clerk_id", clerkUserId)
    .single();

  if (!existingProfile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Addresses live in their own table (user_addresses) so users can save
  // multiple. Profile completeness stays at the original bar: name + country.
  const merged = { ...existingProfile, ...updateData };
  const profileComplete =
    !!merged.display_name &&
    !!merged.location;

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({
      ...updateData,
      profile_complete: profileComplete,
    })
    .eq("clerk_id", clerkUserId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating profile:", updateError);
    return c.json({ error: "Failed to update profile" }, 500);
  }

  return c.json({ profile: updatedProfile });
});

// ============================================================
// Payout method — multi-method (Stripe / Wise / PayPal)
// ============================================================

// Discriminated union so each method validates its own required fields.
// Stripe path needs no body fields here — onboarding happens via the
// dedicated Stripe Connect flow (POST /api/stripe/create-account etc).
const payoutMethodSchema = z.discriminatedUnion("payout_method", [
  z.object({
    payout_method: z.literal("stripe"),
  }),
  z.object({
    payout_method: z.literal("wise"),
    wise_account_holder: z.string().min(1).max(200),
    wise_bank_country: z.enum(["AU", "GB", "US", "CA", "NZ"]),
    wise_bank_currency: z.enum(["AUD", "GBP", "USD", "CAD", "NZD"]),
    wise_routing_code: z.string().min(1).max(50),
    wise_account_number: z.string().min(1).max(50),
    wise_account_type: z.enum(["checking", "savings"]).optional(),
  }),
  z.object({
    payout_method: z.literal("paypal"),
    paypal_email: z.string().email(),
  }),
]);

/**
 * PUT /api/profiles/me/payout-method
 * Seller picks one of the three payout methods and submits the
 * relevant details. Stripe Connect uses the existing onboarding flow
 * (no extra fields). Wise / PayPal store bank / email details that
 * the admin uses to manually disburse on delivery confirmation.
 *
 * Only updates fields for the chosen method — leaves the others
 * alone so a seller switching methods doesn't have to re-enter old
 * details if they switch back.
 */
profiles.put("/me/payout-method", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = payoutMethodSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const data = parsed.data;

  // For Stripe, auto-create the Connect account here if the seller
  // doesn't have one yet. This is the key fix for the "I had PayPal set
  // up, then tried Stripe and it didn't work" case: a PayPal-only seller
  // has no stripe_account_id, and the old code 400'd telling them to
  // "set up Stripe first" — a chicken-and-egg dead end. Now picking
  // Stripe as the payout method provisions the account on the spot, so
  // the FE can go straight to onboarding-url next.
  //
  // Onboarding does NOT need to be complete to declare intent — money
  // flow is gated separately by resolveSellerPayoutMethod, which refuses
  // to dispatch a payout until onboarding finishes. So "set intent now,
  // finish onboarding later" is safe.
  if (data.payout_method === "stripe") {
    const { data: stripeProfile } = await supabase
      .from("profiles")
      .select("id, stripe_account_id, location")
      .eq("clerk_id", clerkUserId)
      .single();

    if (!stripeProfile) {
      return c.json({ error: "Profile not found" }, 404);
    }

    if (!stripeProfile.stripe_account_id) {
      try {
        // Idempotent + persists stripe_account_id on the row. Throws a
        // StripeServiceError(400) if the profile has no country set —
        // Stripe Connect accounts are pinned to a country at creation.
        await createExpressAccount({
          id: stripeProfile.id as string,
          stripe_account_id: null,
          location: stripeProfile.location as string | null,
        });
      } catch (err) {
        if (err instanceof StripeServiceError) {
          return c.json({ error: err.message }, err.status as 400 | 500);
        }
        console.error("Error auto-creating Stripe account in payout-method:", err);
        return c.json({ error: "Failed to set up Stripe Connect" }, 500);
      }
    }
  }

  // Build update payload — only set fields relevant to the chosen method.
  const updatePayload: Record<string, unknown> = {
    payout_method: data.payout_method,
  };
  if (data.payout_method === "wise") {
    updatePayload.wise_account_holder = data.wise_account_holder;
    updatePayload.wise_bank_country = data.wise_bank_country;
    updatePayload.wise_bank_currency = data.wise_bank_currency;
    updatePayload.wise_routing_code = data.wise_routing_code;
    updatePayload.wise_account_number = data.wise_account_number;
    updatePayload.wise_account_type = data.wise_account_type ?? null;
  } else if (data.payout_method === "paypal") {
    updatePayload.paypal_email = data.paypal_email;
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("clerk_id", clerkUserId)
    .select(
      "id, payout_method, stripe_account_id, stripe_onboarding_complete, " +
        "wise_account_holder, wise_bank_country, wise_bank_currency, " +
        "wise_routing_code, wise_account_number, wise_account_type, paypal_email"
    )
    .single();

  if (updateError) {
    console.error("Error updating payout method:", updateError);
    return c.json({ error: "Failed to update payout method" }, 500);
  }

  return c.json({ profile: updatedProfile });
});

/**
 * GET /api/profiles/me/payouts
 * Seller's payout history — every owed disbursement, status, and
 * external reference if the admin has already paid them out.
 */
profiles.get("/me/payouts", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("clerk_id", clerkUserId)
    .single();

  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    200
  );
  const cursor = c.req.query("cursor");

  let query = supabase
    .from("seller_payouts")
    .select(
      "id, order_id, amount_cents, currency, method, status, stripe_transfer_id, external_reference, failure_reason, paid_at, sent_at, created_at, updated_at, orders!seller_payouts_order_id_fkey(order_number, listing_id)"
    )
    .eq("seller_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: payouts, error } = await query;

  if (error) {
    console.error("Error fetching payouts:", error);
    return c.json({ error: "Failed to fetch payouts" }, 500);
  }

  const items = (payouts || []).map((row: Record<string, unknown>) => {
    const orderRaw = row.orders as Record<string, unknown> | null;
    return {
      id: row.id,
      order_id: row.order_id,
      order_number: orderRaw ? orderRaw.order_number : null,
      listing_id: orderRaw ? orderRaw.listing_id : null,
      amount_cents: row.amount_cents,
      currency: row.currency,
      method: row.method,
      status: row.status,
      stripe_transfer_id: row.stripe_transfer_id,
      external_reference: row.external_reference,
      failure_reason: row.failure_reason,
      paid_at: row.paid_at,
      sent_at: row.sent_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  const nextCursor =
    items.length === limit
      ? (items[items.length - 1].created_at as string)
      : null;

  return c.json({ items, next_cursor: nextCursor });
});

/**
 * GET /api/profiles/:id
 * Returns a public profile by UUID. Only visible if profile_complete is true.
 * Optionally authenticated (guests can view public profiles).
 */
profiles.get("/:id", optionalClerkMiddleware, async (c) => {
  const profileId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(profileId)) {
    return c.json({ error: "Invalid profile ID format" }, 400);
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(
      "id, display_name, avatar_url, location, created_at, profile_complete"
    )
    .eq("id", profileId)
    .eq("profile_complete", true)
    .single();

  if (error || !profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  return c.json({ profile });
});

/**
 * POST /api/profiles/me/avatar
 * Uploads a profile avatar image to Supabase Storage and updates avatar_url.
 */
profiles.post("/me/avatar", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, avatar_url")
    .eq("clerk_id", clerkUserId)
    .single();

  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const body = await c.req.parseBody();
  const photo = body["photo"];

  if (!photo || !(photo instanceof File)) {
    return c.json({ error: "No photo file provided" }, 400);
  }

  const maxSize = 5 * 1024 * 1024;
  if (photo.size > maxSize) {
    return c.json({ error: "File too large. Maximum 5MB" }, 400);
  }

  const ext = photo.name.split(".").pop() || "jpg";
  const fileId = crypto.randomUUID();
  const storagePath = `avatars/${profile.id}/${fileId}.${ext}`;

  const fileBuffer = await photo.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from("listing-photos")
    .upload(storagePath, fileBuffer, {
      contentType: photo.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("Error uploading avatar:", uploadError);
    return c.json({ error: "Failed to upload avatar" }, 500);
  }

  const { data: urlData } = supabase.storage
    .from("listing-photos")
    .getPublicUrl(storagePath);

  // Delete old avatar from storage if it was in our bucket
  if (profile.avatar_url?.includes("/listing-photos/avatars/")) {
    const oldPath = profile.avatar_url.split("/listing-photos/").pop();
    if (oldPath) {
      await supabase.storage.from("listing-photos").remove([oldPath]).catch(() => {});
    }
  }

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: urlData.publicUrl })
    .eq("clerk_id", clerkUserId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating avatar_url:", updateError);
    return c.json({ error: "Failed to update profile" }, 500);
  }

  return c.json({ avatar_url: updatedProfile.avatar_url });
});

// ============================================================
// Payment methods — saved cards for the current buyer
// ============================================================
//
// Cards are attached to the buyer's Stripe Customer at checkout time
// (see stripe.ts /payment-intent — passes customer + setup_future_usage).
// These endpoints expose the saved set so:
//   1. Settings → Payment Methods can list and remove cards
//   2. PaymentSheet at checkout can render saved cards inline (via the
//      ephemeral-key endpoint, which gates the customer's tokens to a
//      single client session without exposing the secret key).

const UUID_REGEX_PAYMENTS =
  /^pm_[A-Za-z0-9]+$/; // Stripe PaymentMethod id format ("pm_...")

/**
 * GET /api/profiles/me/payment-methods
 * Lists the buyer's saved cards. Empty list if no Stripe Customer
 * exists yet (i.e., they've never checked out).
 */
profiles.get("/me/payment-methods", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  if (!profile.stripe_customer_id) {
    return c.json({ payment_methods: [] });
  }
  try {
    const stripe = getStripeClient();
    const result = await stripe.paymentMethods.list({
      customer: profile.stripe_customer_id,
      type: "card",
      limit: 20,
    });
    const payment_methods = result.data.map((pm) => ({
      id: pm.id,
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
      exp_month: pm.card?.exp_month ?? null,
      exp_year: pm.card?.exp_year ?? null,
    }));
    return c.json({ payment_methods });
  } catch (err) {
    console.error("[payment-methods list] Stripe error:", err);
    return c.json({ error: "Failed to load payment methods" }, 500);
  }
});

/**
 * DELETE /api/profiles/me/payment-methods/:id
 * Detaches a card from the buyer's Customer. The card is owned by
 * Stripe, so we can detach but cannot guarantee deletion server-side;
 * detach is the standard "remove from my account" operation.
 */
profiles.delete(
  "/me/payment-methods/:id",
  clerkMiddleware,
  requireProfile,
  async (c) => {
    const paymentMethodId = c.req.param("id");
    if (!UUID_REGEX_PAYMENTS.test(paymentMethodId)) {
      return c.json({ error: "Invalid payment method ID format" }, 400);
    }
    const profile = c.get("profile");
    if (!profile.stripe_customer_id) {
      return c.json({ error: "No saved payment methods" }, 404);
    }
    try {
      const stripe = getStripeClient();
      // Confirm the card belongs to this customer before we detach.
      // Without this anyone could remove anyone else's card by guessing
      // a pm_ id.
      const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      if (pm.customer !== profile.stripe_customer_id) {
        return c.json({ error: "Payment method not found" }, 404);
      }
      await stripe.paymentMethods.detach(paymentMethodId);
      return c.body(null, 204);
    } catch (err) {
      const stripeErr = err as { code?: string; statusCode?: number };
      if (stripeErr?.code === "resource_missing") {
        return c.json({ error: "Payment method not found" }, 404);
      }
      console.error("[payment-methods detach] Stripe error:", err);
      return c.json({ error: "Failed to remove payment method" }, 500);
    }
  }
);

/**
 * POST /api/profiles/me/payment-methods/ephemeral-key
 * Returns a short-lived ephemeral key tied to the buyer's Customer.
 * The frontend hands this to Stripe's PaymentSheet so it can render
 * the buyer's saved cards as inline options at checkout — without
 * the FE ever holding the secret key.
 *
 * Lazily creates the Customer on first call so the FE can fetch this
 * before kicking off a PaymentIntent.
 */
profiles.post(
  "/me/payment-methods/ephemeral-key",
  clerkMiddleware,
  requireProfile,
  async (c) => {
    const profile = c.get("profile");
    try {
      const customerId = await getOrCreateStripeCustomer({
        id: profile.id,
        stripe_customer_id: profile.stripe_customer_id,
        display_name: profile.display_name,
        email: profile.email,
      });
      const stripe = getStripeClient();
      const key = await stripe.ephemeralKeys.create(
        { customer: customerId },
        // Stripe-Version pinned so the client SDK + server agree on
        // the response schema. Use the same version the rest of the
        // backend is on (stripeService.ts apiVersion).
        { apiVersion: "2026-02-25.clover" }
      );
      return c.json({
        customer_id: customerId,
        ephemeral_key_secret: key.secret,
      });
    } catch (err) {
      console.error("[payment-methods ephemeral-key] Stripe error:", err);
      return c.json({ error: "Failed to create ephemeral key" }, 500);
    }
  }
);

/**
 * DELETE /api/profiles/me
 * Account deletion (soft-delete). Required by Apple + Google for any
 * app that allows account creation.
 *
 * Flow:
 *   1. Refuse if the user has any in-flight order (paid/shipped/
 *      delivered) as buyer OR seller — money/goods are mid-transit and
 *      must be resolved first.
 *   2. Soft-delete: stamp deleted_at, anonymise all PII + payout fields,
 *      null clerk_id so the dead profile can't be re-authed or
 *      re-claimed by email.
 *   3. Deactivate their active listings so nothing stays buyable.
 *   4. Delete the Clerk user so they can't log back in. A fresh signup
 *      later creates a brand-new profile.
 *
 * Transactional records (orders, reviews) are intentionally preserved —
 * the counterparties' history must stay intact.
 */
profiles.delete("/me", clerkMiddleware, requireProfile, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // 1. Block deletion while any order is mid-flight (as buyer or seller).
  // 'complete' and 'cancelled' are terminal and don't block.
  const IN_FLIGHT = ["paid", "shipped", "delivered"];
  const { data: activeOrders, error: orderErr } = await supabase
    .from("orders")
    .select("id, status")
    .or(`buyer_id.eq.${profile.id},seller_id.eq.${profile.id}`)
    .in("status", IN_FLIGHT)
    .limit(1);

  if (orderErr) {
    console.error("[delete account] order check failed:", orderErr);
    return c.json({ error: "Failed to verify account state" }, 500);
  }
  if (activeOrders && activeOrders.length > 0) {
    return c.json(
      {
        error:
          "You have an order in progress. Please complete or cancel it before deleting your account.",
      },
      409
    );
  }

  // 2. Soft-delete + anonymise. Null clerk_id and email so neither the
  // login path nor the legacy email-claim can ever re-attach this row.
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from("profiles")
    .update({
      deleted_at: now,
      clerk_id: null,
      email: null,
      display_name: "Deleted User",
      avatar_url: null,
      phone: null,
      bio: null,
      // Payout PII — never leave bank / payout identifiers on a dead row.
      paypal_email: null,
      wise_account_holder: null,
      wise_account_number: null,
      wise_routing_code: null,
      stripe_customer_id: null,
      // Mark them incomplete so any residual UI treats them as gone.
      profile_complete: false,
    })
    .eq("id", profile.id);

  if (updateErr) {
    console.error("[delete account] soft-delete update failed:", updateErr);
    return c.json({ error: "Failed to delete account" }, 500);
  }

  // 3. Deactivate active/reserved listings so nothing stays buyable.
  // Sold/completed listings stay as-is for order history.
  await supabase
    .from("listings")
    .update({ status: "deactivated" })
    .eq("seller_id", profile.id)
    .in("status", ["active", "reserved"]);

  // 4. Delete the Clerk user. Best-effort — the profile is already
  // anonymised + detached, so even if Clerk deletion fails the user
  // can't reach their old data. Log loudly so it can be cleaned up.
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    await clerk.users.deleteUser(clerkUserId);
  } catch (err) {
    console.error(
      `[delete account] Clerk user deletion failed for ${clerkUserId} (profile already anonymised):`,
      err instanceof Error ? err.message : String(err)
    );
  }

  console.log(`[delete account] profile=${profile.id} soft-deleted`);
  return c.json({ deleted: true });
});

export default profiles;
