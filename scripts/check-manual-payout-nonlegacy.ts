// ============================================================
// Check payout schedule for NON-Sharetribe (real app) sellers
//
// Read-only audit. Walks every profile that has a Stripe connected
// account AND is NOT a migrated Sharetribe user (legacy_sharetribe_id
// IS NULL), and reports whether each account is on a MANUAL payout
// schedule (our escrow requirement for destination charges).
//
// Migrated users are excluded on purpose: their stripe_account_id values
// came from Sharetribe and mostly don't exist on our platform (they'd
// return account_invalid), so they'd only add noise.
//
// By default makes NO changes (audit only). Pass --fix to switch any
// non-manual account to a manual payout schedule.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SECRET_KEY=... \
//   tsx scripts/check-manual-payout-nonlegacy.ts [--fix] [--limit N]
// ============================================================

import "dotenv/config";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const fix = process.argv.includes("--fix");
const limit = argValue("--limit") ? parseInt(argValue("--limit")!, 10) : Infinity;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(
    `${fix ? "Fix" : "Audit"} payout schedule — NON-Sharetribe sellers ` +
      `(mode=${stripeKey!.startsWith("sk_live_") ? "LIVE" : "TEST"})\n`
  );

  // Page through non-legacy profiles with a connected account.
  const pageSize = 500;
  let from = 0;
  const accounts: { profileId: string; acctId: string }[] = [];
  for (;;) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, stripe_account_id")
      .not("stripe_account_id", "is", null)
      .is("legacy_sharetribe_id", null)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Failed to load profiles:", error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.stripe_account_id) {
        accounts.push({
          profileId: row.id as string,
          acctId: row.stripe_account_id as string,
        });
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const targets = accounts.slice(0, limit);
  console.log(
    `${accounts.length} non-Sharetribe connected accounts; checking ${targets.length}\n`
  );

  let manual = 0;
  let fixed = 0;
  const stillNotManual: string[] = [];
  let invalid = 0;
  let failed = 0;

  for (const { profileId, acctId } of targets) {
    try {
      const acct = await stripe.accounts.retrieve(acctId);
      const interval = acct.settings?.payouts?.schedule?.interval ?? "unknown";
      if (interval === "manual") {
        manual += 1;
        continue;
      }

      if (!fix) {
        stillNotManual.push(`${acctId} (interval=${interval}, profile=${profileId})`);
        continue;
      }

      // --fix: switch it to manual.
      await stripe.accounts.update(acctId, {
        settings: { payouts: { schedule: { interval: "manual" } } },
      });
      fixed += 1;
      console.log(`  ✅ ${acctId} (was ${interval}) → manual`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("account_invalid") || msg.toLowerCase().includes("does not exist")) {
        invalid += 1;
      } else {
        failed += 1;
        console.error(`  ❌ ${acctId} failed: ${msg}`);
      }
    }
    await sleep(60);
  }

  if (!fix && stillNotManual.length > 0) {
    console.log("Accounts NOT on manual:");
    for (const line of stillNotManual) console.log(`  ⚠️  ${line}`);
    console.log("");
  }

  console.log(
    `Done. manual=${manual} ${fix ? `fixed=${fixed}` : `notManual=${stillNotManual.length}`} ` +
      `invalid=${invalid} failed=${failed}`
  );

  if (fix) {
    console.log(
      fixed > 0
        ? `\nSwitched ${fixed} account(s) to manual. ✅`
        : `\nNothing to fix — all were already on manual. ✅`
    );
  } else if (stillNotManual.length > 0) {
    console.log("\nRe-run with --fix to switch these to manual.");
  } else {
    console.log("\nAll non-Sharetribe connected accounts are on manual. ✅");
  }
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
