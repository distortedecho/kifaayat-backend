import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware } from "../middleware/clerk.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import type {
  Conversation,
  Message,
  MessageType,
  ConversationListItem,
  MessageListResponse,
  ConversationListResponse,
  UnreadCountResponse,
} from "../types/messaging.js";
import {
  sendMessage as sendMessageService,
  ConversationServiceError,
} from "../services/conversationService.js";

const conversations = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createConversationSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  buyer_id: z.string().uuid("buyer_id must be a valid UUID").optional(),
});

const sendMessageSchema = z.object({
  content: z.string().max(2000).optional(),
  message_type: z.enum(['text', 'image', 'photo_request', 'payment_link']).default('text'),
  image_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (data) => data.message_type === 'text' ? (data.content && data.content.length > 0) : true,
  { message: "Text messages require content" }
);

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Look up the profile UUID for a given Clerk user ID.
 * Returns null if no profile exists.
 */
async function getProfileId(
  clerkUserId: string
): Promise<string | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return null;
  return data.id;
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/conversations/unread-count
 * Get total unread conversations count for the current user.
 * NOTE: This must be defined BEFORE /:id routes to avoid path conflict.
 */
conversations.get("/unread-count", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Count conversations where user is participant AND has unread messages
  // (messages where sender_id != profileId AND read_at IS NULL)
  const { data, error } = await supabase.rpc("get_unread_conversation_count" as never, {
    p_profile_id: profileId,
  } as never);

  // Fallback: if RPC not available, do it via batched queries (no N+1).
  if (error) {
    // Get all conversation IDs where user is a participant
    const { data: convos, error: convosError } = await supabase
      .from("conversations")
      .select("id")
      .or(`buyer_id.eq.${profileId},seller_id.eq.${profileId}`);

    if (convosError || !convos || convos.length === 0) {
      const response: UnreadCountResponse = { total_unread: 0 };
      return c.json(response);
    }

    const convoIds = convos.map((conv) => conv.id as string);

    // Single batch query for all unread messages across the user's
    // conversations. Count distinct conversation_ids client-side.
    const { data: unreadMsgs, error: unreadError } = await supabase
      .from("messages")
      .select("conversation_id")
      .in("conversation_id", convoIds)
      .neq("sender_id", profileId)
      .is("read_at", null);

    if (unreadError) {
      console.error("Error fetching unread messages:", unreadError);
      const response: UnreadCountResponse = { total_unread: 0 };
      return c.json(response);
    }

    const unreadConvSet = new Set<string>();
    for (const m of unreadMsgs || []) {
      unreadConvSet.add(m.conversation_id as string);
    }

    const response: UnreadCountResponse = {
      total_unread: unreadConvSet.size,
    };
    return c.json(response);
  }

  const response: UnreadCountResponse = {
    total_unread: typeof data === "number" ? data : 0,
  };
  return c.json(response);
});

/**
 * POST /api/conversations
 * Create or reopen a conversation thread for a listing.
 * Buyer-initiated only.
 */
conversations.post("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, buyer_id: requestedBuyerId } = parsed.data;

  // Validate listing exists
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const isSeller = listing.seller_id === profileId;

  console.info("[conversations] role check", {
    profile_id: profileId,
    listing_seller_id: listing.seller_id,
    is_seller: isSeller,
    listing_status: listing.status,
    requested_buyer_id: requestedBuyerId,
  });

  if (isSeller) {
    // Seller initiating — buyer_id required
    if (!requestedBuyerId) {
      return c.json({ error: "buyer_id is required when seller initiates a conversation" }, 400);
    }

    // Verify an order exists between this seller's listing and the buyer
    const { count: orderCount, data: orderDebug } = await supabase
      .from("orders")
      .select("id, listing_id, buyer_id", { count: "exact" })
      .eq("listing_id", listing_id)
      .eq("buyer_id", requestedBuyerId);

    console.info("[conversations] seller flow order check", {
      seller_profile_id: profileId,
      listing_id,
      requested_buyer_id: requestedBuyerId,
      order_count: orderCount,
      orders_found: orderDebug,
    });

    if (!orderCount || orderCount === 0) {
      return c.json({ error: "No order found between this seller and buyer" }, 400);
    }

    const { data: conversation, error: upsertError } = await supabase
      .from("conversations")
      .upsert(
        { listing_id, buyer_id: requestedBuyerId, seller_id: profileId },
        { onConflict: "listing_id,buyer_id,seller_id", ignoreDuplicates: false }
      )
      .select()
      .single();

    if (upsertError || !conversation) {
      console.error("Error creating seller-initiated conversation:", upsertError);
      return c.json({ error: "Failed to create conversation" }, 500);
    }

    return c.json({ conversation });
  }

  // Buyer flow
  // Check order first — post-purchase buyers can DM regardless of listing status
  const { count: orderCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listing_id)
    .eq("buyer_id", profileId);

  const hasPurchased = !!orderCount && orderCount > 0;

  if (!hasPurchased) {
    // Pre-purchase: listing must still be active
    if (listing.status !== "active" && listing.status !== "reserved") {
      return c.json(
        { error: "Cannot start a conversation on a listing that is not active" },
        400
      );
    }
    return c.json(
      {
        error: "Direct messages are only available after purchasing. Use public comments to ask the seller questions.",
        code: "DM_REQUIRES_PURCHASE",
      },
      403
    );
  }

  // UPSERT: insert or update if conversation already exists for this triple
  const { data: conversation, error: upsertError } = await supabase
    .from("conversations")
    .upsert(
      {
        listing_id,
        buyer_id: profileId,
        seller_id: listing.seller_id,
      },
      {
        onConflict: "listing_id,buyer_id,seller_id",
      }
    )
    .select()
    .single();

  if (upsertError) {
    console.error("Error creating conversation:", upsertError);
    return c.json({ error: "Failed to create conversation" }, 500);
  }

  return c.json({ conversation }, 201);
});

/**
 * GET /api/conversations
 * List user's conversations (inbox) with enriched data.
 */
conversations.get("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Parse query params
  const filter = c.req.query("filter") || "all";
  const cursor = c.req.query("cursor"); // last_message_at cursor
  const limitStr = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 50);

  if (!["all", "buying", "selling"].includes(filter)) {
    return c.json({ error: "Invalid filter. Must be: all, buying, or selling" }, 400);
  }

  // Build query for conversations
  let query = supabase
    .from("conversations")
    .select(
      "*, listings!conversations_listing_id_fkey(id, title, price_amount, price_currency, status, listing_photos(url, position)), buyer:profiles!conversations_buyer_id_fkey(id, display_name, avatar_url), seller:profiles!conversations_seller_id_fkey(id, display_name, avatar_url)"
    )
    .order("last_message_at", { ascending: false })
    .limit(limit + 1); // Fetch one extra for cursor

  // Apply filter
  if (filter === "buying") {
    query = query.eq("buyer_id", profileId);
  } else if (filter === "selling") {
    query = query.eq("seller_id", profileId);
  } else {
    // all: buyer_id or seller_id matches
    query = query.or(`buyer_id.eq.${profileId},seller_id.eq.${profileId}`);
  }

  // Apply cursor
  if (cursor) {
    query = query.lt("last_message_at", cursor);
  }

  const { data: convosRaw, error: convosError } = await query;

  if (convosError) {
    console.error("Error fetching conversations:", convosError);
    return c.json({ error: "Failed to fetch conversations" }, 500);
  }

  const rawList = convosRaw || [];
  const hasMore = rawList.length > limit;
  const page = hasMore ? rawList.slice(0, limit) : rawList;

  // Batch-fetch unread counts for all conversations on this page in one
  // query, then group in JS. Replaces the old per-conversation N+1 loop.
  const pageConvIds = page.map((row) => row.id as string);
  const unreadCountMap = new Map<string, number>();

  if (pageConvIds.length > 0) {
    const { data: unreadMsgs, error: unreadError } = await supabase
      .from("messages")
      .select("conversation_id")
      .in("conversation_id", pageConvIds)
      .neq("sender_id", profileId)
      .is("read_at", null);

    if (unreadError) {
      console.error(
        "Error fetching batched unread counts:",
        unreadError
      );
    } else {
      for (const m of unreadMsgs || []) {
        const cid = m.conversation_id as string;
        unreadCountMap.set(cid, (unreadCountMap.get(cid) || 0) + 1);
      }
    }
  }

  // Enrich each conversation with unread count (from batch map) and other user info
  const items: ConversationListItem[] = page.map(
    (row: Record<string, unknown>) => {
      const listing = row.listings as Record<string, unknown> | null;
      const buyer = row.buyer as Record<string, unknown> | null;
      const seller = row.seller as Record<string, unknown> | null;

      // Determine role and other user
      const isBuyer = (row.buyer_id as string) === profileId;
      const role: "buying" | "selling" = isBuyer ? "buying" : "selling";
      const otherUser = isBuyer ? seller : buyer;

      // Get cover photo
      let coverPhotoUrl: string | null = null;
      if (listing) {
        const photos = listing.listing_photos as
          | Array<Record<string, unknown>>
          | null;
        if (photos && photos.length > 0) {
          const cover =
            photos.find((p) => p.position === 0) || photos[0];
          coverPhotoUrl = (cover.url as string) || null;
        }
      }

      return {
        id: row.id as string,
        listing_id: row.listing_id as string,
        listing_title: listing ? (listing.title as string) : "",
        listing_cover_photo_url: coverPhotoUrl,
        listing_price_amount: listing ? (listing.price_amount as number) : 0,
        listing_price_currency: listing
          ? (listing.price_currency as string)
          : "AUD",
        listing_status: listing ? (listing.status as string) : "unknown",
        other_user_id: otherUser ? (otherUser.id as string) : "",
        other_user_name: otherUser
          ? (otherUser.display_name as string | null)
          : null,
        other_user_avatar_url: otherUser
          ? (otherUser.avatar_url as string | null)
          : null,
        role,
        last_message_at: row.last_message_at as string,
        last_message_preview: row.last_message_preview as string | null,
        unread_count: unreadCountMap.get(row.id as string) || 0,
        created_at: row.created_at as string,
      };
    }
  );

  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>).last_message_at as string
    : null;

  const response: ConversationListResponse = {
    conversations: items,
    next_cursor: nextCursor,
  };

  return c.json(response);
});

/**
 * GET /api/conversations/:id/messages
 * Fetch message history for a conversation.
 */
conversations.get("/:id/messages", clerkMiddleware, async (c) => {
  const conversationId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(conversationId)) {
    return c.json({ error: "Invalid conversation ID format" }, 400);
  }

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Verify user is a participant
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (
    conversation.buyer_id !== profileId &&
    conversation.seller_id !== profileId
  ) {
    return c.json({ error: "Not authorized to view this conversation" }, 403);
  }

  // Parse query params
  const cursor = c.req.query("cursor"); // created_at cursor
  const limitStr = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitStr || "30", 10) || 30, 1),
    100
  );

  // Fetch messages
  let query = supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: messagesRaw, error: messagesError } = await query;

  if (messagesError) {
    console.error("Error fetching messages:", messagesError);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }

  const rawList = messagesRaw || [];
  const hasMore = rawList.length > limit;
  const page = hasMore ? rawList.slice(0, limit) : rawList;

  const nextCursor = hasMore
    ? (page[page.length - 1] as Record<string, unknown>).created_at as string
    : null;

  const response: MessageListResponse = {
    messages: page as Message[],
    next_cursor: nextCursor,
  };

  return c.json(response);
});

/**
 * POST /api/conversations/:id/messages
 * Send a message in a conversation.
 */
conversations.post("/:id/messages", idempotencyMiddleware, clerkMiddleware, async (c) => {
  const conversationId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");

  if (!UUID_REGEX.test(conversationId)) {
    return c.json({ error: "Invalid conversation ID format" }, 400);
  }

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  // Delegate to the conversation service -- it persists the
  // message, scans content, updates the conversation preview, and
  // emits `message:sent` for async notification dispatch.
  try {
    const message = await sendMessageService({
      conversationId,
      senderProfileId: profileId,
      content: parsed.data.content,
      message_type: parsed.data.message_type,
      image_url: parsed.data.image_url,
      metadata: parsed.data.metadata,
    });

    // (Realtime broadcast on `conversation:<id>` is fired inside sendMessage
    // so any caller of the service — including server-side system messages —
    // gets live delivery for free.)

    return c.json({ message }, 201);
  } catch (err) {
    if (err instanceof ConversationServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 403 | 404 | 500);
    }
    console.error("Unexpected error in sendMessage:", err);
    return c.json({ error: "Failed to send message" }, 500);
  }
});

/**
 * PATCH /api/conversations/:id/read
 * Mark all unread messages from the other party as read.
 */
conversations.patch("/:id/read", clerkMiddleware, async (c) => {
  const conversationId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(conversationId)) {
    return c.json({ error: "Invalid conversation ID format" }, 400);
  }

  const profileId = await getProfileId(clerkUserId);
  if (!profileId) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Verify user is a participant
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (
    conversation.buyer_id !== profileId &&
    conversation.seller_id !== profileId
  ) {
    return c.json({ error: "Not authorized to update this conversation" }, 403);
  }

  // Mark messages from the other party as read, returning the affected rows
  // in a single round-trip so we can broadcast the IDs to the conversation
  // channel for live "Seen" indicators on the sender's side.
  const readAt = new Date().toISOString();
  const { data: updatedMessages, error: updateError } = await supabase
    .from("messages")
    .update({ read_at: readAt })
    .eq("conversation_id", conversationId)
    .neq("sender_id", profileId)
    .is("read_at", null)
    .select("id");

  if (updateError) {
    console.error("Error marking messages as read:", updateError);
    return c.json({ error: "Failed to mark messages as read" }, 500);
  }

  const messageIds = (updatedMessages || []).map((m) => m.id as string);

  // Fire-and-forget realtime broadcast so the sender's UI can flip the
  // ticks from "Sent" to "Seen" without re-fetching. Matches the existing
  // new_message broadcast pattern — see also: PATCH-on-open from FE.
  if (messageIds.length > 0) {
    createSupabaseAdmin()
      .channel(`conversation:${conversationId}`)
      .send({
        type: "broadcast",
        event: "messages_read",
        payload: {
          conversation_id: conversationId,
          message_ids: messageIds,
          read_at: readAt,
          reader_id: profileId, // recipient (the one marking as read)
        },
      })
      .catch((err: unknown) =>
        console.error("[realtime] messages_read broadcast error:", err)
      );
  }

  return c.json({ updated_count: messageIds.length });
});

export default conversations;
