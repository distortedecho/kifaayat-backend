// ============================================================
// Reviews importer — batched
//
// All 90 historic reviews imported as already-revealed
// (revealed_at = createdAt). Listing reference uses the fallback
// chain: review.listingId direct → transaction.listingId via
// review.transactionId.
//
// Sharetribe review types:
//   ofProvider → buyer reviewing seller
//   ofCustomer → seller reviewing buyer
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import type {
  SharetribeReview,
  SharetribeTransaction,
} from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

interface TxRefs {
  customerId: string;
  providerId: string;
  listingId: string;
}

export async function importReviews(
  ctx: MigrationContext,
  reviews: SharetribeReview[],
  transactions: SharetribeTransaction[]
): Promise<void> {
  console.log(`[reviews] importing ${reviews.length} reviews`);

  const txRefsByLegacyId = new Map<string, TxRefs>();
  for (const t of transactions) {
    txRefsByLegacyId.set(t.id, {
      customerId: t.attributes.customerId,
      providerId: t.attributes.providerId,
      listingId: t.attributes.listingId,
    });
  }

  type ReviewRow = {
    order_id: string | null;
    reviewer_id: string;
    reviewee_id: string;
    reviewer_role: "buyer" | "seller";
    rating: number;
    comment: string | null;
    visible: boolean;
    revealed_at: string;
    created_at: string;
    updated_at: string;
    legacy_sharetribe_id: string;
  };

  const rows: ReviewRow[] = [];

  for (const r of reviews) {
    try {
      const a = r.attributes;
      const txRefs = txRefsByLegacyId.get(a.transactionId);

      // Reviewer/reviewee come from the transaction's customer + provider.
      if (!txRefs) {
        ctx.stats.reviews.skipped_orphan += 1;
        continue;
      }

      const buyerProfileId = ctx.userIdMap.get(txRefs.customerId);
      const sellerProfileId = ctx.userIdMap.get(txRefs.providerId);
      if (!buyerProfileId || !sellerProfileId) {
        ctx.stats.reviews.skipped_orphan += 1;
        continue;
      }

      // listing_id resolution: direct first, then via transaction.
      let listingId: string | null = ctx.listingIdMap.get(a.listingId) ?? null;
      if (!listingId) {
        const viaTx = ctx.listingIdMap.get(txRefs.listingId);
        if (viaTx) {
          listingId = viaTx;
          ctx.stats.reviews.resolved_via_transaction += 1;
        }
      }
      // listingId not strictly needed for our reviews schema; order_id is
      // already nullable and we don't store listing_id on review rows.

      const reviewerRole: "buyer" | "seller" =
        a.type === "ofProvider" ? "buyer" : "seller";
      const reviewerId = reviewerRole === "buyer" ? buyerProfileId : sellerProfileId;
      const revieweeId = reviewerRole === "buyer" ? sellerProfileId : buyerProfileId;

      // Link to the order if the matching transaction was migrated as a
      // paid order. orderIdMap is populated by importOrders. For inquiry-
      // only transactions (no payment), this stays null — schema allows
      // it via ON DELETE SET NULL.
      const orderId = ctx.orderIdMap.get(a.transactionId) ?? null;

      rows.push({
        order_id: orderId,
        reviewer_id: reviewerId,
        reviewee_id: revieweeId,
        reviewer_role: reviewerRole,
        rating: a.rating,
        comment: a.content ?? null,
        visible: true,
        revealed_at: a.createdAt,
        created_at: a.createdAt,
        updated_at: a.createdAt,
        legacy_sharetribe_id: r.id,
      });
    } catch (err) {
      logError(ctx, "reviews", r.id, err);
    }
  }

  if (ctx.dryRun) {
    ctx.stats.reviews.inserted = rows.length;
    console.log(
      `[reviews] dry-run — would insert ${rows.length}, ` +
        `via_transaction_fallback=${ctx.stats.reviews.resolved_via_transaction}, ` +
        `orphans=${ctx.stats.reviews.skipped_orphan}`
    );
    return;
  }

  const batches = chunk(rows, DEFAULT_BATCH_SIZE);
  let inserted = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO reviews ${ctx.sql(
          batches[i],
          "order_id",
          "reviewer_id",
          "reviewee_id",
          "reviewer_role",
          "rating",
          "comment",
          "visible",
          "revealed_at",
          "created_at",
          "updated_at",
          "legacy_sharetribe_id"
        )}
        ON CONFLICT (legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL
        DO NOTHING
      `;
      inserted += batches[i].length;
    } catch (err) {
      logError(ctx, "reviews", `batch[${i}]`, err);
    }
  }
  ctx.stats.reviews.inserted = inserted;

  console.log(
    `[reviews] done — inserted=${inserted}, ` +
      `via_transaction_fallback=${ctx.stats.reviews.resolved_via_transaction}, ` +
      `orphans=${ctx.stats.reviews.skipped_orphan}`
  );
}
