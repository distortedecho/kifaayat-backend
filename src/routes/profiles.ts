import { Hono } from "hono";
import { z } from "zod";
import crypto from "node:crypto";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { createNotification, welcomeBackNotification } from "../lib/notifications.js";

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

/**
 * Lookup a Clerk user's primary email via the Clerk backend SDK.
 * Returns lower-cased + trimmed for case-insensitive matching.
 * Returns null if the user has no verified primary email (very rare).
 */
async function fetchClerkPrimaryEmail(clerkUserId: string): Promise<string | null> {
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    const user = await clerk.users.getUser(clerkUserId);
    // primaryEmailAddressId points at the active email; resolve it.
    const primary = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId
    );
    const email = (primary?.emailAddress || user.emailAddresses[0]?.emailAddress || "")
      .toLowerCase()
      .trim();
    return email || null;
  } catch (err) {
    console.error("Error fetching Clerk user email:", err);
    return null;
  }
}

/**
 * Sharetribe-migration claim flow.
 *
 * When a returning user signs up via Clerk with the same email they
 * used on the old app, the importer's already left a profile row
 * waiting for them (clerk_id NULL, email set, all their listings/
 * wishlists/reviews already attached). Stamp the Clerk ID onto that
 * row and return it as the canonical profile.
 *
 * Race-safe: the UPDATE uses `clerk_id IS NULL` as a guard so two
 * simultaneous claim attempts can't both win. The losing call falls
 * through to the normal "fresh profile" path and we end up with a
 * harmless second profile — the original Sharetribe data is still on
 * the winner.
 *
 * Returns the claimed profile row, or null if no match was found.
 */
async function tryClaimLegacyProfile(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  clerkUserId: string
): Promise<Record<string, unknown> | null> {
  const email = await fetchClerkPrimaryEmail(clerkUserId);
  if (!email) return null;

  // Find a pre-migrated profile (clerk_id null, email matches, legacy id set).
  // The unique partial index on LOWER(email) WHERE email IS NOT NULL
  // guarantees there's at most one candidate.
  const { data: legacy, error: lookupError } = await supabase
    .from("profiles")
    .select("*")
    .ilike("email", email)
    .is("clerk_id", null)
    .not("legacy_sharetribe_id", "is", null)
    .maybeSingle();

  if (lookupError || !legacy) return null;

  // Claim it — guarded by `clerk_id IS NULL` so a concurrent claim can't
  // double-stamp the same row.
  const { data: claimed, error: updateError } = await supabase
    .from("profiles")
    .update({ clerk_id: clerkUserId })
    .eq("id", legacy.id)
    .is("clerk_id", null)
    .select()
    .single();

  if (updateError || !claimed) {
    // Race lost (or DB error) — return null so caller falls through
    // to the normal create-fresh path.
    return null;
  }

  console.log(
    `[profiles] legacy claim: clerk=${clerkUserId} → profile=${claimed.id} ` +
      `(legacy_sharetribe_id=${claimed.legacy_sharetribe_id})`
  );

  // Drop a single welcome-back notification into their inbox so they
  // land with something rather than an empty notifications screen.
  // Fire-and-forget — a notification failure must NOT block the claim.
  // Best-effort first-name extraction from display_name; OK if null.
  const displayName = (claimed.display_name as string | null) || null;
  const firstName = displayName ? displayName.split(/\s+/)[0] : null;
  const template = welcomeBackNotification(firstName);
  createNotification({
    user_id: claimed.id as string,
    type: "welcome_back",
    title: template.title,
    body: template.body,
    data: {
      role: "buyer",
      legacy_sharetribe_id: claimed.legacy_sharetribe_id as string,
    },
  }).catch((err) =>
    console.error("Failed to create welcome_back notification:", err)
  );

  return claimed;
}

// Zod schema for profile updates
const updateProfileSchema = z.object({
  display_name: z
    .string()
    .max(50, "Display name must be 50 characters or less")
    .optional(),
  avatar_url: z.string().url("Must be a valid URL").nullable().optional(),
  location: z.enum(["AU", "US", "NZ", "CA", "UK"]).optional(),
  currency: z.enum(["AUD", "USD", "NZD", "CAD", "GBP"]).optional(),
  size_preferences: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      garment_length: z.string().optional(),
      sleeve_length: z.string().optional(),
      clothing_size: z.string().optional(),
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

  // Try to find existing profile
  const { data: profile, error: selectError } = await supabase
    .from("profiles")
    .select("*")
    .eq("clerk_id", clerkUserId)
    .single();

  if (selectError && selectError.code !== "PGRST116") {
    // PGRST116 = "not found" — any other error is unexpected
    console.error("Error fetching profile:", selectError);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }

  if (profile) {
    const counts = await fetchFollowCounts(supabase, profile.id);
    return c.json({ profile: { ...profile, ...counts } });
  }

  // No profile by clerk_id. Before creating a fresh one, check the
  // Sharetribe-migration lookup: is there a pre-migrated profile with
  // this user's email and no clerk_id yet? If so, claim it.
  //
  // This is the second half of the email-match-on-Clerk-signup flow.
  // When a returning user signs up via Clerk with the same email they
  // had on the old Sharetribe app, their listings/wishlist/reviews etc
  // are already sitting in the DB attached to a profile row that's
  // waiting to be claimed. We stamp the Clerk ID onto that row instead
  // of creating a duplicate.
  const claimed = await tryClaimLegacyProfile(supabase, clerkUserId);
  if (claimed) {
    const counts = await fetchFollowCounts(supabase, claimed.id as string);
    return c.json({ profile: { ...claimed, ...counts } });
  }

  // No legacy match either — create a fresh profile.
  const { data: newProfile, error: insertError } = await supabase
    .from("profiles")
    .insert({ clerk_id: clerkUserId })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating profile:", insertError);
    return c.json({ error: "Failed to create profile" }, 500);
  }

  // Fire-and-forget welcome email (don't await, don't block profile creation)
  // The welcome hook looks up the user's email via Clerk backend SDK.
  // NOTE: API_URL must be set to the Railway public URL in production,
  // otherwise the internal callback will point at localhost inside the
  // container and silently fail. Dev falls back to localhost:PORT.
  const apiBaseUrl =
    process.env.API_URL || `http://localhost:${process.env.PORT || 3001}`;
  fetch(`${apiBaseUrl}/api/email-hooks/welcome`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
    },
    body: JSON.stringify({
      clerk_user_id: clerkUserId,
    }),
  }).catch(() => {
    // Intentionally swallowed — welcome email is best-effort
  });

  // Fire-and-forget referral code generation
  (async () => {
    try {
      const { createClerkClient } = await import("@clerk/backend");
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY || "",
      });
      const user = await clerk.users.getUser(clerkUserId);
      const randomSuffix = () =>
        "K" +
        Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "0");

      const base = (user.username || user.firstName || newProfile.id.slice(0, 8))
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 20) || newProfile.id.slice(0, 8).toUpperCase();

      const code = `${base}-${randomSuffix()}`;

      const { error: codeError } = await supabase.from("referral_codes").insert({
        user_id: newProfile.id,
        code,
      });

      // Handle UNIQUE collision -- regenerate suffix
      if (codeError?.code === "23505") {
        await supabase.from("referral_codes").insert({
          user_id: newProfile.id,
          code: `${base}-${randomSuffix()}`,
        });
      }
    } catch (err) {
      console.error("Error generating referral code:", err);
      // Non-blocking -- profile still created successfully
    }
  })();

  return c.json(
    { profile: { ...newProfile, follower_count: 0, following_count: 0 } },
    201
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
    wise_bank_country: z.enum(["AU", "UK", "US", "CA", "NZ"]),
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

  // For Stripe, gate-check that onboarding is already complete — otherwise
  // the seller can't actually receive money via this method. Avoids the UI
  // letting them "pick Stripe" without first running through AccountLink.
  if (data.payout_method === "stripe") {
    const { data: stripeProfile } = await supabase
      .from("profiles")
      .select("stripe_account_id, stripe_onboarding_complete")
      .eq("clerk_id", clerkUserId)
      .single();

    if (!stripeProfile?.stripe_account_id || !stripeProfile.stripe_onboarding_complete) {
      return c.json(
        {
          error:
            "Complete Stripe Connect onboarding before selecting Stripe as your payout method.",
        },
        400
      );
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

export default profiles;
