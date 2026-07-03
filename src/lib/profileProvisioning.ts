// ============================================================
// Profile provisioning (shared)
//
// A profile row is created on first authenticated contact. This used to
// live only inside `GET /api/profiles/me`, which meant any OTHER endpoint
// (guarded by requireProfile) hit before the app called GET /me would 403
// with "Profile not found" — the signup provisioning race the app team
// reported ("could not save" right after signup).
//
// Centralising it here lets BOTH GET /me and requireProfile provision on
// demand, so the very first authenticated request — whatever it is —
// creates (or claims) the profile. The one-time side effects (welcome
// email, referral code, Sharetribe welcome-back notification) fire exactly
// once, on the request that actually creates/claims the row.
// ============================================================

import { createSupabaseAdmin } from "./supabase.js";
import { createNotification, welcomeBackNotification } from "./notifications.js";

export type ProfileRow = Record<string, unknown>;

export type EnsureProfileStatus = "existing" | "claimed" | "created";

export interface EnsureProfileResult {
  profile: ProfileRow;
  status: EnsureProfileStatus;
}

/**
 * Lookup a Clerk user's primary email + verified phone (if any) via the
 * Clerk backend SDK. Email is lower-cased + trimmed for case-insensitive
 * matching. Phone is returned raw E.164 (e.g. `+61412345678`). Either may
 * be null depending on which verification methods the user completed.
 */
export async function fetchClerkContactInfo(
  clerkUserId: string
): Promise<{ email: string | null; phone: string | null }> {
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    const user = await clerk.users.getUser(clerkUserId);

    const primaryEmail = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId
    );
    const email =
      (
        primaryEmail?.emailAddress ||
        user.emailAddresses[0]?.emailAddress ||
        ""
      )
        .toLowerCase()
        .trim() || null;

    const primaryPhone = user.phoneNumbers?.find(
      (p) => p.id === user.primaryPhoneNumberId
    );
    const phone =
      (primaryPhone?.phoneNumber || user.phoneNumbers?.[0]?.phoneNumber || "").trim() ||
      null;

    return { email, phone };
  } catch (err) {
    console.error("Error fetching Clerk user contact info:", err);
    return { email: null, phone: null };
  }
}

/**
 * Force-verify the user's primary email in Clerk.
 *
 * Signup is phone-OTP only (one OTP, per the client), so the email the
 * user typed is left UNVERIFIED in Clerk. That blocks a later
 * email+password login — Clerk reports "email doesn't exist" for an
 * unverified address. We own the account lifecycle, so on first
 * provisioning we mark the email verified via the backend API. Idempotent
 * (skips already-verified) and best-effort (never blocks provisioning).
 */
export async function ensureClerkEmailVerified(
  clerkUserId: string
): Promise<void> {
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    const user = await clerk.users.getUser(clerkUserId);
    const primary =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ||
      user.emailAddresses[0];
    if (!primary) return; // phone-only account, nothing to verify
    if (primary.verification?.status === "verified") return;

    await clerk.emailAddresses.updateEmailAddress(primary.id, {
      verified: true,
    });
    console.log(`[profiles] auto-verified Clerk email for user=${clerkUserId}`);
  } catch (err) {
    console.error("Failed to auto-verify Clerk email:", err);
  }
}

/**
 * Sharetribe-migration claim flow. When a returning user signs up via
 * Clerk with the same email they used on the old app, the importer left a
 * profile row waiting (clerk_id NULL, email set, legacy id set). Stamp the
 * Clerk ID onto it and return it.
 *
 * Race-safe: the UPDATE guards on `clerk_id IS NULL` so two concurrent
 * claims can't both win. The loser falls through to fresh-create.
 * Returns the claimed row, or null if no match.
 */
async function tryClaimLegacyProfile(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  clerkUserId: string
): Promise<ProfileRow | null> {
  const { email, phone: clerkPhone } = await fetchClerkContactInfo(clerkUserId);
  if (!email) return null;

  const { data: legacy, error: lookupError } = await supabase
    .from("profiles")
    .select("*")
    .ilike("email", email)
    .is("clerk_id", null)
    .not("legacy_sharetribe_id", "is", null)
    .maybeSingle();

  if (lookupError || !legacy) return null;

  const updatePayload: Record<string, unknown> = { clerk_id: clerkUserId };
  if (!legacy.phone && clerkPhone) {
    updatePayload.phone = clerkPhone;
  }

  const { data: claimed, error: updateError } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", legacy.id)
    .is("clerk_id", null)
    .select()
    .single();

  if (updateError || !claimed) return null;

  console.log(
    `[profiles] legacy claim: clerk=${clerkUserId} → profile=${claimed.id} ` +
      `(legacy_sharetribe_id=${claimed.legacy_sharetribe_id})`
  );

  // Welcome-back notification (fire-and-forget).
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

/**
 * Create a brand-new profile row and fire its one-time side effects
 * (welcome email + referral code). Prefills verified Clerk email/phone.
 */
async function provisionFreshProfile(
  supabase: ReturnType<typeof createSupabaseAdmin>,
  clerkUserId: string
): Promise<ProfileRow | null> {
  const { email: clerkEmail, phone: clerkPhone } = await fetchClerkContactInfo(
    clerkUserId
  );
  const freshInsert: Record<string, unknown> = { clerk_id: clerkUserId };
  if (clerkEmail) freshInsert.email = clerkEmail;
  if (clerkPhone) freshInsert.phone = clerkPhone;

  const { data: newProfile, error: insertError } = await supabase
    .from("profiles")
    .insert(freshInsert)
    .select()
    .single();

  if (insertError || !newProfile) {
    // 23505 = unique violation. First-load fires several GET /me in parallel,
    // so a sibling request may have already created (or claimed) this profile
    // between our clerk_id lookup and this INSERT. Return the winner's row
    // instead of erroring — and DON'T re-fire the welcome email / referral
    // code (the winner already did). Look up by clerk_id first (race), then
    // by email (legacy claim that stamped this clerk_id, or email collision).
    if ((insertError as { code?: string })?.code === "23505") {
      const { data: byClerk } = await supabase
        .from("profiles")
        .select("*")
        .eq("clerk_id", clerkUserId)
        .maybeSingle();
      if (byClerk) return byClerk;
      if (clerkEmail) {
        const { data: byEmail } = await supabase
          .from("profiles")
          .select("*")
          .ilike("email", clerkEmail)
          .maybeSingle();
        if (byEmail) return byEmail;
      }
    }
    console.error("Error creating profile:", insertError);
    return null;
  }

  // Fire-and-forget welcome email.
  const apiBaseUrl =
    process.env.API_URL || `http://localhost:${process.env.PORT || 3001}`;
  fetch(`${apiBaseUrl}/api/email-hooks/welcome`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
    },
    body: JSON.stringify({ clerk_user_id: clerkUserId }),
  }).catch(() => {
    // best-effort
  });

  // Fire-and-forget referral code generation.
  (async () => {
    try {
      const { createClerkClient } = await import("@clerk/backend");
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY || "",
      });
      const user = await clerk.users.getUser(clerkUserId);
      const profileId = newProfile.id as string;
      const randomSuffix = () =>
        "K" +
        Math.random()
          .toString(36)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 4)
          .padEnd(4, "0");

      const base =
        (user.username || user.firstName || profileId.slice(0, 8))
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
          .slice(0, 20) || profileId.slice(0, 8).toUpperCase();

      const code = `${base}-${randomSuffix()}`;
      const { error: codeError } = await supabase
        .from("referral_codes")
        .insert({ user_id: profileId, code });

      if (codeError?.code === "23505") {
        await supabase
          .from("referral_codes")
          .insert({ user_id: profileId, code: `${base}-${randomSuffix()}` });
      }
    } catch (err) {
      console.error("Error generating referral code:", err);
    }
  })();

  return newProfile;
}

/**
 * Ensure a profile row exists for a Clerk user, provisioning it on demand.
 * Resolution order: existing (by clerk_id) → claim legacy (by email) →
 * create fresh. Returns the full row plus which path was taken so callers
 * can set the right status code / skip redundant work.
 */
export async function ensureProfile(
  clerkUserId: string
): Promise<EnsureProfileResult | null> {
  const supabase = createSupabaseAdmin();

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("*")
    .eq("clerk_id", clerkUserId)
    .single();

  if (selectError && selectError.code !== "PGRST116") {
    // PGRST116 = not found; anything else is a real error.
    console.error("ensureProfile select error:", selectError);
    return null;
  }
  if (existing) return { profile: existing, status: "existing" };

  const claimed = await tryClaimLegacyProfile(supabase, clerkUserId);
  if (claimed) {
    // First contact for this Clerk user — verify their email so a later
    // email+password login works (signup only verified their phone).
    void ensureClerkEmailVerified(clerkUserId);
    return { profile: claimed, status: "claimed" };
  }

  const fresh = await provisionFreshProfile(supabase, clerkUserId);
  if (fresh) {
    void ensureClerkEmailVerified(clerkUserId);
    return { profile: fresh, status: "created" };
  }

  return null;
}
