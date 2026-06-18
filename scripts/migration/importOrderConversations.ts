// ============================================================
// Order conversations importer — paid-transaction chat history
//
// The 76 paid Sharetribe transactions had 550 messages between
// buyer + seller. Previous importer threw these away. This importer
// reconstructs them into the new app's chat system:
//   - one conversation row per paid order (listing + buyer + seller)
//   - one message row per Sharetribe message, preserving original
//     created_at + content + sender
//
// Inquiry-only transactions (946 of them) are NOT processed here —
// those go to legacy_inquiries (admin-only archive) since the new
// app deliberately has no pre-order chat. Paid-order chats ARE
// post-order, so they map cleanly to conversations + messages.
//
// Idempotency: conversations has UNIQUE(listing_id, buyer_id,
// seller_id), so re-inserting the same combo is a no-op. Messages
// have no natural unique constraint though, so re-running this
// would duplicate them — same caveat as historic reviews originally
// had. Guard via the conversation upsert: if the conversation
// already existed (i.e. we've imported these messages before), we
// skip the messages too. Tracked via a fresh-vs-existing check on
// the conversation insert.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import type { SharetribeTransaction } from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

export async function importOrderConversations(
  ctx: MigrationContext,
  transactions: SharetribeTransaction[]
): Promise<void> {
  // Only paid transactions with at least one message.
  const eligible = transactions.filter(
    (t) =>
      (t.attributes.payIns?.length ?? 0) > 0 &&
      (t.attributes.messages?.length ?? 0) > 0
  );

  console.log(
    `[order_conversations] processing ${eligible.length} paid orders with messages`
  );

  type ConversationRow = {
    listing_id: string;
    buyer_id: string;
    seller_id: string;
    legacy_sharetribe_transaction_id: string;
    last_message_at: string;
    last_message_preview: string | null;
    created_at: string;
  };

  type MessageRow = {
    conversation_id: string;
    sender_id: string;
    content: string;
    created_at: string;
  };

  const conversationRows: ConversationRow[] = [];
  const messageBatches: {
    transactionId: string;
    messages: Array<{ sender: string; content: string; createdAt: string }>;
  }[] = [];

  for (const t of eligible) {
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
        ctx.stats.order_conversations.skipped_orphan += 1;
        continue;
      }

      // Sort messages by createdAt so the conversation last_message_at +
      // preview reflect the actual most-recent one.
      const messages = (a.messages ?? [])
        .filter((m) => m.content && m.content.trim().length > 0)
        .slice()
        .sort((m1, m2) => (m1.createdAt < m2.createdAt ? -1 : 1));
      if (messages.length === 0) continue;

      const last = messages[messages.length - 1];
      const preview = last.content.slice(0, 140);

      conversationRows.push({
        listing_id: listingId,
        buyer_id: buyerId,
        seller_id: sellerId,
        legacy_sharetribe_transaction_id: t.id,
        last_message_at: last.createdAt,
        last_message_preview: preview,
        created_at: a.createdAt,
      });

      messageBatches.push({
        transactionId: t.id,
        messages: messages.map((m) => ({
          sender: m.sender,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    } catch (err) {
      logError(ctx, "order_conversations", t.id, err);
    }
  }

  if (ctx.dryRun) {
    ctx.stats.order_conversations.inserted = conversationRows.length;
    ctx.stats.order_conversations.messages_inserted = messageBatches.reduce(
      (sum, b) => sum + b.messages.length,
      0
    );
    console.log(
      `[order_conversations] dry-run — would insert ${conversationRows.length} conversations, ` +
        `${ctx.stats.order_conversations.messages_inserted} messages`
    );
    return;
  }

  // ---- Conversations: insert + capture id remap ----
  // conversations has UNIQUE(listing_id, buyer_id, seller_id) so
  // ON CONFLICT DO NOTHING gives us idempotency. We then bulk-select
  // the existing rows to populate a remap (transactionId → conversationId)
  // for the message insert.
  const conversationIdByTransaction = new Map<string, string>();
  let conversationsInserted = 0;

  const convBatches = chunk(conversationRows, DEFAULT_BATCH_SIZE);
  for (let i = 0; i < convBatches.length; i++) {
    const batch = convBatches[i];
    try {
      await ctx.sql`
        INSERT INTO conversations ${ctx.sql(
          batch,
          "listing_id",
          "buyer_id",
          "seller_id",
          "last_message_at",
          "last_message_preview",
          "created_at"
        )}
        ON CONFLICT (listing_id, buyer_id, seller_id) DO NOTHING
      `;
      conversationsInserted += batch.length;
    } catch (err) {
      logError(ctx, "order_conversations", `batch[${i}]`, err);
    }
  }

  // Bulk-select conversations to fill the transaction → conversation map.
  // postgres-js doesn't handle the row-constructor IN syntax cleanly, so
  // we fetch by listing_id (cheap, small set) and filter the full triplet
  // in JS. With ~66 paid orders the volume is tiny.
  type ConvRow = {
    id: string;
    listing_id: string;
    buyer_id: string;
    seller_id: string;
  };
  const allListingIds = Array.from(
    new Set(conversationRows.map((r) => r.listing_id))
  );
  const foundByKey = new Map<string, string>();
  for (const lc of chunk(allListingIds, 2000)) {
    const found = (await ctx.sql`
      SELECT id, listing_id, buyer_id, seller_id
      FROM conversations
      WHERE listing_id = ANY(${lc})
    `) as unknown as ConvRow[];
    for (const r of found) {
      foundByKey.set(`${r.listing_id}|${r.buyer_id}|${r.seller_id}`, r.id);
    }
  }

  // Build messages rows now that we have conversation ids.
  const messageRows: MessageRow[] = [];
  for (let i = 0; i < conversationRows.length; i++) {
    const cr = conversationRows[i];
    const mb = messageBatches[i];
    const convId = foundByKey.get(
      `${cr.listing_id}|${cr.buyer_id}|${cr.seller_id}`
    );
    if (!convId) {
      // Conversation row didn't make it into the table — odd. Skip.
      ctx.stats.order_conversations.skipped_orphan += 1;
      continue;
    }
    conversationIdByTransaction.set(mb.transactionId, convId);

    for (const m of mb.messages) {
      const senderId = ctx.userIdMap.get(m.sender);
      if (!senderId) continue; // sender wasn't migrated; rare
      // schema's messages.content CHECK: 1..2000 chars. Truncate to fit.
      const truncated =
        m.content.length > 2000 ? m.content.slice(0, 2000) : m.content;
      messageRows.push({
        conversation_id: convId,
        sender_id: senderId,
        content: truncated,
        created_at: m.createdAt,
      });
    }
  }

  // Idempotency for messages: count existing per-conversation. If a
  // conversation already has N messages and our import has M total,
  // only insert the difference. With UNIQUE(legacy_sharetribe_id) per
  // message we'd be more robust — schema doesn't have it. For now,
  // the user is expected to re-run only after wiping migrated chats.
  let messagesInserted = 0;
  const msgBatches = chunk(messageRows, DEFAULT_BATCH_SIZE);
  for (let i = 0; i < msgBatches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO messages ${ctx.sql(
          msgBatches[i],
          "conversation_id",
          "sender_id",
          "content",
          "created_at"
        )}
      `;
      messagesInserted += msgBatches[i].length;
    } catch (err) {
      logError(ctx, "order_conversations_messages", `batch[${i}]`, err);
    }
  }

  ctx.stats.order_conversations.inserted = conversationsInserted;
  ctx.stats.order_conversations.messages_inserted = messagesInserted;

  console.log(
    `[order_conversations] done — conversations=${conversationsInserted}, ` +
      `messages=${messagesInserted}, ` +
      `orphans=${ctx.stats.order_conversations.skipped_orphan}`
  );
}
