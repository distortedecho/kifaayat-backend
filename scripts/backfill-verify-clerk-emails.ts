// ============================================================
// Backfill: verify Clerk emails for existing users
//
// Signup is phone-OTP only, so users onboarded before we added
// auto-verification (lib/profileProvisioning.ts → ensureClerkEmailVerified)
// still have UNVERIFIED emails in Clerk. That blocks email+password login
// ("email doesn't exist"). This walks every profile with a clerk_id and
// force-verifies its primary Clerk email if it isn't already.
//
// SAFE: idempotent (skips already-verified), read-only in --dry-run.
// Sequential with a small delay to stay under Clerk's rate limit.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CLERK_SECRET_KEY=... \
//   tsx scripts/backfill-verify-clerk-emails.ts [--dry-run] [--limit N]
// ============================================================

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createClerkClient } from "@clerk/backend";

const dryRun = process.argv.includes("--dry-run");
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const limit = argValue("--limit") ? parseInt(argValue("--limit")!, 10) : Infinity;

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

async function main() {
  console.log(
    `Backfill verify Clerk emails ${dryRun ? "(DRY RUN)" : ""} ` +
      `${limit !== Infinity ? `(limit ${limit})` : ""}\n`
  );

  // Page through all profiles that have a Clerk account.
  const pageSize = 500;
  let from = 0;
  const clerkIds: string[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("profiles")
      .select("clerk_id")
      .not("clerk_id", "is", null)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Failed to load profiles:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.clerk_id) clerkIds.push(row.clerk_id as string);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const targets = clerkIds.slice(0, limit);
  console.log(`${clerkIds.length} profiles with a clerk_id; processing ${targets.length}\n`);

  let verified = 0;
  let alreadyVerified = 0;
  let noEmail = 0;
  let missingUser = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const clerkUserId = targets[i];
    try {
      const user = await clerk.users.getUser(clerkUserId);
      const primary =
        user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ||
        user.emailAddresses[0];

      if (!primary) {
        noEmail += 1;
        continue;
      }
      if (primary.verification?.status === "verified") {
        alreadyVerified += 1;
        continue;
      }

      if (dryRun) {
        console.log(`  would verify ${primary.emailAddress} (${clerkUserId})`);
        verified += 1;
      } else {
        await clerk.emailAddresses.updateEmailAddress(primary.id, {
          verified: true,
        });
        console.log(`  ✅ verified ${primary.emailAddress} (${clerkUserId})`);
        verified += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 = the Clerk user no longer exists (deleted account etc).
      if (msg.includes("404") || msg.toLowerCase().includes("not found")) {
        missingUser += 1;
      } else {
        failed += 1;
        console.error(`  ❌ ${clerkUserId} failed: ${msg}`);
      }
    }

    // Gentle pacing to stay under Clerk's rate limit (~20 req/s).
    await sleep(60);
  }

  console.log(
    `\nDone. verified=${verified} alreadyVerified=${alreadyVerified} ` +
      `noEmail=${noEmail} missingUser=${missingUser} failed=${failed}`
  );
  if (dryRun) console.log("(dry run — no changes written)");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
