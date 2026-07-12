// ============================================================
// Conversation service (Phase 2.8)
//
// Thin extraction point for conversation-related business logic.
// The conversation route handlers have substantial amounts of
// request/response shaping that belongs in the route layer, so this
// service focuses on the parts that benefit most from being reused
// and from emitting domain events: sendMessage and getUnreadCount.
// ============================================================

import { createSupabaseAdmin } from "../lib/supabase.js";
import { emit } from "../lib/events.js";
import { scanMessageContent } from "../lib/content-scanner.js";
import { logger } from "../lib/logger.js";

export class ConversationServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ConversationServiceError";
  }
}

export interface SendMessageParams {
  conversationId: string;
  senderProfileId: string;
  content?: string;
  message_type: "text" | "image" | "photo_request" | "payment_link";
  image_url?: string;
  metadata?: Record<string, unknown>;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Persist a message in a conversation, update the conversation
 * preview, and emit `message:sent` for async notification delivery.
 */
export async function sendMessage(
  params: SendMessageParams
): Promise<Record<string, unknown>> {
  const supabase = createSupabaseAdmin();

  // Load + authorize conversation
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id, listing_id")
    .eq("id", params.conversationId)
    .single();
  if (convError || !conversation) {
    throw new ConversationServiceError("Conversation not found", 404);
  }
  if (
    conversation.buyer_id !== params.senderProfileId &&
    conversation.seller_id !== params.senderProfileId
  ) {
    throw new ConversationServiceError(
      "Not authorized to send messages in this conversation",
      403
    );
  }

  // Listing must still be purchasable — unless the sender already has an order for it
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, status")
    .eq("id", conversation.listing_id)
    .single();
  if (listingError || !listing) {
    throw new ConversationServiceError("Listing not found", 404);
  }
  if (listing.status === "sold" || listing.status === "deactivated") {
    const senderIsSeller = conversation.seller_id === params.senderProfileId;
    if (!senderIsSeller) {
      const { count: orderCount } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("listing_id", conversation.listing_id)
        .eq("buyer_id", params.senderProfileId);
      if (!orderCount || orderCount === 0) {
        throw new ConversationServiceError("This listing is no longer available", 403);
      }
    }
  }

  // Insert message
  const { data: message, error: insertError } = await supabase
    .from("messages")
    .insert({
      conversation_id: params.conversationId,
      sender_id: params.senderProfileId,
      content: params.content || null,
      message_type: params.message_type,
      image_url: params.image_url || null,
      metadata: params.metadata || {},
    })
    .select()
    .single();
  if (insertError || !message) {
    logger.error("conversationService.send_failed", {
      conversation_id: params.conversationId,
      error: insertError?.message,
    });
    throw new ConversationServiceError("Failed to send message", 500);
  }

  // Fire-and-forget content scan
  if (params.content) {
    scanMessageContent(
      message.id as string,
      params.content,
      params.senderProfileId
    ).catch((err) =>
      logger.error("conversationService.scan_failed", {
        message_id: message.id,
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  // Compose preview + update conversation
  const previewMap: Record<string, string> = {
    image: "[Photo]",
    photo_request: "[Photo Request]",
    payment_link: "[Payment Link]",
  };
  const preview = params.content
    ? truncate(params.content, 100)
    : previewMap[params.message_type] || "[Message]";

  const { error: updateError } = await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: preview,
    })
    .eq("id", params.conversationId);
  if (updateError) {
    logger.error("conversationService.update_last_message_failed", {
      conversation_id: params.conversationId,
      error: updateError.message,
    });
  }

  // Resolve sender display name for the notification payload
  const { data: senderProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", params.senderProfileId)
    .single();
  const senderName = senderProfile?.display_name || "Someone";

  // Debounce: notify only if no new_message notification in the last 5 minutes
  const recipientId =
    conversation.buyer_id === params.senderProfileId
      ? conversation.seller_id
      : conversation.buyer_id;
  // Recipient's role on the conversation.
  const recipientRole: "buyer" | "seller" =
    recipientId === conversation.seller_id ? "seller" : "buyer";

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", recipientId)
    .eq("type", "new_message")
    .gte("created_at", fiveMinutesAgo)
    .contains("data", { conversation_id: params.conversationId });

  if (!recentCount || recentCount === 0) {
    emit("message:sent", {
      conversationId: params.conversationId,
      listingId: conversation.listing_id,
      recipientId,
      recipientRole,
      senderId: params.senderProfileId,
      senderName,
      preview,
    });
  }

  // Realtime broadcast on the conversation channel so both parties see the
  // message live without re-fetching. Fire-and-forget — broadcast failures
  // must not affect the message persistence above.
  createSupabaseAdmin()
    .channel(`conversation:${params.conversationId}`)
    .send({
      type: "broadcast",
      event: "new_message",
      payload: message,
    })
    .catch((err: unknown) =>
      logger.error("conversationService.broadcast_failed", {
        conversation_id: params.conversationId,
        error: err instanceof Error ? err.message : String(err),
      })
    );

  return message;
}

/**
 * Broadcast a moderation state change for a single message on the same
 * `conversation:<id>` channel the app already subscribes to for live messages.
 * The app handles the `message_moderated` event to hide/restore/update a
 * message without waiting for a poll or focus-refetch. Fire-and-forget.
 *
 * payload: { id, conversation_id, moderation_hidden, content? }
 */
export function broadcastMessageModerated(
  conversationId: string,
  payload: {
    id: string;
    conversation_id: string;
    moderation_hidden: boolean;
    content?: string;
  }
): void {
  createSupabaseAdmin()
    .channel(`conversation:${conversationId}`)
    .send({
      type: "broadcast",
      event: "message_moderated",
      payload,
    })
    .catch((err: unknown) =>
      logger.error("conversationService.moderation_broadcast_failed", {
        conversation_id: conversationId,
        error: err instanceof Error ? err.message : String(err),
      })
    );
}

/**
 * Find-or-create the conversation between (listing, buyer, seller) and
 * post a system-style message into it as the seller. Used for order
 * lifecycle messages — e.g. "tracking added, your order is on its way."
 *
 * `metadata.system: true` is stamped on the message so the frontend can
 * render these as centered grey bubbles (or whatever system styling) and
 * skip the regular sender-avatar treatment. `metadata.kind` lets the UI
 * pick an icon per event ("order_shipped", "order_delivered", etc.).
 *
 * Fire-and-forget from the caller's perspective: failures only log
 * (never throw) so an order action like /ship is never blocked by a
 * chat hiccup.
 */
export async function postSystemMessage(params: {
  listingId: string;
  buyerId: string;
  sellerId: string;
  content: string;
  kind: string; // e.g. "order_shipped" — drives icon/styling on the client
}): Promise<void> {
  try {
    const supabase = createSupabaseAdmin();

    // Upsert the conversation row — same pattern used by the seller-initiated
    // /api/conversations POST flow. Safe to call repeatedly; returns existing.
    const { data: conversation, error: upsertError } = await supabase
      .from("conversations")
      .upsert(
        {
          listing_id: params.listingId,
          buyer_id: params.buyerId,
          seller_id: params.sellerId,
        },
        { onConflict: "listing_id,buyer_id,seller_id", ignoreDuplicates: false }
      )
      .select()
      .single();

    if (upsertError || !conversation) {
      logger.error("postSystemMessage.upsert_failed", {
        listing_id: params.listingId,
        buyer_id: params.buyerId,
        seller_id: params.sellerId,
        error: upsertError?.message,
      });
      return;
    }

    await sendMessage({
      conversationId: conversation.id as string,
      senderProfileId: params.sellerId,
      content: params.content,
      message_type: "text",
      metadata: { system: true, kind: params.kind },
    });
  } catch (err) {
    logger.error("postSystemMessage.failed", {
      listing_id: params.listingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
