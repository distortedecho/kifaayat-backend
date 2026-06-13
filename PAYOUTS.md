# Payouts Architecture — Multi-Method Plan

Status doc capturing the agreed payouts redesign. Read this before touching anything in `src/routes/stripe.ts`, `src/services/orderService.ts`, or anything seller-payout related.

Last updated during the Stripe Connect testing session — date in `git log`.

---

## What the client agreed to

Sellers pick ONE of three payout methods. Buyer always pays via Stripe regardless.

| Method | Seller provides | How they get paid |
|---|---|---|
| **Stripe Connect** | Full Stripe onboarding (KYC + bank + ID doc) — heavy | Automated transfer to their Connect account on delivery confirmation |
| **Wise** | Bank account details only (BSB / sort code / routing + account number) | Admin manually pushes from Kifaayat's Wise balance |
| **PayPal** | PayPal email only | Admin manually sends via PayPal Payouts |

**The `kifaayat_wallet` enum value is going away** as a user-facing choice. It becomes the internal mechanism that powers Wise + PayPal (money escrows with Kifaayat, manual disbursement after). Sellers don't see "kifaayat_wallet" anywhere.

---

## The escrow flip (the big architectural change)

### Today (Stripe Connect path)
Destination charges with `transfer_data.destination` → money INSTANTLY routes to seller's Connect account at payment time. No real escrow exists despite the UX claim.

### Target (all three methods)
Separate Charges and Transfers pattern:

```
Buyer pays via Stripe (always)
    ↓
Funds land in Kifaayat's Stripe balance (escrow phase — REAL escrow this time)
    ↓
Order: paid → seller accepts → shipped → delivered → buyer confirms
    ↓
On buyer confirm-received OR auto-complete cron:
    ├── If seller.payout_method = 'stripe':
    │     → stripe.transfers.create() to seller's acct_XXX (automatic)
    │
    ├── If seller.payout_method = 'wise':
    │     → mark seller_payouts row as 'ready_for_payout'
    │     → admin sees in dashboard, disburses via Wise, marks 'paid'
    │
    └── If seller.payout_method = 'paypal':
          → same as Wise — admin disburses via PayPal Payouts, marks 'paid'
```

The flow is the same up to delivery confirmation regardless of method. Only the disbursement step differs.

---

## Concrete change list

### 1. Schema additions

```sql
-- Extend payout_method enum (currently 'stripe' | 'kifaayat_wallet')
-- New values: 'stripe' | 'wise' | 'paypal'
-- Drop 'kifaayat_wallet' from the user-facing enum (still used internally as default)

-- Wise payout details on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_holder TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_bank_country TEXT
  CHECK (wise_bank_country IN ('AU','UK','US','CA','NZ'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_bank_currency TEXT
  CHECK (wise_bank_currency IN ('AUD','GBP','USD','CAD','NZD'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_routing_code TEXT;  -- BSB / sort code / routing / transit+institution
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_number TEXT; -- encrypted preferred
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_type TEXT;   -- US-only: checking/savings

-- PayPal payout details on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS paypal_email TEXT;

-- Payouts ledger — tracks each owed disbursement
CREATE TABLE IF NOT EXISTS seller_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES profiles(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,         -- seller_payout from the order
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('stripe','wise','paypal')),
  status TEXT NOT NULL CHECK (status IN ('pending','ready_for_payout','sent','paid','failed')),
  -- Method-specific references
  stripe_transfer_id TEXT,               -- when method=stripe and Transfer API was called
  external_reference TEXT,               -- admin types in Wise/PayPal transaction ID after manual disbursement
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(order_id)                       -- one payout per order
);

CREATE INDEX IF NOT EXISTS idx_seller_payouts_status_method ON seller_payouts(status, method);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_seller_id ON seller_payouts(seller_id);

ALTER TABLE seller_payouts ENABLE ROW LEVEL SECURITY;
-- Sellers can read their own payouts
CREATE POLICY "Sellers can read own payouts" ON seller_payouts FOR SELECT
  USING (seller_id IN (SELECT id FROM profiles WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'));
-- Only service role writes (no INSERT/UPDATE/DELETE from clients)
GRANT ALL ON seller_payouts TO service_role;
GRANT SELECT ON seller_payouts TO authenticated;
```

### 2. Payment-intent endpoint changes (`src/routes/stripe.ts`)

**Currently** (line ~357):
```typescript
if (sellerStripeAccountId && sellerOnboardingComplete) {
  intentParams.application_fee_amount = commission;
  intentParams.transfer_data = { destination: sellerStripeAccountId };
} else if (sellerPayoutMethod === "kifaayat_wallet") {
  // metadata only
} else {
  return c.json({ error: "..." }, 400);
}
```

**Target**: drop the destination-charge branch entirely. ALL payments go to Kifaayat's balance:

```typescript
// Verify seller has a working payout method configured
const hasStripe = sellerStripeAccountId && sellerOnboardingComplete;
const hasWise = sellerProfile?.payout_method === 'wise'
                && sellerProfile?.wise_account_holder
                && sellerProfile?.wise_account_number;
const hasPaypal = sellerProfile?.payout_method === 'paypal'
                  && sellerProfile?.paypal_email;

if (!hasStripe && !hasWise && !hasPaypal) {
  return c.json({ error: "Seller has not set up a payout method" }, 400);
}

// No transfer_data, no application_fee_amount — funds land fully in Kifaayat's balance
intentParams.metadata = {
  ...existing metadata,
  payout_method: hasStripe ? 'stripe' : sellerProfile.payout_method,
};
```

### 3. Webhook → create payout ledger row (`src/routes/stripe.ts` webhook handler)

After the existing order insert in `payment_intent.succeeded`:

```typescript
await supabase.from("seller_payouts").insert({
  seller_id: listing.seller_id,
  order_id: order.id,
  amount_cents: sellerPayout,
  currency,
  method: sellerProfile.payout_method || 'stripe', // resolved from seller's chosen method
  status: 'pending',
});
```

### 4. On delivery confirmation → trigger disbursement

In `src/routes/orders.ts`, both `/confirm-received` and `/complete` paths, after order status → 'complete':

```typescript
const { data: payout } = await supabase
  .from("seller_payouts")
  .select("*")
  .eq("order_id", orderId)
  .single();

if (payout?.method === 'stripe') {
  // Automated: call Stripe Transfers API
  await disburseViaStripe(payout, sellerStripeAccountId);
} else {
  // Manual: just flip status — admin will see and disburse via Wise/PayPal
  await supabase
    .from("seller_payouts")
    .update({ status: 'ready_for_payout', updated_at: new Date().toISOString() })
    .eq("id", payout.id);

  // Notify admin via push/email so they can act
  await notifyAdminPayoutReady(payout);
}
```

The `disburseViaStripe` helper:
```typescript
async function disburseViaStripe(payout, stripeAccountId) {
  try {
    const transfer = await getStripe().transfers.create({
      amount: payout.amount_cents,
      currency: payout.currency.toLowerCase(),
      destination: stripeAccountId,
      transfer_group: `payout_${payout.id}`,
      metadata: { payout_id: payout.id, order_id: payout.order_id },
    });
    await supabase
      .from("seller_payouts")
      .update({
        status: 'sent',
        stripe_transfer_id: transfer.id,
        sent_at: new Date().toISOString(),
      })
      .eq("id", payout.id);
  } catch (err) {
    await supabase
      .from("seller_payouts")
      .update({ status: 'failed', failure_reason: String(err) })
      .eq("id", payout.id);
    // Alert admin
  }
}
```

### 5. Admin endpoints (new)

```
GET  /api/admin/payouts?status=ready_for_payout   → list pending Wise/PayPal payouts
POST /api/admin/payouts/:id/mark-sent             → admin disbursed manually, records external_reference
POST /api/admin/payouts/:id/mark-failed           → admin couldn't disburse, records reason
```

The admin dashboard surfaces all `seller_payouts WHERE status='ready_for_payout' AND method IN ('wise','paypal')` with the seller's name + their bank/PayPal details inline, so the admin can copy-paste into Wise/PayPal and click "Mark sent" when done.

### 6. Seller-facing endpoints (new)

```
PUT /api/profiles/me/payout-method   → seller picks 'stripe' | 'wise' | 'paypal' and submits relevant fields
GET /api/profiles/me/payouts          → seller sees their payout history (existing seller_payouts rows)
```

### 7. Frontend changes (to be done by FE team)

- "Set up payouts" screen: tabs/radio for Stripe / Wise (Recommended for fast onboarding) / PayPal
- Stripe path: same as today (AccountLink onboarding)
- Wise path: bank details form per country, validate format client-side
- PayPal path: just email input
- Existing 1K Stripe Connect sellers default to Stripe — never see chooser unless they want to switch

---

## The Stripe fee issue (separate ticket, ask client)

When buyer pays via Stripe, Stripe takes ~2.9% + $0.30 processing fee off the top BEFORE any split. Currently the seller absorbs this silently. Three options to take to client:

1. **Kifaayat absorbs** — reduce commission by Stripe fee. Cleanest from seller perspective. Reduces Kifaayat's effective take from 15% → ~11.5%.
2. **Seller absorbs (status quo)** — but disclose in seller UI: "15% commission + ~3% processing"
3. **Buyer absorbs** — add a "service fee" line at checkout (~3-4% of total). Most marketplaces do this.

**TBD: needs client decision before implementing.**

In the new escrow architecture, this becomes easier to control because Kifaayat receives the gross amount and can decide how to split. Today's destination-charge math is rigid.

---

## What's already done (don't redo)

| Feature | Status |
|---|---|
| Stripe Connect Express account creation (`POST /api/stripe/create-account`) | ✅ working |
| AccountLink generation (`GET /api/stripe/onboarding-url`) | ✅ working |
| Account verification status (`GET /api/stripe/account-status`) | ✅ working |
| Webhook handler for `account.updated` (flips `stripe_onboarding_complete`) | ✅ working |
| Webhook handler for `payment_intent.succeeded` (creates order) | ✅ working — keep, just remove `transfer_data` from PaymentIntent creation |
| Idempotency on order creation by `stripe_payment_intent_id` | ✅ working |
| `orders.amount / item_amount / shipping_amount / voucher_discount / commission_amount / seller_payout` | ✅ all populated correctly |

The Stripe Connect flow for sellers is fully tested end-to-end as of this discussion. The change is NOT replacing it — it's *adding* two more methods and changing WHEN the seller gets paid (delivery vs payment time).

---

## Implementation order

1. **Schema**: add `seller_payouts` table, payout details columns on profiles. **30 min, no dependencies.**
2. **Switch payment intent to escrow**: drop `transfer_data` and `application_fee_amount`, leave funds in Kifaayat's balance. Update webhook to insert `seller_payouts` row with `status='pending'`. **~2 hours.**
3. **Disbursement on confirm-received**: helper that calls Stripe Transfer for Stripe sellers, marks `ready_for_payout` for Wise/PayPal sellers. Wire into `/confirm-received` and `/complete` and the auto-complete cron. **~2 hours.**
4. **Seller payout-method endpoint**: `PUT /api/profiles/me/payout-method` to capture choice + relevant fields. **~1 hour.**
5. **Admin endpoints + dashboard query**: list of pending manual payouts with all the info admin needs to disburse. **~2 hours.**
6. **Migration of existing Stripe Connect sellers**: backfill `seller_payouts` for existing in-flight orders. Default `payout_method='stripe'` for anyone with `stripe_onboarding_complete=true`. **~30 min for migration script.**

Total: ~1 day of focused work. Test end-to-end on staging before flipping over.

---

## Open questions for the client

1. **Stripe fee absorption policy** — Kifaayat / Seller / Buyer? (Asked above.)
2. **Manual payout SLA promise to seller** — "Payouts within X business days of delivery"? Suggest 3-5 days.
3. **What about existing 1K Stripe Connect sellers when they migrate?** Default them to `payout_method='stripe'` and they continue as today (just on the new escrow architecture)?
4. **Admin notification channel** — push notification, email, both? Right now no admin notification path exists.
5. **What happens if seller doesn't set up ANY payout method** but has live listings + a sale? Suggest: block the seller from receiving sales until they set one up. Buyer-facing message: "Seller is currently unavailable."
6. **Refund handling — split into two windows**:
   - **Pre-delivery refunds** (seller rejects, auto-rejects, buyer cancels, order fails): once we're on the escrow architecture these become trivial — funds never left Kifaayat, just `stripe.refunds.create()` and done. No clawback from seller, no negative-balance risk. **Escrow solves this case entirely** vs today where destination charges force Stripe to claw funds back from the seller's Connect account (which can leave them negative if they already withdrew).
   - **Post-delivery refunds / chargebacks** (buyer disputes via card issuer weeks later, return-and-refund agreed between parties): money has already been disbursed to seller. Same clawback problem as today — need a flow to either reverse the Stripe Transfer (if seller has balance) or invoice the seller for the difference. **Not solved by escrow alone.** Worth a dedicated design pass once the core escrow is in place.

   Net effect: escrow dramatically improves the common case (most refunds happen pre-delivery) and shortens the window where money is at risk. The harder edge case still needs a clawback design, but with much lower volume.

---

## Things that ABSOLUTELY DON'T CHANGE

- Buyer always pays via Stripe
- Buyer's checkout flow stays identical
- All amount math (commission, voucher_discount, item_amount, shipping_amount) stays as-is
- Order lifecycle (paid → shipped → delivered → complete) stays
- Notifications (`order_paid`, `order_shipped`, etc.) stay
- Voucher logic stays
- ISO posts, listings, reviews, conversations — all untouched

This is purely a change to **when and how money flows out to the seller**.

---

## TL;DR for future-me reading this after compaction

> We're replacing the destination-charge Stripe Connect path with a real escrow architecture. All buyer payments land in Kifaayat's Stripe balance. On delivery confirmation, we either (a) auto-transfer to seller's Stripe Connect account if they chose Stripe, or (b) mark a `seller_payouts` row as `ready_for_payout` for the admin to manually disburse via Wise or PayPal. The `kifaayat_wallet` enum is no longer a user-facing choice — it's just how Wise/PayPal route internally. The Stripe Connect flow itself (onboarding, webhooks, account status) doesn't change; we're only changing the payment routing and adding two more payout methods.
