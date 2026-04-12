import { Hono } from "hono";
import { z } from "zod";
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
} from "../lib/notifications.js";
import {
  type OrderStatus,
  type OrderWithListing,
  VALID_ORDER_TRANSITIONS,
  AUTO_COMPLETE_DAYS,
} from "../types/transactions.js";
import { isFirstCompletedOrder, awardReferralCredits } from "../lib/referrals.js";
import { createOrder, OrderServiceError } from "../services/orderService.js";

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

  return c.json({ order });
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

  // User must be seller
  if (order.seller_id !== profile.id) {
    return c.json({ error: "Only the seller can ship this order" }, 403);
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

  // Notify buyer
  if (order.buyer_id) {
    const listing = order.listings as Record<string, unknown>;
    const shippedTemplate = orderShippedNotification(listing.title as string, tracking_number);
    await createNotification({
      user_id: order.buyer_id,
      type: "order_shipped",
      ...shippedTemplate,
      data: { order_id: orderId, listing_id: order.listing_id },
    });
  }

  return c.json({ order: updatedOrder });
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
    data: { order_id: orderId, listing_id: order.listing_id },
  });

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

  // Notify both parties
  const listing = order.listings as Record<string, unknown>;

  if (order.buyer_id) {
    const buyerTemplate = orderCompleteNotification(listing.title as string, "buyer");
    await createNotification({
      user_id: order.buyer_id,
      type: "order_complete",
      ...buyerTemplate,
      data: { order_id: orderId, listing_id: order.listing_id },
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
    data: { order_id: orderId, listing_id: order.listing_id },
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

  // Find shipped orders past auto-complete deadline
  const { data: overdueOrders, error: queryError } = await supabase
    .from("orders")
    .select("id, buyer_id, seller_id, listing_id, currency, seller_payout, listings!orders_listing_id_fkey(title)")
    .eq("status", "shipped")
    .not("auto_complete_at", "is", null)
    .lte("auto_complete_at", new Date().toISOString());

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
        data: { order_id: order.id, listing_id: order.listing_id },
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
      data: { order_id: order.id, listing_id: order.listing_id },
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
