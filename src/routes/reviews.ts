import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  createNotification,
  reviewRevealNotification,
  reviewReminderNotification,
  sellerReplyNotification,
} from "../lib/notifications.js";
import {
  type Review,
  REVIEW_WINDOW_DAYS,
  REVIEW_REMINDER_HOURS,
  SELLER_REPLY_WINDOW_DAYS,
} from "../types/transactions.js";

const reviews = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createReviewSchema = z.object({
  order_id: z.string().uuid("order_id must be a valid UUID"),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const editReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(1000).optional(),
});

const replySchema = z.object({
  reply: z.string().min(1).max(1000),
});

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apply blind logic to reviews for a given requester.
 * If revealed, return all data. If not, hide other party's rating/comment.
 */
function applyBlindLogic(
  reviewRows: Review[],
  requesterId: string
): {
  reviews: Array<
    | (Review & { blinded: false })
    | { id: string; submitted: true; blinded: true }
  >;
  revealed: boolean;
} {
  if (!reviewRows || reviewRows.length === 0) {
    return { reviews: [], revealed: false };
  }

  const isRevealed = reviewRows.some((r) => r.revealed_at !== null);

  if (isRevealed) {
    return {
      reviews: reviewRows.map((r) => ({ ...r, blinded: false as const })),
      revealed: true,
    };
  }

  // Not revealed: return own review fully, other as blinded stub
  return {
    reviews: reviewRows.map((r) => {
      if (r.reviewer_id === requesterId) {
        return { ...r, blinded: false as const };
      }
      return { id: r.id, submitted: true as const, blinded: true as const };
    }),
    revealed: false,
  };
}

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/reviews
 * Submit a review for a completed order.
 */
reviews.post("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = createReviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { order_id, rating, comment } = parsed.data;

  // Look up profile
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Fetch order
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, buyer_id, seller_id, status, completed_at, listing_id, listings!orders_listing_id_fkey(title)")
    .eq("id", order_id)
    .single();

  if (orderError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Validate order status
  if (order.status !== "complete") {
    return c.json(
      { error: "Reviews can only be submitted for completed orders" },
      400
    );
  }

  // Validate user is buyer or seller on this order
  if (!order.buyer_id) {
    return c.json(
      { error: "Guest orders cannot have reviews" },
      400
    );
  }

  const isBuyer = order.buyer_id === profile.id;
  const isSeller = order.seller_id === profile.id;

  if (!isBuyer && !isSeller) {
    return c.json({ error: "You are not a party to this order" }, 403);
  }

  const reviewerRole = isBuyer ? "buyer" : "seller";
  const revieweeId = isBuyer ? order.seller_id : order.buyer_id;

  // Check review window (14 days from completion)
  if (order.completed_at) {
    const completedAt = new Date(order.completed_at);
    const windowEnd = new Date(
      completedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    if (new Date() > windowEnd) {
      return c.json({ error: "Review window has closed" }, 400);
    }
  }

  // Check if already reviewed
  const { data: existing } = await supabase
    .from("reviews")
    .select("id")
    .eq("order_id", order_id)
    .eq("reviewer_role", reviewerRole)
    .single();

  if (existing) {
    return c.json(
      { error: "You have already submitted a review for this order" },
      409
    );
  }

  // Insert review
  const { data: newReview, error: insertError } = await supabase
    .from("reviews")
    .insert({
      order_id,
      reviewer_id: profile.id,
      reviewee_id: revieweeId,
      reviewer_role: reviewerRole,
      rating,
      comment: comment || null,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error inserting review:", insertError);
    return c.json({ error: "Failed to create review" }, 500);
  }

  // Immediate reveal check: count reviews for this order
  const { count } = await supabase
    .from("reviews")
    .select("id", { count: "exact", head: true })
    .eq("order_id", order_id);

  let revealed = false;

  if (count === 2) {
    // Both parties submitted -- reveal both reviews
    const now = new Date().toISOString();
    await supabase
      .from("reviews")
      .update({ revealed_at: now })
      .eq("order_id", order_id);

    revealed = true;

    // Look up names for notification
    const { data: reviewerProfile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", profile.id)
      .single();

    const { data: revieweeProfile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", revieweeId)
      .single();

    const reviewerName = reviewerProfile?.display_name || "the other party";
    const revieweeName = revieweeProfile?.display_name || "the other party";

    // Notify the current reviewer (about the other party's review)
    const template1 = reviewRevealNotification(revieweeName);
    createNotification({
      user_id: profile.id,
      type: "review_revealed",
      ...template1,
      data: { order_id, listing_id: order.listing_id },
    }).catch((err) =>
      console.error("Notification error (fire-and-forget):", err)
    );

    // Notify the other party (about the current reviewer's review)
    const template2 = reviewRevealNotification(reviewerName);
    createNotification({
      user_id: revieweeId,
      type: "review_revealed",
      ...template2,
      data: { order_id, listing_id: order.listing_id },
    }).catch((err) =>
      console.error("Notification error (fire-and-forget):", err)
    );
  }

  return c.json({
    review: {
      ...newReview,
      revealed_at: revealed ? new Date().toISOString() : null,
      blinded: false,
    },
    revealed,
  });
});

/**
 * GET /api/reviews/order/:orderId
 * Get reviews for an order with double-blind logic.
 */
reviews.get("/order/:orderId", clerkMiddleware, async (c) => {
  const orderId = c.req.param("orderId");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Verify user is a party to this order
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, buyer_id, seller_id, status, completed_at")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.buyer_id !== profile.id && order.seller_id !== profile.id) {
    return c.json({ error: "You are not a party to this order" }, 403);
  }

  // Fetch all reviews for this order
  const { data: reviewRows, error: reviewError } = await supabase
    .from("reviews")
    .select("*")
    .eq("order_id", orderId);

  if (reviewError) {
    console.error("Error fetching reviews:", reviewError);
    return c.json({ error: "Failed to fetch reviews" }, 500);
  }

  const blindResult = applyBlindLogic(
    (reviewRows as Review[]) || [],
    profile.id
  );

  // Calculate review window info
  let daysRemaining = 0;
  let canReview = false;

  if (order.status === "complete" && order.completed_at) {
    const completedAt = new Date(order.completed_at);
    const windowEnd = new Date(
      completedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    const now = new Date();
    daysRemaining = Math.max(
      0,
      Math.ceil((windowEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    );

    const hasReviewed = (reviewRows as Review[])?.some(
      (r) => r.reviewer_id === profile.id
    );
    canReview = !hasReviewed && daysRemaining > 0;
  }

  return c.json({
    ...blindResult,
    review_window: {
      days_remaining: daysRemaining,
      can_review: canReview,
    },
  });
});

/**
 * PATCH /api/reviews/:id
 * Edit own review before reveal.
 */
reviews.patch("/:id", clerkMiddleware, async (c) => {
  const reviewId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(reviewId)) {
    return c.json({ error: "Invalid review ID format" }, 400);
  }

  const body = await c.req.json();
  const parsed = editReviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  if (!parsed.data.rating && !parsed.data.comment) {
    return c.json({ error: "At least one field (rating or comment) must be provided" }, 400);
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Fetch review
  const { data: review, error: reviewError } = await supabase
    .from("reviews")
    .select("*")
    .eq("id", reviewId)
    .single();

  if (reviewError || !review) {
    return c.json({ error: "Review not found" }, 404);
  }

  // Verify ownership
  if (review.reviewer_id !== profile.id) {
    return c.json({ error: "You can only edit your own review" }, 403);
  }

  // Verify not yet revealed
  if (review.revealed_at !== null) {
    return c.json({ error: "Cannot edit a review after it has been revealed" }, 400);
  }

  // Build update object
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.rating !== undefined) updates.rating = parsed.data.rating;
  if (parsed.data.comment !== undefined) updates.comment = parsed.data.comment;

  const { data: updatedReview, error: updateError } = await supabase
    .from("reviews")
    .update(updates)
    .eq("id", reviewId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating review:", updateError);
    return c.json({ error: "Failed to update review" }, 500);
  }

  return c.json({ review: { ...updatedReview, blinded: false } });
});

/**
 * POST /api/reviews/:id/reply
 * Seller reply to a buyer review (after reveal).
 */
reviews.post("/:id/reply", clerkMiddleware, async (c) => {
  const reviewId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(reviewId)) {
    return c.json({ error: "Invalid review ID format" }, 400);
  }

  const body = await c.req.json();
  const parsed = replySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Fetch review
  const { data: review, error: reviewError } = await supabase
    .from("reviews")
    .select("*")
    .eq("id", reviewId)
    .single();

  if (reviewError || !review) {
    return c.json({ error: "Review not found" }, 404);
  }

  // Must be a buyer review (seller can only reply to buyer reviews)
  if (review.reviewer_role !== "buyer") {
    return c.json({ error: "Can only reply to buyer reviews" }, 400);
  }

  // Must be revealed
  if (review.revealed_at === null) {
    return c.json({ error: "Cannot reply before review is revealed" }, 400);
  }

  // Verify current user is the reviewee (seller) on this review
  if (review.reviewee_id !== profile.id) {
    return c.json({ error: "Only the reviewed seller can reply" }, 403);
  }

  // Check if already replied
  if (review.seller_reply !== null) {
    return c.json({ error: "You have already replied to this review" }, 409);
  }

  // Check reply window (14 days from reveal)
  const revealedAt = new Date(review.revealed_at);
  const replyWindowEnd = new Date(
    revealedAt.getTime() + SELLER_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  if (new Date() > replyWindowEnd) {
    return c.json({ error: "Reply window has closed" }, 400);
  }

  // Update with reply
  const now = new Date().toISOString();
  const { data: updatedReview, error: updateError } = await supabase
    .from("reviews")
    .update({
      seller_reply: parsed.data.reply,
      seller_reply_at: now,
      updated_at: now,
    })
    .eq("id", reviewId)
    .select()
    .single();

  if (updateError) {
    console.error("Error adding seller reply:", updateError);
    return c.json({ error: "Failed to add reply" }, 500);
  }

  // Notify the buyer about the seller's reply
  const { data: sellerProfile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", profile.id)
    .single();

  const sellerName = sellerProfile?.display_name || "The seller";
  const template = sellerReplyNotification(sellerName);

  // Fetch order for data context
  const { data: order } = await supabase
    .from("orders")
    .select("listing_id")
    .eq("id", review.order_id)
    .single();

  createNotification({
    user_id: review.reviewer_id,
    type: "review_revealed",
    ...template,
    data: {
      order_id: review.order_id,
      listing_id: order?.listing_id || "",
      review_id: reviewId,
    },
  }).catch((err) =>
    console.error("Notification error (fire-and-forget):", err)
  );

  return c.json({ review: { ...updatedReview, blinded: false } });
});

/**
 * GET /api/reviews/seller/:sellerId
 * Public: Get revealed buyer-to-seller reviews for a seller profile.
 * Cursor-paginated on created_at (default limit 10).
 * Query params: ?cursor=<ISO>&limit=<n>
 *
 * NOTE: avg_rating / review_count are aggregated over the CURRENT PAGE only
 * for backwards compatibility. Callers that need total aggregates should
 * query a dedicated stats endpoint in a follow-up.
 */
reviews.get("/seller/:sellerId", optionalClerkMiddleware, async (c) => {
  const sellerId = c.req.param("sellerId");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(sellerId)) {
    return c.json({ error: "Invalid seller ID format" }, 400);
  }

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "10", 10) || 10, 1),
    100
  );

  // Fetch revealed buyer-to-seller reviews with reviewer profile
  let query = supabase
    .from("reviews")
    .select("id, order_id, reviewer_id, rating, comment, seller_reply, seller_reply_at, created_at, profiles!reviews_reviewer_id_fkey(display_name, avatar_url)")
    .eq("reviewee_id", sellerId)
    .eq("reviewer_role", "buyer")
    .not("revealed_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: reviewRows, error: reviewError } = await query;

  if (reviewError) {
    console.error("Error fetching seller reviews:", reviewError);
    return c.json({ error: "Failed to fetch reviews" }, 500);
  }

  const reviewList = (reviewRows || []).map((r) => {
    const profileRaw = r.profiles as unknown;
    const prof = Array.isArray(profileRaw)
      ? (profileRaw[0] as Record<string, unknown> | undefined)
      : (profileRaw as Record<string, unknown> | null);
    return {
      id: r.id,
      order_id: r.order_id,
      reviewer_id: r.reviewer_id,
      reviewer_name: prof?.display_name || null,
      reviewer_avatar_url: prof?.avatar_url || null,
      rating: r.rating,
      comment: r.comment,
      seller_reply: r.seller_reply,
      seller_reply_at: r.seller_reply_at,
      created_at: r.created_at,
    };
  });

  // Compute aggregates
  const reviewCount = reviewList.length;
  const avgRating =
    reviewCount > 0
      ? parseFloat(
          (
            reviewList.reduce((sum, r) => sum + r.rating, 0) / reviewCount
          ).toFixed(1)
        )
      : null;

  const nextCursor =
    reviewList.length === limit
      ? (reviewList[reviewList.length - 1].created_at as string)
      : null;

  return c.json({
    items: reviewList,
    reviews: reviewList,
    next_cursor: nextCursor,
    avg_rating: avgRating,
    review_count: reviewCount,
  });
});

/**
 * POST /api/reviews/cron/auto-reveal
 * Auto-reveal reviews past the 14-day window.
 * Protected by CRON_SECRET Bearer token (not Clerk auth).
 */
reviews.post("/cron/auto-reveal", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("CRON_SECRET environment variable is not set");
    return c.json({ error: "Server configuration error" }, 500);
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = createSupabaseAdmin();

  // Find unrevealed reviews where the order's completed_at is older than 14 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REVIEW_WINDOW_DAYS);

  const { data: expiredReviews, error: queryError } = await supabase
    .from("reviews")
    .select(
      "id, order_id, reviewer_id, reviewee_id, reviewer_role, orders!inner(completed_at, buyer_id, seller_id, listing_id)"
    )
    .is("revealed_at", null)
    .lte("orders.completed_at", cutoff.toISOString());

  if (queryError) {
    console.error("Error querying expired reviews:", queryError);
    return c.json({ error: "Failed to query reviews" }, 500);
  }

  if (!expiredReviews || expiredReviews.length === 0) {
    return c.json({ revealed_orders: 0, revealed_reviews: 0 });
  }

  // Group by order_id
  const orderGroups = new Map<string, typeof expiredReviews>();
  for (const review of expiredReviews) {
    const existing = orderGroups.get(review.order_id) || [];
    existing.push(review);
    orderGroups.set(review.order_id, existing);
  }

  let revealedOrderCount = 0;
  let revealedReviewCount = 0;
  const now = new Date().toISOString();

  for (const [orderId, orderReviews] of orderGroups) {
    // Reveal all reviews for this order
    const { error: updateError } = await supabase
      .from("reviews")
      .update({ revealed_at: now })
      .eq("order_id", orderId);

    if (updateError) {
      console.error(`Error revealing reviews for order ${orderId}:`, updateError);
      continue;
    }

    revealedOrderCount++;
    revealedReviewCount += orderReviews.length;

    // Send notifications to both parties
    const orderRaw = orderReviews[0].orders as unknown;
    const orderData = Array.isArray(orderRaw)
      ? (orderRaw[0] as Record<string, unknown> | undefined)
      : (orderRaw as Record<string, unknown> | null);

    const buyerId = orderData?.buyer_id as string | null;
    const sellerId = orderData?.seller_id as string | null;
    const listingId = (orderData?.listing_id as string) || "";

    // Get names for notifications
    const partyIds = [buyerId, sellerId].filter(Boolean) as string[];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, display_name")
      .in("id", partyIds);

    const nameMap = new Map<string, string>();
    for (const p of profiles || []) {
      nameMap.set(p.id, p.display_name || "the other party");
    }

    if (buyerId) {
      const sellerName = sellerId ? nameMap.get(sellerId) || "the seller" : "the seller";
      const template = reviewRevealNotification(sellerName);
      createNotification({
        user_id: buyerId,
        type: "review_revealed",
        ...template,
        data: { order_id: orderId, listing_id: listingId },
      }).catch((err) =>
        console.error("Notification error (fire-and-forget):", err)
      );
    }

    if (sellerId) {
      const buyerName = buyerId ? nameMap.get(buyerId) || "the buyer" : "the buyer";
      const template = reviewRevealNotification(buyerName);
      createNotification({
        user_id: sellerId,
        type: "review_revealed",
        ...template,
        data: { order_id: orderId, listing_id: listingId },
      }).catch((err) =>
        console.error("Notification error (fire-and-forget):", err)
      );
    }
  }

  return c.json({
    revealed_orders: revealedOrderCount,
    revealed_reviews: revealedReviewCount,
  });
});

/**
 * POST /api/reviews/cron/remind
 * Send 48-hour review reminders for recently completed orders.
 * Protected by CRON_SECRET Bearer token (not Clerk auth).
 */
reviews.post("/cron/remind", async (c) => {
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("CRON_SECRET environment variable is not set");
    return c.json({ error: "Server configuration error" }, 500);
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = createSupabaseAdmin();

  // Find orders completed ~48 hours ago (47-49 hour window to avoid re-sends)
  const now = new Date();
  const lower = new Date(
    now.getTime() - (REVIEW_REMINDER_HOURS + 1) * 60 * 60 * 1000
  );
  const upper = new Date(
    now.getTime() - (REVIEW_REMINDER_HOURS - 1) * 60 * 60 * 1000
  );

  const { data: recentOrders, error: orderError } = await supabase
    .from("orders")
    .select(
      "id, buyer_id, seller_id, listing_id, listings!orders_listing_id_fkey(title)"
    )
    .eq("status", "complete")
    .not("buyer_id", "is", null)
    .gte("completed_at", lower.toISOString())
    .lte("completed_at", upper.toISOString());

  if (orderError) {
    console.error("Error querying recent orders for reminders:", orderError);
    return c.json({ error: "Failed to query orders" }, 500);
  }

  if (!recentOrders || recentOrders.length === 0) {
    return c.json({ reminders_sent: 0 });
  }

  let reminderCount = 0;

  for (const order of recentOrders) {
    const orderIdList = [order.id];

    // Check which parties have already submitted reviews
    const { data: existingReviews } = await supabase
      .from("reviews")
      .select("reviewer_id")
      .in("order_id", orderIdList);

    const reviewerIds = new Set(
      (existingReviews || []).map((r) => r.reviewer_id)
    );

    const listingRaw = order.listings as unknown;
    const listing = Array.isArray(listingRaw)
      ? (listingRaw[0] as Record<string, unknown> | undefined)
      : (listingRaw as Record<string, unknown> | null);
    const listingTitle = listing ? (listing.title as string) : "your item";

    // Days left in the review window
    const daysLeft = REVIEW_WINDOW_DAYS - Math.ceil(REVIEW_REMINDER_HOURS / 24);

    // Remind buyer if they haven't reviewed
    if (order.buyer_id && !reviewerIds.has(order.buyer_id)) {
      const template = reviewReminderNotification(listingTitle, daysLeft);
      createNotification({
        user_id: order.buyer_id,
        type: "review_reminder",
        ...template,
        data: { order_id: order.id, listing_id: order.listing_id },
      }).catch((err) =>
        console.error("Notification error (fire-and-forget):", err)
      );
      reminderCount++;
    }

    // Remind seller if they haven't reviewed
    if (!reviewerIds.has(order.seller_id)) {
      const template = reviewReminderNotification(listingTitle, daysLeft);
      createNotification({
        user_id: order.seller_id,
        type: "review_reminder",
        ...template,
        data: { order_id: order.id, listing_id: order.listing_id },
      }).catch((err) =>
        console.error("Notification error (fire-and-forget):", err)
      );
      reminderCount++;
    }
  }

  return c.json({ reminders_sent: reminderCount });
});

export default reviews;
