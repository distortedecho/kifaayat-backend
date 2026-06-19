-- ============================================================
-- Schema Migration 15 — UNIQUE on orders.stripe_payment_intent_id
--                       (+ cleanup of existing duplicates)
-- ============================================================
-- Two code paths (orderService + payment_intent.succeeded webhook)
-- race on SELECT-then-INSERT for the same Stripe charge. Without a
-- unique constraint on stripe_payment_intent_id, both can land
-- their INSERT, producing two order rows and two seller pushes.
--
-- Real data sample (from production debugging):
--   pi_3Tk20a... → 2 orders, 84ms apart
--   pi_3Tk0RR... → 2 orders, 304ms apart
-- One in each pair has progressed (status='complete'), the other
-- is an orphan stuck at 'paid'.
--
-- Cleanup picks the keeper by status priority — whichever row the
-- FE has been driving is whichever is most progressed through the
-- lifecycle. Status order (most → least progressed):
--   complete > delivered > shipped > paid > cancelled
-- Tie-break on created_at ASC.
--
-- Then the partial UNIQUE INDEX prevents the race from happening
-- again. Both writers already catch postgres 23505 and return the
-- existing row (no duplicate notification).
--
-- Scoped via inline CTEs (not temp tables — Supabase's linter
-- flags those generically). Scans are bounded to PIs that actually
-- have a duplicate, so this runs in well under a second even on a
-- big orders table.
--
-- Run order: ... → schema-14.sql → schema-15.sql
-- ============================================================

BEGIN;

-- Step 1: drop seller_payouts rows pointing at the orphan orders.
-- (NOT NULL FK with no ON DELETE clause — only blocking FK on
-- orders; everything else is ON DELETE SET NULL.)
WITH dups AS (
  SELECT stripe_payment_intent_id
  FROM orders
  WHERE stripe_payment_intent_id IS NOT NULL
    AND created_at > NOW() - INTERVAL '60 days'
  GROUP BY stripe_payment_intent_id
  HAVING COUNT(*) > 1
),
to_delete AS (
  SELECT o.id
  FROM orders o
  JOIN dups d ON d.stripe_payment_intent_id = o.stripe_payment_intent_id
  WHERE o.id <> (
    SELECT id
    FROM orders
    WHERE stripe_payment_intent_id = o.stripe_payment_intent_id
    ORDER BY
      CASE status
        WHEN 'complete'  THEN 1
        WHEN 'delivered' THEN 2
        WHEN 'shipped'   THEN 3
        WHEN 'paid'      THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 99
      END ASC,
      created_at ASC
    LIMIT 1
  )
)
DELETE FROM seller_payouts
WHERE order_id IN (SELECT id FROM to_delete);

-- Step 2: drop the orphan orders themselves. Same CTE because each
-- statement is independent; the transaction guarantees atomicity.
WITH dups AS (
  SELECT stripe_payment_intent_id
  FROM orders
  WHERE stripe_payment_intent_id IS NOT NULL
    AND created_at > NOW() - INTERVAL '60 days'
  GROUP BY stripe_payment_intent_id
  HAVING COUNT(*) > 1
),
to_delete AS (
  SELECT o.id
  FROM orders o
  JOIN dups d ON d.stripe_payment_intent_id = o.stripe_payment_intent_id
  WHERE o.id <> (
    SELECT id
    FROM orders
    WHERE stripe_payment_intent_id = o.stripe_payment_intent_id
    ORDER BY
      CASE status
        WHEN 'complete'  THEN 1
        WHEN 'delivered' THEN 2
        WHEN 'shipped'   THEN 3
        WHEN 'paid'      THEN 4
        WHEN 'cancelled' THEN 5
        ELSE 99
      END ASC,
      created_at ASC
    LIMIT 1
  )
)
DELETE FROM orders
WHERE id IN (SELECT id FROM to_delete);

-- Step 3: partial index so historic NULLs (and non-Stripe payouts)
-- don't conflict. Going forward, both writers' 23505 handlers turn
-- the second-to-arrive INSERT into a silent no-op.
CREATE UNIQUE INDEX IF NOT EXISTS orders_stripe_payment_intent_id_unique
  ON orders(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMIT;
