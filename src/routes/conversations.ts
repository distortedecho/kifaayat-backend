import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { scanMessageContent } from "../lib/content-scanner.js";
import type {
  Conversation,
  Message,
  MessageType,
  ConversationListItem,
  MessageListResponse,
  ConversationListResponse,
  UnreadCountResponse,
} from "../types/messaging.js";
import { createNotification } from "../lib/notifications.js";

const conversations = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createConversationSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
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

/**
 * Truncate a string to a given max length, appending "..." if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
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

  // Fallback: if RPC not available, do it via queries
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

    const convoIds = convos.map((conv) => conv.id);

    // Count conversations that have at least one unread message from the other party
    let unreadCount = 0;
    for (const convoId of convoIds) {
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", convoId)
        .neq("sender_id", profileId)
        .is("read_at", null);

      if (count && count > 0) {
        unreadCount++;
      }
    }

    const response: UnreadCountResponse = { total_unread: unreadCount };
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

  const { listing_id } = parsed.data;

  // Validate listing exists and is active
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "active" && listing.status !== "reserved") {
    return c.json(
      { error: "Cannot start a conversation on a listing that is not active" },
      400
    );
  }

  // Buyer cannot be the seller
  if (listing.seller_id === profileId) {
    return c.json(
      { error: "You cannot start a conversation on your own listing" },
      400
    );
  }

  // DMs are restricted to post-purchase: buyer must have an order for this listing
  // or listing must be sold/reserved to this buyer
  const { count: orderCount } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listing_id)
    .eq("buyer_id", profileId);

  if (!orderCount || orderCount === 0) {
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

  // Enrich each conversation with unread count and other user info
  const items: ConversationListItem[] = await Promise.all(
    page.map(async (row: Record<string, unknown>) => {
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

      // Count unread messages (from the other party)
      const { count: unreadCount } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("conversation_id", row.id as string)
        .neq("sender_id", profileId)
        .is("read_at", null);

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
        unread_count: unreadCount || 0,
        created_at: row.created_at as string,
      };
    })
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
conversations.post("/:id/messages", clerkMiddleware, async (c) => {
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
    .select("id, buyer_id, seller_id, listing_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (
    conversation.buyer_id !== profileId &&
    conversation.seller_id !== profileId
  ) {
    return c.json({ error: "Not authorized to send messages in this conversation" }, 403);
  }

  // Verify listing is still active (not sold or deactivated)
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, status")
    .eq("id", conversation.listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status === "sold" || listing.status === "deactivated") {
    return c.json(
      { error: "This listing is no longer available" },
      403
    );
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

  const { content, message_type, image_url, metadata } = parsed.data;

  // Insert message with multi-type support
  const { data: message, error: insertError } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: profileId,
      content: content || null,
      message_type,
      image_url: image_url || null,
      metadata: metadata || {},
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error sending message:", insertError);
    return c.json({ error: "Failed to send message" }, 500);
  }

  // Fire-and-forget: scan message content for phone numbers, emails, external URLs
  if (content) {
    scanMessageContent(message.id, content, profileId).catch((err) =>
      console.error("Message scan failed:", err)
    );
  }

  // Build last_message_preview based on type
  const previewMap: Record<string, string> = {
    image: "[Photo]",
    photo_request: "[Photo Request]",
    payment_link: "[Payment Link]",
  };
  const preview = content
    ? truncate(content, 100)
    : previewMap[message_type] || "[Message]";

  // Update conversation with last message info
  const { error: updateError } = await supabase
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: preview,
    })
    .eq("id", conversationId);

  if (updateError) {
    console.error("Error updating conversation last message:", updateError);
    // Non-blocking — message was still sent
  }

  // Fire-and-forget new_message notification (debounced per conversation)
  const recipientId = conversation.buyer_id === profileId
    ? conversation.seller_id
    : conversation.buyer_id;

  (async () => {
    try {
      // Check if recipient received a new_message notification for this conversation in the last 5 minutes
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { count: recentCount } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", recipientId)
        .eq("type", "new_message")
        .gte("created_at", fiveMinutesAgo)
        .contains("data", { conversation_id: conversationId });

      if (recentCount && recentCount > 0) {
        return; // Already notified recently, skip
      }

      // Get sender display name
      const { data: senderProfile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", profileId)
        .single();

      const senderName = senderProfile?.display_name || "Someone";
      const notifBody = content
        ? truncate(content, 100)
        : previewMap[message_type] || "[Message]";

      await createNotification({
        user_id: recipientId,
        type: "new_message" as any, // Cast: "new_message" added to NOTIFICATION_TYPES in Plan 19-02
        title: `New message from ${senderName}`,
        body: notifBody,
        data: { conversation_id: conversationId, listing_id: conversation.listing_id },
      });
    } catch (err) {
      console.error("Error sending new_message notification (fire-and-forget):", err);
    }
  })();

  return c.json({ message }, 201);
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

  // Mark messages from the other party as read
  // We need to count affected rows, so we first count then update
  const { count: unreadCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .neq("sender_id", profileId)
    .is("read_at", null);

  const { error: updateError } = await supabase
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .neq("sender_id", profileId)
    .is("read_at", null);

  if (updateError) {
    console.error("Error marking messages as read:", updateError);
    return c.json({ error: "Failed to mark messages as read" }, 500);
  }

  return c.json({ updated_count: unreadCount || 0 });
});

export default conversations;
