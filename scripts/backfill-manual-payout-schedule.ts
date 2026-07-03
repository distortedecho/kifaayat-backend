// ============================================================
// Backfill: set manual payout schedule on existing Connect accounts
//
// We switched Stripe Connect sellers to DESTINATION CHARGES, where the
// buyer's payment settles into the SELLER's Stripe balance at purchase.
// Escrow ("hold until delivery") is enforced by a MANUAL payout schedule:
// funds sit in the seller's balance and can't reach their bank until we
// trigger the payout on delivery.
//
// New accounts get this at creation (stripeService.createExpressAccount /
// routes/stripe.ts create-account). But accounts onboarded BEFORE that
// change still have Stripe's default AUTOMATIC schedule — their
// destination-charge funds would auto-pay to their bank, bypassing escrow.
// This one-time backfill flips every existing connected account to manual.
//
// SAFE: idempotent (skips accounts already on manual), read-only in
// --dry-run. Only touches payouts.schedule.interval.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SECRET_KEY=... \
//   tsx scripts/backfill-manual-payout-schedule.ts [--dry-run]
// ============================================================

import "dotenv/config";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const dryRun = process.argv.includes("--dry-run");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
if (!stripeKey) {
  console.error("STRIPE_SECRET_KEY is required");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const stripe = new Stripe(stripeKey, { apiVersion: "2026-02-25.clover" });

async function main() {
  console.log(
    `Backfill manual payout schedule ${dryRun ? "(DRY RUN)" : ""} — ` +
      `mode=${stripeKey!.startsWith("sk_live_") ? "LIVE" : "TEST"}\n`
  );

  // Every profile that has a connected account.
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, stripe_account_id")
    .not("stripe_account_id", "is", null);

  if (error) {
    console.error("Failed to load profiles:", error.message);
    process.exit(1);
  }

  const rows = profiles ?? [];
  console.log(`${rows.length} connected accounts to check\n`);

  let updated = 0;
  let alreadyManual = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const acctId = row.stripe_account_id as string;
    try {
      const acct = await stripe.accounts.retrieve(acctId);
      const interval = acct.settings?.payouts?.schedule?.interval;

      if (interval === "manual") {
        alreadyManual += 1;
        continue;
      }

      if (dryRun) {
        console.log(`  would update ${acctId} (interval=${interval}) → manual`);
        updated += 1;
        continue;
      }

      await stripe.accounts.update(acctId, {
        settings: { payouts: { schedule: { interval: "manual" } } },
      });
      console.log(`  ✅ ${acctId} (was ${interval}) → manual`);
      updated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // account_invalid = stale/synthetic id (e.g. migrated placeholder) —
      // not a real account on our platform. Skip, don't fail the run.
      if (msg.includes("account_invalid") || msg.includes("does not exist")) {
        skipped += 1;
        console.log(`  ⏭️  ${acctId} skipped (${msg.split(".")[0]})`);
      } else {
        failed += 1;
        console.error(`  ❌ ${acctId} failed: ${msg}`);
      }
    }
  }

  console.log(
    `\nDone. updated=${updated} alreadyManual=${alreadyManual} ` +
      `skipped=${skipped} failed=${failed}`
  );
  if (dryRun) console.log("(dry run — no changes written)");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
