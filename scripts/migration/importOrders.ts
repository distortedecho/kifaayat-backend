// ============================================================
// Orders importer — batched
//
// Only the ~80 Sharetribe transactions with payIns. Historic orders
// — do NOT replay disbursement; they settled on Stripe long ago.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import {
  dollarsToCents,
  mapTransactionStatus,
  type OrderStatus,
} from "./mappings.js";
import type { SharetribeTransaction } from "./types.js";
import { generateOrderNumber } from "../../src/types/transactions.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

export async function importOrders(
  ctx: MigrationContext,
  transactions: SharetribeTransaction[]
): Promise<void> {
  const paid = transactions.filter(
    (t) => (t.attributes.payIns?.length ?? 0) > 0
  );
  console.log(`[orders] importing ${paid.length} paid transactions`);

  type OrderRow = {
    order_number: string;
    listing_id: string;
    buyer_id: string;
    seller_id: string;
    buyer_email: string;
    amount: number;
    item_amount: number;
    shipping_amount: number;
    currency: string;
    commission_rate: number;
    commission_amount: number;
    seller_payout: number;
    stripe_payment_intent_id: string | null;
    status: OrderStatus;
    seller_accepted_at: string | null;
    shipped_at: string | null;
    delivered_at: string | null;
    completed_at: string | null;
    legacy_sharetribe_id: string;
    created_at: string;
    updated_at: string;
  };

  const rows: OrderRow[] = [];

  for (const t of paid) {
    try {
      const a = t.attributes;
      const buyerId = a.customerId ? ctx.userIdMap.get(a.customerId) : undefined;
      const sellerId = a.providerId
        ? ctx.userIdMap.get(a.providerId)
        : undefined;
      const listingId = a.listingId
        ? ctx.listingIdMap.get(a.listingId)
        : undefined;
      if (!buyerId || !sellerId || !listingId) {
        ctx.stats.orders.skipped_orphan += 1;
        continue;
      }

      const payIn = a.payIns?.[0];
      if (!payIn) {
        ctx.stats.orders.skipped_orphan += 1;
        continue;
      }

      const amount =
        dollarsToCents(a.payinTotal?.amount ?? payIn.amount.amount) ?? 0;
      const sellerPayout = dollarsToCents(a.payoutTotal?.amount ?? 0) ?? 0;
      const commissionAmount = Math.max(0, amount - sellerPayout);
      const currency = (
        a.payinTotal?.currency ?? payIn.amount.currency ?? "AUD"
      ).toUpperCase();

      let commissionRate = 0;
      const commissionLine = a.lineItems?.find(
        (li) => li.code === "line-item/provider-commission"
      );
      if (
        commissionLine?.percentage !== undefined &&
        commissionLine.percentage !== null
      ) {
        commissionRate = Math.abs(commissionLine.percentage);
      } else if (amount > 0) {
        commissionRate = Math.round((commissionAmount / amount) * 10000) / 100;
      }

      const status: OrderStatus = mapTransactionStatus(a.lastTransition);

      // Backfill lifecycle timestamps so the new app's order-timeline UI
      // renders all the ticks for historic orders. Sharetribe doesn't
      // expose per-transition timestamps in the export, only createdAt
      // (when the transaction started) and lastTransitionedAt (when it
      // last changed state). We make defensible-but-rough assumptions:
      //   - completed orders walked through every step, so populate
      //     accepted/shipped/delivered + completed
      //   - cancelled orders never got accepted
      //   - everything else gets accepted only (rare in legacy data)
      const isComplete = status === "complete";
      const isCancelled = status === "cancelled";
      const ts = a.lastTransitionedAt ?? a.createdAt;
      const sellerAcceptedAt = isCancelled ? null : a.createdAt;
      const shippedAt = isComplete ? a.createdAt : null;
      const deliveredAt = isComplete ? ts : null;
      const completedAt = isComplete ? ts : null;

      rows.push({
        order_number: generateOrderNumber(),
        listing_id: listingId,
        buyer_id: buyerId,
        seller_id: sellerId,
        buyer_email: "",
        amount,
        item_amount: amount,
        shipping_amount: 0,
        currency,
        commission_rate: commissionRate,
        commission_amount: commissionAmount,
        seller_payout: sellerPayout,
        stripe_payment_intent_id: payIn.stripePaymentIntentId ?? null,
        status,
        seller_accepted_at: sellerAcceptedAt,
        shipped_at: shippedAt,
        delivered_at: deliveredAt,
        completed_at: completedAt,
        legacy_sharetribe_id: t.id,
        created_at: a.createdAt,
        updated_at: a.lastTransitionedAt ?? a.createdAt,
      });
    } catch (err) {
      logError(ctx, "orders", t.id, err);
    }
  }

  if (ctx.dryRun) {
    // Populate orderIdMap with placeholders so importReviews's dry-run
    // can still resolve refs.
    for (const r of rows) {
      ctx.orderIdMap.set(r.legacy_sharetribe_id, `dry-${r.legacy_sharetribe_id}`);
    }
    ctx.stats.orders.inserted = rows.length;
    console.log(
      `[orders] dry-run — would insert ${rows.length}, orphans=${ctx.stats.orders.skipped_orphan}`
    );
    return;
  }

  const batches = chunk(rows, DEFAULT_BATCH_SIZE);
  let inserted = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO orders ${ctx.sql(
          batches[i],
          "order_number",
          "listing_id",
          "buyer_id",
          "seller_id",
          "buyer_email",
          "amount",
          "item_amount",
          "shipping_amount",
          "currency",
          "commission_rate",
          "commission_amount",
          "seller_payout",
          "stripe_payment_intent_id",
          "status",
          "seller_accepted_at",
          "shipped_at",
          "delivered_at",
          "completed_at",
          "legacy_sharetribe_id",
          "created_at",
          "updated_at"
        )}
        ON CONFLICT (legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL
        DO NOTHING
      `;
      inserted += batches[i].length;
    } catch (err) {
      logError(ctx, "orders", `batch[${i}]`, err);
    }
  }
  ctx.stats.orders.inserted = inserted;

  // Bulk-fill orderIdMap so importReviews can link reviews → orders.
  // The map uses Sharetribe transaction UUID (= legacy_sharetribe_id) as key.
  const sharetribeIds = rows.map((r) => r.legacy_sharetribe_id);
  type IdRow = { id: string; legacy_sharetribe_id: string };
  for (const idChunk of chunk(sharetribeIds, 2000)) {
    const found = (await ctx.sql`
      SELECT id, legacy_sharetribe_id FROM orders
      WHERE legacy_sharetribe_id = ANY(${idChunk})
    `) as unknown as IdRow[];
    for (const r of found) {
      ctx.orderIdMap.set(r.legacy_sharetribe_id, r.id);
    }
  }

  console.log(
    `[orders] done — inserted=${inserted}, mapped=${ctx.orderIdMap.size}, ` +
      `orphans=${ctx.stats.orders.skipped_orphan}`
  );
}
