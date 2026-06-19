import { Hono } from "hono";
import { z } from "zod";
import crypto from "node:crypto";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  createNotification,
  orderShippedNotification,
  orderDeliveredNotification,
  orderCompleteNotification,
  orderAutoCompleteNotification,
  orderAcceptedNotification,
  orderRejectedNotification,
} from "../lib/notifications.js";
import {
  type OrderStatus,
  type OrderWithListing,
  VALID_ORDER_TRANSITIONS,
  AUTO_COMPLETE_DAYS,
} from "../types/transactions.js";
import { isFirstCompletedOrder, awardReferralCredits } from "../lib/referrals.js";
import { createOrder, OrderServiceError } from "../services/orderService.js";
import { getStripe } from "../lib/stripeClient.js";
import {
  releasePayoutForOrder,
  cancelPayoutForOrder,
} from "../services/payoutService.js";

const orders = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createOrderSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  buyer_email: z.string().email("buyer_email must be a valid email"),
  amount: z.number().int().positive("Amount must be a positive integer (in cents)"),
  currency: z.enum(["AUD", "USD", "NZD"]),
  offer_id: z.string().uuid().optional(),
  stripe_payment_intent_id: z.string().min(1, "stripe_payment_intent_id is required"),
  stripe_checkout_session_id: z.string().optional(),
});

const shipOrderSchema = z.object({
  tracking_number: z.string().max(100).optional(),
  carrier: z.string().max(100).optional(),
});

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/orders
 * Create an order from successful Stripe payment.
 * Uses optionalClerkMiddleware to support guest checkout.
 */
orders.post("/", idempotencyMiddleware, optionalClerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  // Delegate to the order service -- it verifies Stripe, computes
  // commission, writes atomically, and emits "order:created".
  try {
    const order = await createOrder({
      ...parsed.data,
      clerkUserId: clerkUserId || null,
    });
    return c.json({ order }, 201);
  } catch (err) {
    if (err instanceof OrderServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    }
    console.error("Unexpected error in POST /orders:", err);
    return c.json({ error: "Failed to create order" }, 500);
  }
});

/**
 * GET /api/orders/count
 * Returns the buyer's total and completed order counts.
 * Used by the frontend to determine first-time buyer status for welcome discounts.
 */
orders.get("/count", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const [{ count: total, error: totalError }, { count: completed, error: completedError }] =
    await Promise.all([
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("buyer_id", profile.id),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("buyer_id", profile.id)
        .eq("status", "complete"),
    ]);

  if (totalError || completedError) {
    console.error("Error fetching order count:", totalError || completedError);
    return c.json({ error: "Failed to fetch order count" }, 500);
  }

  return c.json({ total: total ?? 0, completed: completed ?? 0 });
});

/**
 * GET /api/orders/mine
 * Buyer's order history. Cursor-paginated on created_at (default limit 20).
 * Query params: ?cursor=<ISO>&limit=<n>
 */
orders.get("/mine", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "20", 10) || 20, 1),
    100
  );

  let query = supabase
    .from("orders")
    .select(
      "*, listings!orders_listing_id_fkey(id, title, category, listing_photos(url, position)), seller:profiles!orders_seller_id_fkey(display_name)"
    )
    .eq("buyer_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: ordersData, error } = await query;

  if (error) {
    console.error("Error fetching buyer orders:", error);
    return c.json({ error: "Failed to fetch orders" }, 500);
  }

  const items: OrderWithListing[] = (ordersData || []).map((row: Record<string, unknown>) => {
    const listing = row.listings as Record<string, unknown> | null;
    const sellerProfile = row.seller as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id as string,
      order_number: row.order_number as string,
      listing_id: row.listing_id as string,
      buyer_id: row.buyer_id as string | null,
      seller_id: row.seller_id as string,
      buyer_email: row.buyer_email as string,
      offer_id: row.offer_id as string | null,
      amount: row.amount as number,
      currency: row.currency as string,
      commission_rate: row.commission_rate as number,
      commission_amount: row.commission_amount as number,
      seller_payout: row.seller_payout as number,
      stripe_payment_intent_id: row.stripe_payment_intent_id as string | null,
      stripe_checkout_session_id: row.stripe_checkout_session_id as string | null,
      status: row.status as OrderStatus,
      shipping_tracking_number: row.shipping_tracking_number as string | null,
      shipping_carrier: row.shipping_carrier as string | null,
      shipped_at: row.shipped_at as string | null,
      delivered_at: row.delivered_at as string | null,
      completed_at: row.completed_at as string | null,
      auto_complete_at: row.auto_complete_at as string | null,
      seller_deadline_at: row.seller_deadline_at as string | null,
      seller_accepted_at: row.seller_accepted_at as string | null,
      seller_rejection_reason: row.seller_rejection_reason as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      listing_title: listing ? (listing.title as string) : "",
      listing_cover_photo_url: coverUrl,
      listing_category: listing ? (listing.category as string) : "",
      counterparty_name: sellerProfile
        ? (sellerProfile.display_name as string | null)
        : null,
    };
  });

  const nextCursor =
    items.length === limit ? items[items.length - 1].created_at : null;

  return c.json({ items, orders: items, next_cursor: nextCursor });
});

/**
 * GET /api/orders/sales
 * Seller's incoming orders. Cursor-paginated on created_at (default limit 20).
 * Query params: ?cursor=<ISO>&limit=<n>
 */
orders.get("/sales", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const cursor = c.req.query("cursor");
  const limitParam = c.req.query("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam || "20", 10) || 20, 1),
    100
  );

  let query = supabase
    .from("orders")
    .select(
      "*, listings!orders_listing_id_fkey(id, title, category, listing_photos(url, position)), buyer:profiles!orders_buyer_id_fkey(display_name)"
    )
    .eq("seller_id", profile.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: ordersData, error } = await query;

  if (error) {
    console.error("Error fetching seller orders:", error);
    return c.json({ error: "Failed to fetch orders" }, 500);
  }

  const items: OrderWithListing[] = (ordersData || []).map((row: Record<string, unknown>) => {
    const listing = row.listings as Record<string, unknown> | null;
    const buyerProfile = row.buyer as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id as string,
      order_number: row.order_number as string,
      listing_id: row.listing_id as string,
      buyer_id: row.buyer_id as string | null,
      seller_id: row.seller_id as string,
      buyer_email: row.buyer_email as string,
      offer_id: row.offer_id as string | null,
      amount: row.amount as number,
      currency: row.currency as string,
      commission_rate: row.commission_rate as number,
      commission_amount: row.commission_amount as number,
      seller_payout: row.seller_payout as number,
      stripe_payment_intent_id: row.stripe_payment_intent_id as string | null,
      stripe_checkout_session_id: row.stripe_checkout_session_id as string | null,
      status: row.status as OrderStatus,
      shipping_tracking_number: row.shipping_tracking_number as string | null,
      shipping_carrier: row.shipping_carrier as string | null,
      shipped_at: row.shipped_at as string | null,
      delivered_at: row.delivered_at as string | null,
      completed_at: row.completed_at as string | null,
      auto_complete_at: row.auto_complete_at as string | null,
      seller_deadline_at: row.seller_deadline_at as string | null,
      seller_accepted_at: row.seller_accepted_at as string | null,
      seller_rejection_reason: row.seller_rejection_reason as string | null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      listing_title: listing ? (listing.title as string) : "",
      listing_cover_photo_url: coverUrl,
      listing_category: listing ? (listing.category as string) : "",
      counterparty_name: buyerProfile
        ? (buyerProfile.display_name as string | null)
        : null,
    };
  });

  const nextCursor =
    items.length === limit ? items[items.length - 1].created_at : null;

  return c.json({ items, orders: items, next_cursor: nextCursor });
});

/**
 * GET /api/orders/:id
 * Get single order with full details.
 */
orders.get("/:id", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "*, listings!orders_listing_id_fkey(id, title, category, description, listing_photos(id, url, position)), buyer:profiles!orders_buyer_id_fkey(id, display_name, avatar_url), seller:profiles!orders_seller_id_fkey(id, display_name, avatar_url, location)"
    )
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Only buyer or seller can view
  if (order.buyer_id !== profile.id && order.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to view this order" }, 403);
  }

  // Enrich the embedded `buyer` object with trust signals the seller needs
  // when reviewing the buyer's note: average rating across all completed
  // orders + total completed purchases. Skipped for guest orders (no buyer
  // profile). Two parallel queries — fixed cost regardless of buyer history.
  if (order.buyer_id) {
    const [{ data: buyerReviews }, { count: completedCount }] = await Promise.all([
      supabase
        .from("reviews")
        .select("rating")
        .eq("reviewee_id", order.buyer_id)
        .eq("reviewer_role", "seller")
        .not("revealed_at", "is", null),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("buyer_id", order.buyer_id)
        .eq("status", "complete"),
    ]);

    const ratingRows = (buyerReviews || []) as Array<{ rating: number }>;
    const reviewCount = ratingRows.length;
    const avgRating =
      reviewCount > 0
        ? parseFloat(
            (ratingRows.reduce((sum, r) => sum + r.rating, 0) / reviewCount).toFixed(1)
          )
        : null;

    const buyer = order.buyer as Record<string, unknown> | null;
    if (buyer) {
      buyer.avg_rating = avgRating;
      buyer.review_count = reviewCount;
      buyer.total_purchases = completedCount || 0;
    }
  }

  return c.json({ order });
});

/**
 * GET /api/orders/:id/buyer-address
 * Returns the buyer's CURRENT default shipping address for this order.
 * Only the seller (or buyer) on this order can view it.
 *
 * Returns the live default — if the buyer updates their default address
 * after ordering, the seller will see the new one. If you need an address
 * snapshot frozen at order time, switch to storing a copy on the order row.
 *
 * 400 — guest order (no buyer profile, no saved address)
 * 403 — caller is not the buyer or seller on this order
 * 404 — order not found, or buyer hasn't saved any address yet
 */
orders.get("/:id/buyer-address", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, buyer_id, seller_id")
    .eq("id", orderId)
    .single();

  if (orderError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.buyer_id !== profile.id && order.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to view this address" }, 403);
  }

  if (!order.buyer_id) {
    return c.json({ error: "Guest order has no saved buyer address" }, 400);
  }

  // Prefer the buyer's default; fall back to most-recent saved address.
  const { data: defaultAddress } = await supabase
    .from("user_addresses")
    .select("*")
    .eq("user_id", order.buyer_id)
    .eq("is_default", true)
    .maybeSingle();

  if (defaultAddress) {
    return c.json({ address: defaultAddress });
  }

  const { data: anyAddress } = await supabase
    .from("user_addresses")
    .select("*")
    .eq("user_id", order.buyer_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!anyAddress) {
    return c.json({ error: "Buyer has not saved a shipping address yet" }, 404);
  }

  return c.json({ address: anyAddress });
});

/**
 * PATCH /api/orders/:id/ship
 * Seller marks order as shipped.
 */
orders.patch("/:id/ship", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  // Parse body
  const body = await c.req.json();
  const parsed = shipOrderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { tracking_number, carrier } = parsed.data;

  // Fetch order
  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Must be paid
  if (order.status !== "paid") {
    return c.json(
      { error: `Cannot ship order with status '${order.status}'` },
      400
    );
  }

  // Pickup orders never go through the shipped state. The seller hands
  // the item over in person and the buyer marks it collected via the
  // confirm-received endpoint, which takes the order straight to
  // complete. Reject any attempt to write a tracking number against
  // a pickup order — defense-in-depth in case the FE sends the wrong
  // CTA from a stale screen.
  if (order.delivery_method === "pickup") {
    return c.json(
      { error: "Pickup orders cannot be marked as shipped" },
      400
    );
  }

  // User must be seller
  if (order.seller_id !== profile.id) {
    return c.json({ error: "Only the seller can ship this order" }, 403);
  }

  // Seller must have accepted before shipping
  if (!order.seller_accepted_at) {
    return c.json({ error: "You must accept the order before marking it as shipped" }, 400);
  }

  // Calculate auto-complete date (7 days from now)
  const autoCompleteAt = new Date();
  autoCompleteAt.setDate(autoCompleteAt.getDate() + AUTO_COMPLETE_DAYS);

  // Update order
  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update({
      status: "shipped" as OrderStatus,
      shipping_tracking_number: tracking_number || null,
      shipping_carrier: carrier || null,
      shipped_at: new Date().toISOString(),
      auto_complete_at: autoCompleteAt.toISOString(),
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error shipping order:", updateError);
    return c.json({ error: "Failed to update order" }, 500);
  }

  // Mark listing as sold now that it has physically shipped
  await supabase
    .from("listings")
    .update({ status: "sold" })
    .eq("id", order.listing_id);

  // Notify buyer
  if (order.buyer_id) {
    const listing = order.listings as Record<string, unknown>;
    const shippedTemplate = orderShippedNotification(listing.title as string, tracking_number);
    await createNotification({
      user_id: order.buyer_id,
      type: "order_shipped",
      ...shippedTemplate,
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    });
  }

  // Post a system-style message into the buyer↔seller chat so the buyer sees
  // the shipping update in their inbox between regular messages. Fire-and-
  // forget: chat hiccups never block the ship operation.
  if (order.buyer_id) {
    (async () => {
      try {
        const { postSystemMessage } = await import("../services/conversationService.js");
        const { data: sellerProfile } = await supabase
          .from("profiles")
          .select("display_name")
          .eq("id", order.seller_id)
          .single();
        const sellerName = sellerProfile?.display_name || "The seller";
        const content = tracking_number
          ? `${sellerName} added tracking. Your order is on its way!`
          : `${sellerName} marked your order as shipped. It's on its way!`;
        await postSystemMessage({
          listingId: order.listing_id,
          buyerId: order.buyer_id,
          sellerId: order.seller_id,
          content,
          kind: "order_shipped",
        });
      } catch (err) {
        console.error("Failed to post shipped system message:", err);
      }
    })();
  }

  return c.json({ order: updatedOrder });
});

/**
 * POST /api/orders/:id/shipping-receipt
 * Seller uploads a photo of the postage receipt / shipping label as proof
 * of dispatch. Optional — many sellers won't have a physical receipt.
 * Visible to the buyer on the order detail screen.
 *
 * Multipart form: photo=<File>
 * Returns: { shipping_receipt_photo_url }
 *
 * Idempotent: replacing an existing receipt deletes the old file from
 * storage before writing the new one.
 *
 * 400 — no/invalid file
 * 403 — caller is not the seller
 * 404 — order not found
 */
orders.post("/:id/shipping-receipt", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("id, seller_id, shipping_receipt_photo_url")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.seller_id !== profile.id) {
    return c.json({ error: "Only the seller can upload a shipping receipt" }, 403);
  }

  // Parse multipart form
  const formData = await c.req.formData();
  const photo = formData.get("photo");

  if (!photo || !(photo instanceof File)) {
    return c.json({ error: "Photo file is required (field: photo)" }, 400);
  }

  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!allowedTypes.includes(photo.type)) {
    return c.json(
      { error: "Invalid file type. Allowed: JPEG, PNG, WebP, HEIC" },
      400
    );
  }

  // 10MB cap — same as listing photos
  const maxSize = 10 * 1024 * 1024;
  if (photo.size > maxSize) {
    return c.json({ error: "File too large. Maximum 10MB" }, 400);
  }

  // Storage path: shipping-receipts/{order_id}/{uuid}.{ext}
  // Reusing the listing-photos bucket keeps RLS + grants simple.
  const ext = photo.name.split(".").pop() || "jpg";
  const fileId = crypto.randomUUID();
  const storagePath = `shipping-receipts/${orderId}/${fileId}.${ext}`;

  const fileBuffer = await photo.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from("listing-photos")
    .upload(storagePath, fileBuffer, {
      contentType: photo.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("Error uploading shipping receipt:", uploadError);
    return c.json({ error: "Failed to upload receipt" }, 500);
  }

  const { data: urlData } = supabase.storage
    .from("listing-photos")
    .getPublicUrl(storagePath);

  // If there was an existing receipt, delete the old file so we don't
  // accumulate orphaned uploads in storage.
  if (order.shipping_receipt_photo_url) {
    const oldPath = order.shipping_receipt_photo_url
      .split("/listing-photos/")
      .pop();
    if (oldPath) {
      await supabase.storage
        .from("listing-photos")
        .remove([oldPath])
        .catch(() => {});
    }
  }

  const { error: updateError } = await supabase
    .from("orders")
    .update({ shipping_receipt_photo_url: urlData.publicUrl })
    .eq("id", orderId);

  if (updateError) {
    console.error("Error saving receipt URL on order:", updateError);
    // Clean up the file we just uploaded so we don't leave it orphaned
    await supabase.storage.from("listing-photos").remove([storagePath]).catch(() => {});
    return c.json({ error: "Failed to save receipt" }, 500);
  }

  return c.json({ shipping_receipt_photo_url: urlData.publicUrl });
});

/**
 * PATCH /api/orders/:id/deliver
 * Buyer confirms delivery.
 */
orders.patch("/:id/deliver", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  // Fetch order
  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Must be shipped
  if (order.status !== "shipped") {
    return c.json(
      { error: `Cannot confirm delivery for order with status '${order.status}'` },
      400
    );
  }

  // User must be buyer
  if (order.buyer_id !== profile.id) {
    return c.json({ error: "Only the buyer can confirm delivery" }, 403);
  }

  // Update order
  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update({
      status: "delivered" as OrderStatus,
      delivered_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error confirming delivery:", updateError);
    return c.json({ error: "Failed to update order" }, 500);
  }

  // Notify seller
  const listing = order.listings as Record<string, unknown>;
  const deliveredTemplate = orderDeliveredNotification(listing.title as string);
  await createNotification({
    user_id: order.seller_id,
    type: "order_delivered",
    ...deliveredTemplate,
    data: { order_id: orderId, listing_id: order.listing_id, role: "seller" },
  });

  return c.json({ order: updatedOrder });
});

/**
 * POST /api/orders/:id/confirm-received
 * Buyer confirms they received the item. Transitions the order straight to
 * `complete` (skipping the intermediate `delivered` state when called from
 * `shipped`), so reviews unlock immediately. Fires the delivered notification
 * to the seller if it hadn't been fired yet, then the complete notifications.
 */
orders.post("/:id/confirm-received", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.buyer_id !== profile.id) {
    return c.json({ error: "Only the buyer can confirm receipt" }, 403);
  }

  // Shipping orders: must be shipped (preferred) or already delivered.
  // Pickup orders: jump straight from paid → complete on the buyer's
  // "mark as collected" tap, as long as the seller has accepted (no
  // accepting means the order is still in the 48h seller-decision
  // window and shouldn't be confirmable yet).
  if (order.delivery_method === "pickup") {
    if (order.status !== "paid") {
      return c.json(
        { error: `Cannot confirm receipt for order with status '${order.status}'` },
        400
      );
    }
    if (!order.seller_accepted_at) {
      return c.json(
        { error: "Seller has not accepted the order yet" },
        400
      );
    }
  } else if (order.status !== "shipped" && order.status !== "delivered") {
    return c.json(
      { error: `Cannot confirm receipt for order with status '${order.status}'` },
      400
    );
  }

  const wasShipped = order.status === "shipped";
  const now = new Date().toISOString();

  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update({
      status: "complete" as OrderStatus,
      delivered_at: order.delivered_at || now,
      completed_at: now,
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error confirming receipt:", updateError);
    return c.json({ error: "Failed to confirm receipt" }, 500);
  }

  // Mark the listing as sold. Shipping orders already did this in
  // /ship, but pickup orders skip that path entirely — without this
  // line a completed pickup order leaves the listing stuck at
  // 'reserved' forever, so it still shows up as in-flight in the
  // seller's dashboard. Idempotent for shipping orders.
  await supabase
    .from("listings")
    .update({ status: "sold" })
    .eq("id", order.listing_id);

  // Release escrow funds to the seller. Stripe Connect sellers get an
  // automatic transfer; Wise/PayPal sellers flip to ready_for_payout
  // for the admin to disburse manually. Fire-and-forget — disbursement
  // failures land in the payout row (status='failed'), they don't
  // unwind the order completion.
  releasePayoutForOrder(orderId).catch((err) =>
    console.error("Failed to release payout on confirm-received:", err)
  );

  const listing = order.listings as Record<string, unknown>;

  // If we skipped the explicit delivered transition, still fire the
  // "delivered" notification to the seller so their timeline is correct.
  if (wasShipped) {
    const deliveredTemplate = orderDeliveredNotification(listing.title as string);
    await createNotification({
      user_id: order.seller_id,
      type: "order_delivered",
      ...deliveredTemplate,
      data: { order_id: orderId, listing_id: order.listing_id, role: "seller" },
    });
  }

  // Complete notifications for both parties
  if (order.buyer_id) {
    const buyerTemplate = orderCompleteNotification(listing.title as string, "buyer");
    await createNotification({
      user_id: order.buyer_id,
      type: "order_complete",
      ...buyerTemplate,
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    });
  }
  const sellerTemplate = orderCompleteNotification(
    listing.title as string,
    "seller",
    order.seller_payout,
    order.currency
  );
  await createNotification({
    user_id: order.seller_id,
    type: "order_complete",
    ...sellerTemplate,
    data: { order_id: orderId, listing_id: order.listing_id, role: "seller" },
  });

  // Fire-and-forget referral credit check (mirrors /complete)
  if (order.buyer_id) {
    (async () => {
      try {
        const isFirst = await isFirstCompletedOrder(order.buyer_id);
        if (isFirst) {
          const { data: referral } = await supabase
            .from("referrals")
            .select("*, referral_codes!referrals_referral_code_id_fkey(user_id)")
            .eq("referred_id", order.buyer_id)
            .eq("status", "pending")
            .single();

          if (referral) {
            await awardReferralCredits({
              referrer_id: (referral.referral_codes as { user_id: string }).user_id,
              referred_id: order.buyer_id,
              referral_code_id: referral.referral_code_id,
              qualifying_order_id: orderId,
            });
          }
        }
      } catch (err) {
        console.error("Error processing referral credit:", err);
      }
    })();
  }

  return c.json({ order: updatedOrder });
});

/**
 * PATCH /api/orders/:id/complete
 * Mark order as complete.
 */
orders.patch("/:id/complete", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  // Fetch order
  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // Must be delivered
  const allowed = VALID_ORDER_TRANSITIONS[order.status as OrderStatus];
  if (!allowed || !allowed.includes("complete")) {
    return c.json(
      { error: `Cannot complete order with status '${order.status}'` },
      400
    );
  }

  // User must be buyer or seller
  if (order.buyer_id !== profile.id && order.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to complete this order" }, 403);
  }

  // Update order
  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update({
      status: "complete" as OrderStatus,
      completed_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error completing order:", updateError);
    return c.json({ error: "Failed to complete order" }, 500);
  }

  // Release escrow funds — same dispatch as confirm-received.
  releasePayoutForOrder(orderId).catch((err) =>
    console.error("Failed to release payout on complete:", err)
  );

  // Notify both parties
  const listing = order.listings as Record<string, unknown>;

  if (order.buyer_id) {
    const buyerTemplate = orderCompleteNotification(listing.title as string, "buyer");
    await createNotification({
      user_id: order.buyer_id,
      type: "order_complete",
      ...buyerTemplate,
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    });
  }

  const sellerTemplate = orderCompleteNotification(
    listing.title as string,
    "seller",
    order.seller_payout,
    order.currency
  );
  await createNotification({
    user_id: order.seller_id,
    type: "order_complete",
    ...sellerTemplate,
    data: { order_id: orderId, listing_id: order.listing_id, role: "seller" },
  });

  // Fire-and-forget referral credit check
  if (order.buyer_id) {
    (async () => {
      try {
        const isFirst = await isFirstCompletedOrder(order.buyer_id);
        if (isFirst) {
          // Check if buyer was referred
          const { data: referral } = await supabase
            .from("referrals")
            .select("*, referral_codes!referrals_referral_code_id_fkey(user_id)")
            .eq("referred_id", order.buyer_id)
            .eq("status", "pending")
            .single();

          if (referral) {
            await awardReferralCredits({
              referrer_id: (referral.referral_codes as any).user_id,
              referred_id: order.buyer_id,
              referral_code_id: referral.referral_code_id,
              qualifying_order_id: orderId,
            });
          }
        }
      } catch (err) {
        console.error("Error processing referral credit:", err);
      }
    })();
  }

  return c.json({ order: updatedOrder });
});

/**
 * POST /api/orders/:id/accept
 * Seller accepts a paid order. Sets seller_accepted_at, notifies buyer.
 * No status change — listing stays reserved, order stays paid.
 */
orders.post("/:id/accept", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.seller_id !== profile.id) {
    return c.json({ error: "Only the seller can accept this order" }, 403);
  }

  if (order.status !== "paid") {
    return c.json({ error: `Cannot accept order with status '${order.status}'` }, 400);
  }

  if (order.seller_accepted_at) {
    return c.json({ error: "Order already accepted" }, 400);
  }

  // Pickup orders skip shipping entirely, so there's no shipped_at
  // moment to count auto-complete from. Anchor the auto-complete
  // window on acceptance instead — same AUTO_COMPLETE_DAYS, just a
  // different starting point. Shipping orders still get auto_complete_at
  // set in the ship endpoint after we know shipped_at.
  const acceptedAt = new Date();
  const acceptUpdates: Record<string, string> = {
    seller_accepted_at: acceptedAt.toISOString(),
  };
  if (order.delivery_method === "pickup") {
    const autoCompleteAt = new Date(acceptedAt);
    autoCompleteAt.setDate(autoCompleteAt.getDate() + AUTO_COMPLETE_DAYS);
    acceptUpdates.auto_complete_at = autoCompleteAt.toISOString();
  }

  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update(acceptUpdates)
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error accepting order:", updateError);
    return c.json({ error: "Failed to accept order" }, 500);
  }

  // Notify buyer
  if (order.buyer_id) {
    const listing = order.listings as Record<string, unknown>;
    await createNotification({
      user_id: order.buyer_id,
      type: "order_accepted",
      ...orderAcceptedNotification(listing.title as string),
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    });
  }

  return c.json({ order: updatedOrder });
});

const rejectOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});

/**
 * POST /api/orders/:id/reject
 * Seller rejects a paid order. Listing → active, order → cancelled, Stripe refund, buyer notified.
 */
orders.post("/:id/reject", clerkMiddleware, requireProfile, async (c) => {
  const orderId = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(orderId)) {
    return c.json({ error: "Invalid order ID format" }, 400);
  }

  const body = await c.req.json();
  const parsed = rejectOrderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { reason } = parsed.data;

  const { data: order, error: fetchError } = await supabase
    .from("orders")
    .select("*, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();

  if (fetchError || !order) {
    return c.json({ error: "Order not found" }, 404);
  }

  if (order.seller_id !== profile.id) {
    return c.json({ error: "Only the seller can reject this order" }, 403);
  }

  if (order.status !== "paid") {
    return c.json({ error: `Cannot reject order with status '${order.status}'` }, 400);
  }

  // Restore listing to active
  await supabase
    .from("listings")
    .update({ status: "active" })
    .eq("id", order.listing_id);

  // Cancel order
  const { data: updatedOrder, error: updateError } = await supabase
    .from("orders")
    .update({
      status: "cancelled" as OrderStatus,
      seller_rejection_reason: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .select()
    .single();

  if (updateError) {
    console.error("Error rejecting order:", updateError);
    return c.json({ error: "Failed to reject order" }, 500);
  }

  // Attempt Stripe refund (fire-and-forget). With escrow this is a clean
  // refund from Kifaayat's balance — no clawback from a seller's Connect
  // account, no negative-balance risk on their side.
  if (order.stripe_payment_intent_id) {
    getStripe().refunds.create({ payment_intent: order.stripe_payment_intent_id }).catch(
      (err) => console.error(`Stripe refund failed for order ${orderId}:`, err)
    );
  }

  // Tombstone the payout ledger row so it doesn't sit pending forever.
  cancelPayoutForOrder(orderId, reason || "Order rejected by seller").catch(
    (err) => console.error(`Failed to cancel payout for order ${orderId}:`, err)
  );

  // Notify buyer
  if (order.buyer_id) {
    const listing = order.listings as Record<string, unknown>;
    await createNotification({
      user_id: order.buyer_id,
      type: "order_rejected",
      ...orderRejectedNotification(listing.title as string, reason),
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    });
  }

  return c.json({ order: updatedOrder });
});

/**
 * POST /api/orders/cron/auto-complete
 * Auto-complete shipped orders past their auto_complete_at deadline.
 * Protected by CRON_SECRET Bearer token (not Clerk auth).
 * Schedule: every 6 hours via external cron service.
 */
orders.post("/cron/auto-complete", async (c) => {
  // Validate cron secret
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

  // Find orders past auto-complete deadline. Includes:
  //   - Shipping orders that are 'shipped' and past auto_complete_at
  //     (buyer never confirmed receipt within the window)
  //   - Pickup orders that are 'paid' + seller-accepted and past
  //     auto_complete_at (buyer never marked collected; seller has
  //     already received their payout window as if the pickup
  //     happened — same protection as the shipping flow).
  const nowIso = new Date().toISOString();
  const { data: overdueOrders, error: queryError } = await supabase
    .from("orders")
    .select("id, buyer_id, seller_id, listing_id, currency, seller_payout, listings!orders_listing_id_fkey(title)")
    .or(
      "and(status.eq.shipped,delivery_method.eq.shipping),and(status.eq.paid,delivery_method.eq.pickup)"
    )
    .not("auto_complete_at", "is", null)
    .lte("auto_complete_at", nowIso);

  if (queryError) {
    console.error("Error querying overdue orders:", queryError);
    return c.json({ error: "Failed to query orders" }, 500);
  }

  if (!overdueOrders || overdueOrders.length === 0) {
    return c.json({ completed: 0 });
  }

  let completedCount = 0;

  for (const order of overdueOrders) {
    // Update to complete
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: "complete" as OrderStatus,
        completed_at: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (updateError) {
      console.error(`Error auto-completing order ${order.id}:`, updateError);
      continue;
    }

    completedCount++;

    // Mark the listing as sold. Pickup orders never went through /ship,
    // so without this they'd sit at 'reserved' indefinitely even after
    // auto-completion. Idempotent for shipping orders.
    await supabase
      .from("listings")
      .update({ status: "sold" })
      .eq("id", order.listing_id);

    // Release escrow funds for this auto-completed order. Fire-and-forget
    // so a single Stripe transfer failure doesn't block the rest of the
    // overdue batch from completing.
    releasePayoutForOrder(order.id).catch((err) =>
      console.error(`Failed to release payout on auto-complete for order ${order.id}:`, err)
    );

    const listingRaw = order.listings as unknown;
    const listing = Array.isArray(listingRaw) ? listingRaw[0] as Record<string, unknown> | undefined : listingRaw as Record<string, unknown> | null;
    const listingTitle = listing ? (listing.title as string) : "your item";

    // Notify buyer
    if (order.buyer_id) {
      const buyerAutoTemplate = orderAutoCompleteNotification(listingTitle, "buyer");
      await createNotification({
        user_id: order.buyer_id,
        type: "order_complete",
        ...buyerAutoTemplate,
        data: { order_id: order.id, listing_id: order.listing_id, role: "buyer" },
      });
    }

    // Notify seller
    const sellerAutoTemplate = orderAutoCompleteNotification(
      listingTitle,
      "seller",
      order.seller_payout,
      order.currency
    );
    await createNotification({
      user_id: order.seller_id,
      type: "order_complete",
      ...sellerAutoTemplate,
      data: { order_id: order.id, listing_id: order.listing_id, role: "seller" },
    });

    // Fire-and-forget referral credit check
    if (order.buyer_id) {
      (async () => {
        try {
          const isFirst = await isFirstCompletedOrder(order.buyer_id);
          if (isFirst) {
            const { data: referral } = await supabase
              .from("referrals")
              .select("*, referral_codes!referrals_referral_code_id_fkey(user_id)")
              .eq("referred_id", order.buyer_id)
              .eq("status", "pending")
              .single();

            if (referral) {
              await awardReferralCredits({
                referrer_id: (referral.referral_codes as any).user_id,
                referred_id: order.buyer_id,
                referral_code_id: referral.referral_code_id,
                qualifying_order_id: order.id,
              });
            }
          }
        } catch (err) {
          console.error("Error processing referral credit (auto-complete):", err);
        }
      })();
    }
  }

  return c.json({ completed: completedCount });
});

export default orders;
