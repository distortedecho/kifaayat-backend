// ============================================================
// Cross-border payout feasibility check (Stripe TEST MODE)
//
// Question we're answering: our AU platform can't create a
// standalone cross-border Transfer to a US/UK connected account
// ("Funds can't be sent to accounts located in US because it's
// restricted outside of your platform's region"). The Vietnam
// devs' existing app pays non-AU sellers via DESTINATION CHARGES
// (on_behalf_of + transfer_data[destination]) instead. This
// script proves whether that path works from our AU platform
// BEFORE we rewrite the payment core.
//
// It runs three checks against a fully-onboarded test connected
// account:
//   1. Capability check      — is `transfers` active on the account?
//   2. Control (reproduce)   — standalone transfer, expected to FAIL
//   3. Destination charge    — the proposed fix, expected to SUCCEED
//   4. Trace                 — confirm the charge created a tr_... transfer
//
// SAFE: test mode only (refuses to run on a live key). Creates a
// tiny $50 charge with a test card. No production data touched.
//
// Usage:
//   # Use an existing fully-onboarded US test connected account:
//   STRIPE_SECRET_KEY=sk_test_... \
//   tsx scripts/test-xborder.ts --account acct_XXXX [--currency aud]
//
//   # Or let the script create a ready-to-go US test account for you:
//   STRIPE_SECRET_KEY=sk_test_... \
//   tsx scripts/test-xborder.ts --create [--country US] [--currency aud]
// ============================================================

import "dotenv/config";
import Stripe from "stripe";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const accountArg = arg("--account");
const create = hasFlag("--create");
const createCountry = (arg("--country") ?? "US").toUpperCase();
const currency = (arg("--currency") ?? "aud").toLowerCase();

if (!accountArg && !create) {
  console.error(
    "Provide either --account or --create. Usage:\n" +
      "  tsx scripts/test-xborder.ts --account acct_XXXX [--currency aud]\n" +
      "  tsx scripts/test-xborder.ts --create [--country US] [--currency aud]"
  );
  process.exit(1);
}

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set");
  process.exit(1);
}
if (!key.startsWith("sk_test_")) {
  console.error(
    "Refusing to run: STRIPE_SECRET_KEY is not a test key (must start with sk_test_)."
  );
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });

const AMOUNT = 5000; // $50.00 in cents
const FEE = 500; // $5.00 platform commission

function line() {
  console.log("─".repeat(60));
}

// Test-mode bank details per country. These are Stripe's documented
// test external-account numbers that pass instantly.
type ExternalAccount = Stripe.AccountCreateParams["external_account"];
const TEST_BANK: Record<string, { currency: string; fields: ExternalAccount }> = {
  US: {
    currency: "usd",
    fields: {
      object: "bank_account",
      country: "US",
      currency: "usd",
      routing_number: "110000000",
      account_number: "000123456789",
    },
  },
  GB: {
    currency: "gbp",
    fields: {
      object: "bank_account",
      country: "GB",
      currency: "gbp",
      routing_number: "108800",
      account_number: "00012345",
    },
  },
};

// Create a fully-activated Custom test connected account. The magic
// values (address line1 "address_full_match", ssn_last_4 "0000",
// id_number "000000000") make identity verification pass instantly in
// test mode, so card_payments + transfers go active immediately.
async function createTestAccount(country: string): Promise<string> {
  const bank = TEST_BANK[country];
  if (!bank) {
    throw new Error(
      `No test bank config for ${country}. Supported: ${Object.keys(TEST_BANK).join(", ")}`
    );
  }
  const acct = await stripe.accounts.create({
    type: "custom",
    country,
    email: "xborder-test@example.com",
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      mcc: "5691",
      url: "https://example.com",
      product_description: "Cross-border feasibility test seller",
    },
    individual: {
      first_name: "Test",
      last_name: "Seller",
      email: "xborder-test@example.com",
      phone: "+15555555555",
      id_number: "000000000",
      ssn_last_4: "0000",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "address_full_match",
        city: country === "GB" ? "London" : "San Francisco",
        state: country === "GB" ? undefined : "CA",
        postal_code: country === "GB" ? "WC2N 5DU" : "94103",
        country,
      },
    } as unknown as Stripe.AccountCreateParams.Individual,
    external_account: bank.fields,
    tos_acceptance: {
      // Fixed past timestamp — Date.now() is fine in a one-shot script,
      // but a constant keeps re-runs deterministic and avoids clock edge cases.
      date: 1704067200, // 2024-01-01
      ip: "127.0.0.1",
    },
  });
  return acct.id;
}

async function main() {
  const accountId = create
    ? await (async () => {
        console.log(`Creating a ${createCountry} test connected account…`);
        const id = await createTestAccount(createCountry);
        console.log(`Created: ${id}\n`);
        return id;
      })()
    : (accountArg as string);

  console.log(`Cross-border check → account=${accountId} currency=${currency}\n`);

  // ---- 0. Platform account region ----
  const platform = await stripe.accounts.retrieve();
  console.log(`Platform country: ${platform.country}`);

  // ---- 1. Capability check ----
  line();
  console.log("1. Capability check");
  const acct = await stripe.accounts.retrieve(accountId);
  const transfers = acct.capabilities?.transfers ?? "missing";
  const cardPayments = acct.capabilities?.card_payments ?? "missing";
  console.log(`   country:        ${acct.country}`);
  console.log(`   transfers:      ${transfers}`);
  console.log(`   card_payments:  ${cardPayments}`);
  console.log(`   charges_enabled:${acct.charges_enabled}`);
  if (acct.country === platform.country) {
    console.log(
      `   ⚠️  Connected account is SAME country as platform — this ` +
        `won't test cross-border. Use a US/UK test account.`
    );
  }
  if (transfers !== "active") {
    console.log(
      `   ⚠️  transfers capability is not active. The tests below will ` +
        `likely fail for that reason, not because of cross-border rules. ` +
        `Finish onboarding this account first.`
    );
  }

  // ---- 2. Control: standalone transfer (reproduce the failure) ----
  line();
  console.log("2. Control — standalone cross-border transfer (expect FAIL)");
  try {
    // Fund the platform balance in test mode so the transfer has
    // something to draw from; otherwise we'd get an insufficient-funds
    // error instead of the cross-border error we're trying to reproduce.
    await stripe.charges.create({
      amount: AMOUNT,
      currency,
      source: "tok_bypassPending", // test token: instantly-available funds
      description: "xborder-check: fund platform balance",
    });
    const transfer = await stripe.transfers.create({
      amount: AMOUNT - FEE,
      currency,
      destination: accountId,
    });
    console.log(
      `   ❗ Unexpected: standalone transfer SUCCEEDED (${transfer.id}). ` +
        `Either this account is same-region or AU cross-border transfers ` +
        `are allowed for this pair.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ✅ Failed as expected: ${msg}`);
  }

  // ---- 3. Destination charge (the proposed fix) ----
  line();
  console.log("3. Destination charge — on_behalf_of + transfer_data (expect SUCCEED)");
  let piId: string | undefined;
  try {
    const pi = await stripe.paymentIntents.create({
      amount: AMOUNT,
      currency,
      payment_method_types: ["card"],
      payment_method: "pm_card_visa",
      confirm: true,
      on_behalf_of: accountId,
      transfer_data: { destination: accountId },
      application_fee_amount: FEE,
      metadata: { test: "xborder_check" },
    });
    piId = pi.id;
    console.log(`   PaymentIntent: ${pi.id} status=${pi.status}`);
    if (pi.status === "succeeded") {
      console.log(`   ✅ Destination charge SUCCEEDED — cross-border works!`);
    } else {
      console.log(
        `   ⚠️  Status is "${pi.status}" (not succeeded). If "requires_action", ` +
          `the test card triggered 3DS — retry with a non-3DS card.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`   ❌ Destination charge FAILED: ${msg}`);
    console.log(
      `   → If this mentions region/cross-border, destination charges ` +
        `alone don't lift the AU restriction. Escalate to Stripe.`
    );
  }

  // ---- 4. Trace: confirm a transfer to the connected account ----
  if (piId) {
    line();
    console.log("4. Trace — did the charge create a transfer to the seller?");
    const pi = await stripe.paymentIntents.retrieve(piId, {
      expand: ["latest_charge"],
    });
    const charge = pi.latest_charge as Stripe.Charge | null;
    const transferId =
      typeof charge?.transfer === "string"
        ? charge.transfer
        : charge?.transfer?.id;
    if (transferId) {
      console.log(`   ✅ Transfer created: ${transferId}`);
      console.log(`   Funds are traceable charge → seller. This is the model to adopt.`);
    } else {
      console.log(`   ⚠️  No transfer found on the charge. Inspect ${piId} in dashboard.`);
    }
  }

  line();
  console.log("\nDone. Summary:");
  console.log("  • Step 2 fails + Step 3 succeeds → implement destination charges.");
  console.log("  • Step 2 fails + Step 3 fails    → AU can't; escalate to Stripe.");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
