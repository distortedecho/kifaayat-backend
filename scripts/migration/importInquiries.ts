// ============================================================
// Legacy inquiries importer — batched
//
// The 946 Sharetribe inquiry-only transactions land in a dedicated
// admin-only `legacy_inquiries` table. The new app deliberately
// doesn't support pre-transaction chat, so these stay as a support
// archive (helpdesk can look them up by email or listing).
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import type { SharetribeTransaction, SharetribeUser } from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

interface InquiryMessage {
  id: string;
  created_at: string;
  content: string;
  sender_legacy_id: string;
  sender_email: string | null;
}

export async function importInquiries(
  ctx: MigrationContext,
  transactions: SharetribeTransaction[],
  users: SharetribeUser[]
): Promise<void> {
  const sharetribeUserEmails = new Map<string, string>();
  for (const u of users) {
    if (u.attributes.email) {
      sharetribeUserEmails.set(u.id, u.attributes.email.toLowerCase());
    }
  }

  const inquiries = transactions.filter(
    (t) => (t.attributes.payIns?.length ?? 0) === 0
  );
  console.log(`[inquiries] importing ${inquiries.length} inquiry-only transactions`);

  type InquiryRow = {
    legacy_sharetribe_id: string;
    listing_id: string | null;
    buyer_id: string | null;
    seller_id: string | null;
    buyer_email: string | null;
    seller_email: string | null;
    messages: InquiryMessage[]; // postgres-js auto-encodes for jsonb
    message_count: number;
    last_transitioned_at: string | null;
    legacy_created_at: string;
  };

  const rows: InquiryRow[] = [];

  for (const t of inquiries) {
    try {
      const a = t.attributes;
      const buyerId = a.customerId ? ctx.userIdMap.get(a.customerId) : undefined;
      const sellerId = a.providerId
        ? ctx.userIdMap.get(a.providerId)
        : undefined;
      const listingId = a.listingId
        ? ctx.listingIdMap.get(a.listingId)
        : undefined;
      const buyerEmail = a.customerId
        ? sharetribeUserEmails.get(a.customerId) ?? null
        : null;
      const sellerEmail = a.providerId
        ? sharetribeUserEmails.get(a.providerId) ?? null
        : null;

      if (!buyerId && !sellerId && !buyerEmail && !sellerEmail && !listingId) {
        ctx.stats.legacy_inquiries.skipped_orphan += 1;
        continue;
      }

      const messages: InquiryMessage[] = (a.messages ?? []).map((m) => ({
        id: m.id,
        created_at: m.createdAt,
        content: m.content,
        sender_legacy_id: m.sender,
        sender_email: sharetribeUserEmails.get(m.sender) ?? null,
      }));

      rows.push({
        legacy_sharetribe_id: t.id,
        listing_id: listingId ?? null,
        buyer_id: buyerId ?? null,
        seller_id: sellerId ?? null,
        buyer_email: buyerEmail,
        seller_email: sellerEmail,
        // Pass the array directly — postgres-js handles JSONB serialization.
        // Pre-stringifying causes double-encoding (column stores a JSON string
        // instead of an actual JSONB array).
        messages: messages,
        message_count: messages.length,
        last_transitioned_at: a.lastTransitionedAt ?? null,
        legacy_created_at: a.createdAt,
      });
    } catch (err) {
      logError(ctx, "legacy_inquiries", t.id, err);
    }
  }

  if (ctx.dryRun) {
    ctx.stats.legacy_inquiries.inserted = rows.length;
    console.log(
      `[inquiries] dry-run — would insert ${rows.length}, orphans=${ctx.stats.legacy_inquiries.skipped_orphan}`
    );
    return;
  }

  const batches = chunk(rows, DEFAULT_BATCH_SIZE);
  let inserted = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO legacy_inquiries ${ctx.sql(
          batches[i] as unknown as Array<Record<string, unknown>>,
          "legacy_sharetribe_id",
          "listing_id",
          "buyer_id",
          "seller_id",
          "buyer_email",
          "seller_email",
          "messages",
          "message_count",
          "last_transitioned_at",
          "legacy_created_at"
        )}
        ON CONFLICT (legacy_sharetribe_id) DO NOTHING
      `;
      inserted += batches[i].length;
    } catch (err) {
      logError(ctx, "legacy_inquiries", `batch[${i}]`, err);
    }
  }
  ctx.stats.legacy_inquiries.inserted = inserted;

  console.log(
    `[inquiries] done — inserted=${inserted}, orphans=${ctx.stats.legacy_inquiries.skipped_orphan}`
  );
}
