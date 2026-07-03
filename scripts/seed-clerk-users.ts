// ============================================================
// Seed migrated Sharetribe users into Clerk
//
// Migrated users live only in our DB (clerk_id NULL, email set,
// legacy_sharetribe_id set) — they have no Clerk account, so Clerk's
// "forgot password" reports "email doesn't exist". This creates a Clerk
// user per migrated email (email pre-VERIFIED, NO password) and links the
// new clerk_id back onto the profile. Then the user just does:
//   Forgot password → email code → set password → logged in.
// No signup. First login shows "More about you" (profile_complete=false).
//
// SAFE: idempotent (skips profiles that already have clerk_id; links the
// existing Clerk user if the email is already in Clerk), read-only in
// --dry-run, paced for Clerk's rate limit. Defaults to 5 users so you can
// test the flow before a full run — raise with --limit.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CLERK_SECRET_KEY=... \
//   tsx scripts/seed-clerk-users.ts [--dry-run] [--limit N]
// ============================================================

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createClerkClient } from "@clerk/backend";

// ---- Manual email list (for targeted testing) ----------------------------
// Put specific migrated emails here to seed ONLY those (ignores --limit).
// They must belong to migrated profiles (legacy_sharetribe_id set, no
// clerk_id yet). Leave empty [] to use the automatic limit-based selection.
const MANUAL_EMAILS: string[] = [
  "kifaayatv2+clerk_test@example.com",
  "kifaayattest2+clerk_test@example.com",
  "kifaayattest3+clerk_test@example.com",
  "kifaayattest7+clerk_test@example.com",
  "kifaayattest8+clerk_test@example.com",
  // "someone@example.com",
  // "another@example.com",
];

const dryRun = process.argv.includes("--dry-run");
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const limit = argValue("--limit") ? parseInt(argValue("--limit")!, 10) : 5;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const clerkSecret = process.env.CLERK_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
if (!clerkSecret) {
  console.error("CLERK_SECRET_KEY is required");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const clerk = createClerkClient({ secretKey: clerkSecret });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract Clerk's detailed error (its 422s carry an `errors[]` array). */
function clerkErr(e: unknown): string {
  const anyE = e as { errors?: Array<{ code?: string; message?: string; longMessage?: string }> };
  if (anyE?.errors && Array.isArray(anyE.errors) && anyE.errors.length) {
    return anyE.errors
      .map((x) => x.longMessage || x.message || x.code || "unknown")
      .join("; ");
  }
  return e instanceof Error ? e.message : String(e);
}

/** Find an existing Clerk user by email (SDK return shape varies). */
async function findClerkUserByEmail(email: string): Promise<string | null> {
  const res = await clerk.users.getUserList({ emailAddress: [email] });
  const list = (Array.isArray(res) ? res : res.data) as
    | Array<{ id: string }>
    | undefined;
  return list && list.length > 0 ? list[0].id : null;
}

/** Force-verify all emails on a freshly-created Clerk user. */
async function verifyEmails(user: {
  emailAddresses: Array<{ id: string; verification?: { status?: string } | null }>;
}): Promise<void> {
  for (const e of user.emailAddresses) {
    if (e.verification?.status === "verified") continue;
    await clerk.emailAddresses.updateEmailAddress(e.id, { verified: true });
  }
}

async function main() {
  const manualEmails = MANUAL_EMAILS.map((e) => e.trim().toLowerCase()).filter(
    Boolean
  );
  const useManual = manualEmails.length > 0;

  console.log(
    `Seed Sharetribe users → Clerk ${dryRun ? "(DRY RUN)" : ""} ` +
      (useManual ? `(manual list: ${manualEmails.length})` : `(limit ${limit})`) +
      "\n"
  );

  // Base filter: migrated profiles not yet linked to Clerk.
  let query = supabase
    .from("profiles")
    .select("id, email, display_name, legacy_sharetribe_id")
    .not("legacy_sharetribe_id", "is", null)
    .is("clerk_id", null)
    .not("email", "is", null)
    .neq("email", "");

  // Manual list overrides the limit-based selection (DB emails are stored
  // lower-cased, so the lower-cased .in() matches).
  query = useManual ? query.in("email", manualEmails) : query.limit(limit);

  const { data: profiles, error } = await query;

  if (error) {
    console.error("Failed to load profiles:", error.message);
    process.exit(1);
  }

  // Warn about any manual emails that didn't match an eligible profile
  // (typo, not a migrated user, or already linked to Clerk).
  if (useManual) {
    const found = new Set((profiles || []).map((p) => (p.email as string).toLowerCase()));
    for (const e of manualEmails) {
      if (!found.has(e)) {
        console.warn(`  ⚠️  ${e}: no eligible migrated profile (typo / not migrated / already linked)`);
      }
    }
  }
  if (!profiles || profiles.length === 0) {
    console.log("No migrated profiles left to seed.");
    return;
  }

  console.log(`${profiles.length} profiles to seed\n`);

  let created = 0;
  let linkedExisting = 0;
  let failed = 0;

  for (const p of profiles) {
    const email = (p.email as string).trim().toLowerCase();
    try {
      if (dryRun) {
        console.log(`  would seed ${email} → profile ${p.id}`);
        created += 1;
        continue;
      }

      let clerkUserId: string;
      try {
        const user = await clerk.users.createUser({
          emailAddress: [email],
          skipPasswordRequirement: true,
        });
        await verifyEmails(user);
        clerkUserId = user.id;
        created += 1;
        console.log(`  ✅ created ${email} → clerk ${clerkUserId}`);
      } catch (createErr) {
        const msg = clerkErr(createErr).toLowerCase();
        // Email already in Clerk → link the existing user instead.
        if (msg.includes("already") || msg.includes("taken") || msg.includes("duplicate")) {
          const existingId = await findClerkUserByEmail(email);
          if (!existingId) {
            failed += 1;
            console.error(`  ❌ ${email}: reported duplicate but no user found`);
            continue;
          }
          clerkUserId = existingId;
          linkedExisting += 1;
          console.log(`  🔗 linked existing ${email} → clerk ${clerkUserId}`);
        } else {
          failed += 1;
          console.error(`  ❌ ${email}: ${clerkErr(createErr)}`);
          continue;
        }
      }

      // NOTE: we deliberately do NOT link clerk_id onto the profile here.
      // Leaving it null lets the normal claim flow run on the user's FIRST
      // login (GET /me → tryClaimLegacyProfile by email) — which links the
      // clerk_id AND sends the `welcome_back` notification. Pre-linking here
      // would make ensureProfile see the row as "existing" and skip that.
      void clerkUserId;
    } catch (err) {
      failed += 1;
      console.error(`  ❌ ${email}: ${clerkErr(err)}`);
    }

    // Pace for Clerk's rate limit (createUser is heavier than reads).
    await sleep(200);
  }

  console.log(
    `\nDone. created=${created} linkedExisting=${linkedExisting} failed=${failed}`
  );
  if (dryRun) console.log("(dry run — no Clerk users created, no rows linked)");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
