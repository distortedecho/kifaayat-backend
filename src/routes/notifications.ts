import { Hono } from "hono";
import { clerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const notifications = new Hono();

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getProfileByClerkId(
  clerkUserId: string
): Promise<{ id: string } | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return null;
  return data;
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/notifications
 * List user's notifications with cursor pagination.
 * Query params:
 *   - cursor: ISO timestamp for pagination (created_at of last item)
 *   - limit: number of items (default 20, max 50)
 */
notifications.get("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(Math.max(parseInt(limitParam || "20", 10) || 20, 1), 50);

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: items, error } = await query;

  if (error) {
    console.error("Error fetching notifications:", error);
    return c.json({ error: "Failed to fetch notifications" }, 500);
  }

  // Get unread count
  const { count: unreadCount } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .eq("read", false);

  // Determine next cursor
  const nextCursor =
    items && items.length === limit
      ? (items[items.length - 1] as Record<string, unknown>).created_at
      : null;

  return c.json({
    notifications: items || [],
    unread_count: unreadCount || 0,
    next_cursor: nextCursor,
  });
});

/**
 * GET /api/notifications/unread-count
 * Returns just the unread count (for badge polling).
 */
notifications.get("/unread-count", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .eq("read", false);

  if (error) {
    console.error("Error fetching unread count:", error);
    return c.json({ error: "Failed to fetch unread count" }, 500);
  }

  return c.json({ unread_count: count || 0 });
});

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read.
 */
notifications.patch("/:id/read", clerkMiddleware, async (c) => {
  const notificationId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(notificationId)) {
    return c.json({ error: "Invalid notification ID format" }, 400);
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const { data: notification, error: updateError } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("id", notificationId)
    .eq("user_id", profile.id)
    .select()
    .single();

  if (updateError || !notification) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ notification });
});

/**
 * PATCH /api/notifications/read-all
 * Mark all user's notifications as read.
 */
notifications.patch("/read-all", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const { error: updateError } = await supabase
    .from("notifications")
    .update({ read: true })
    .eq("user_id", profile.id)
    .eq("read", false);

  if (updateError) {
    console.error("Error marking all as read:", updateError);
    return c.json({ error: "Failed to mark notifications as read" }, 500);
  }

  return c.json({ success: true });
});

export default notifications;
