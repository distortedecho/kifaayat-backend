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

  // Listing must still be purchasable
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, status")
    .eq("id", conversation.listing_id)
    .single();
  if (listingError || !listing) {
    throw new ConversationServiceError("Listing not found", 404);
  }
  if (listing.status === "sold" || listing.status === "deactivated") {
    throw new ConversationServiceError("This listing is no longer available", 403);
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
      senderId: params.senderProfileId,
      senderName,
      preview,
    });
  }

  return message;
}
