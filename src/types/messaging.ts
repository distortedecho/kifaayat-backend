// ============================================================
// Phase 5: Messaging Types (extended Phase 19)
// ============================================================

export type MessageType = 'text' | 'image' | 'photo_request' | 'payment_link';

// Conversation as stored in DB
export interface Conversation {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  last_message_at: string;
  last_message_preview: string | null;
  created_at: string;
  updated_at: string;
}

// Message as stored in DB
export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;  // null for image-only messages
  message_type: MessageType;
  image_url: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

// Conversation list item for inbox (enriched with joins)
export interface ConversationListItem {
  id: string;
  listing_id: string;
  listing_title: string;
  listing_cover_photo_url: string | null;
  listing_price_amount: number;
  listing_price_currency: string;
  listing_status: string;
  other_user_id: string;
  other_user_name: string | null;
  other_user_avatar_url: string | null;
  role: "buying" | "selling";
  last_message_at: string;
  last_message_preview: string | null;
  unread_count: number;
  created_at: string;
}

// Paginated message list response
export interface MessageListResponse {
  messages: Message[];
  next_cursor: string | null;
}

// Paginated conversation list response
export interface ConversationListResponse {
  conversations: ConversationListItem[];
  next_cursor: string | null;
}

// Unread count response
export interface UnreadCountResponse {
  total_unread: number;
}
