-- ============================================================
-- Schema Migration 08 — Multi-method Payouts (true escrow)
-- ============================================================
-- Adds Wise + PayPal payout details to profiles and introduces
-- a seller_payouts ledger that tracks every owed disbursement.
--
-- Architecture: all buyer payments now land in Kifaayat's Stripe
-- balance regardless of seller payout method. On delivery
-- confirmation we either (a) call stripe.transfers.create for
-- Stripe Connect sellers, or (b) mark `ready_for_payout` for the
-- admin to manually disburse via Wise / PayPal.
--
-- Run order: schema.sql → schema-06.sql → schema-07.sql → schema-08.sql
-- All statements use IF NOT EXISTS so re-running is safe.
-- See PAYOUTS.md for the full design rationale.
-- ============================================================


-- -------------------------
-- profiles — payout method details
-- -------------------------

-- Wise — admin manually pushes from Kifaayat's Wise balance using
-- these bank details after the order completes. Kept loose (TEXT,
-- no per-field validation in the DB) because the routing/account
-- format differs by country — validation lives in the application
-- layer.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_holder TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_bank_country TEXT
  CHECK (wise_bank_country IS NULL OR wise_bank_country IN ('AU','UK','US','CA','NZ'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_bank_currency TEXT
  CHECK (wise_bank_currency IS NULL OR wise_bank_currency IN ('AUD','GBP','USD','CAD','NZD'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_routing_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wise_account_type TEXT
  CHECK (wise_account_type IS NULL OR wise_account_type IN ('checking', 'savings'));

-- PayPal — admin disburses via PayPal Payouts using this email.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS paypal_email TEXT;


-- -------------------------
-- seller_payouts — disbursement ledger
-- -------------------------

CREATE TABLE IF NOT EXISTS seller_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id UUID NOT NULL REFERENCES profiles(id),
  order_id UUID NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('stripe', 'wise', 'paypal')),
  -- Lifecycle:
  --   pending           — order paid, escrow holding funds, not yet released
  --   ready_for_payout  — buyer confirmed delivery; for wise/paypal, admin should disburse
  --   sent              — stripe.transfers.create succeeded (stripe method only)
  --   paid              — admin marked manual payout complete (wise/paypal only)
  --   failed            — disbursement attempt failed; needs intervention
  --   cancelled         — order was rejected/refunded before disbursement
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready_for_payout', 'sent', 'paid', 'failed', 'cancelled')),
  stripe_transfer_id TEXT,
  external_reference TEXT,
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_seller_payouts_status_method ON seller_payouts(status, method);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_seller_id ON seller_payouts(seller_id);
CREATE INDEX IF NOT EXISTS idx_seller_payouts_created_at ON seller_payouts(created_at DESC);

ALTER TABLE seller_payouts ENABLE ROW LEVEL SECURITY;

-- Sellers can read their own payout rows.
DROP POLICY IF EXISTS "Sellers can read own payouts" ON seller_payouts;
CREATE POLICY "Sellers can read own payouts"
  ON seller_payouts FOR SELECT
  USING (
    seller_id IN (
      SELECT id FROM profiles
      WHERE clerk_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- Service role does all writes via admin SDK; clients never write.
GRANT ALL ON seller_payouts TO service_role;
GRANT SELECT ON seller_payouts TO authenticated;

-- updated_at maintenance trigger (mirrors other tables)
CREATE OR REPLACE FUNCTION set_seller_payouts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seller_payouts_updated_at ON seller_payouts;
CREATE TRIGGER trg_seller_payouts_updated_at
  BEFORE UPDATE ON seller_payouts
  FOR EACH ROW
  EXECUTE FUNCTION set_seller_payouts_updated_at();
