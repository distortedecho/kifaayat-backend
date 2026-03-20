import { Hono } from "hono";
import { clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const notifications = new Hono();

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
notifications.get("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

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
notifications.get("/unread-count", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

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
notifications.patch("/:id/read", clerkMiddleware, requireProfile, async (c) => {
  const notificationId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(notificationId)) {
    return c.json({ error: "Invalid notification ID format" }, 400);
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
notifications.patch("/read-all", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

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

// ============================================================
// Notification Preferences
// ============================================================

const VALID_CATEGORIES = ["transaction", "engagement", "seller", "marketing"] as const;
type PreferenceCategory = (typeof VALID_CATEGORIES)[number];

/**
 * GET /api/notifications/preferences
 * Returns user's notification preferences per category.
 * Missing categories should use client-side defaults:
 *   transaction = always on, engagement = on, seller = on, marketing = off
 */
notifications.get("/preferences", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const { data: preferences, error } = await supabase
    .from("notification_preferences")
    .select("category, push_enabled, email_enabled")
    .eq("user_id", profile.id);

  if (error) {
    console.error("Error fetching notification preferences:", error);
    return c.json({ error: "Failed to fetch preferences" }, 500);
  }

  return c.json({
    preferences: preferences || [],
  });
});

/**
 * PUT /api/notifications/preferences
 * Upsert a notification preference for a specific category.
 * Body: { category: string, push_enabled: boolean, email_enabled: boolean }
 * Transaction category cannot be modified (always on).
 */
notifications.put("/preferences", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  let body: { category?: string; push_enabled?: boolean; email_enabled?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { category, push_enabled, email_enabled } = body;

  // Validate category
  if (!category || !VALID_CATEGORIES.includes(category as PreferenceCategory)) {
    return c.json({
      error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`,
    }, 400);
  }

  // Transaction category cannot be modified
  if (category === "transaction") {
    return c.json({
      error: "Transaction notifications cannot be disabled",
    }, 400);
  }

  // Validate boolean fields
  if (typeof push_enabled !== "boolean" || typeof email_enabled !== "boolean") {
    return c.json({
      error: "push_enabled and email_enabled must be boolean values",
    }, 400);
  }

  // Upsert preference
  const { data: preference, error } = await supabase
    .from("notification_preferences")
    .upsert(
      {
        user_id: profile.id,
        category,
        push_enabled,
        email_enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,category" }
    )
    .select("category, push_enabled, email_enabled, updated_at")
    .single();

  if (error) {
    console.error("Error upserting notification preference:", error);
    return c.json({ error: "Failed to update preference" }, 500);
  }

  return c.json({ preference });
});

export default notifications;
