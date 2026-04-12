import { Hono } from "hono";
import { z } from "zod";
import Stripe from "stripe";
import { clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { getSellerCommissionRate } from "../lib/commission.js";
import {
  generateOrderNumber,
  type OrderStatus,
} from "../types/transactions.js";
import { createNotification, orderPaidNotification } from "../lib/notifications.js";
import { getAvailableCreditBalance, redeemCredits } from "../lib/referrals.js";

// ============================================================
// Stripe singleton (mirrors stripe.ts pattern)
// ============================================================

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

const cart = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const addToCartSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
});

const mergeCartSchema = z.object({
  listing_ids: z
    .array(z.string().uuid("Each listing_id must be a valid UUID"))
    .min(1, "At least one listing_id is required")
    .max(50, "Maximum 50 items allowed"),
});

// ============================================================
// Helpers
// ============================================================

interface ShippingCalcItem {
  listing_id: string;
  shipping_cost_amount: number | null;
  free_shipping: boolean;
}

interface ShippingResult {
  shipping_total: number;
  shipping_before_discount: number;
  bundle_savings: number;
  item_statuses: Map<string, "paid" | "free" | "bundled">;
}

function calculateBundleShipping(items: ShippingCalcItem[]): ShippingResult {
  const item_statuses = new Map<string, "paid" | "free" | "bundled">();

  // Separate free-shipping items
  const paidItems = items.filter(
    (i) => !i.free_shipping && (i.shipping_cost_amount ?? 0) > 0
  );
  const sorted = [...paidItems].sort(
    (a, b) => (b.shipping_cost_amount ?? 0) - (a.shipping_cost_amount ?? 0)
  );

  const shipping_before_discount = sorted.reduce(
    (sum, i) => sum + (i.shipping_cost_amount ?? 0),
    0
  );
  const shipping_total =
    sorted.length > 0 ? (sorted[0].shipping_cost_amount ?? 0) : 0;
  const bundle_savings = shipping_before_discount - shipping_total;

  // Map each item to its shipping status
  for (const item of items) {
    if (item.free_shipping || (item.shipping_cost_amount ?? 0) === 0) {
      item_statuses.set(item.listing_id, "free");
    } else if (sorted.length > 0 && item.listing_id === sorted[0].listing_id) {
      item_statuses.set(item.listing_id, "paid");
    } else {
      item_statuses.set(item.listing_id, "bundled");
    }
  }

  return { shipping_total, shipping_before_discount, bundle_savings, item_statuses };
}

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/cart
 * Add a listing to the authenticated user's cart. Idempotent.
 */
cart.post("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = addToCartSchema.safeParse(body);
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

  if (listing.status !== "active") {
    return c.json({ error: "Listing is not available" }, 400);
  }

  // Prevent adding own listings
  if (listing.seller_id === profile.id) {
    return c.json({ error: "You cannot add your own listing to cart" }, 400);
  }

  // Idempotent insert
  const { error: insertError } = await supabase
    .from("cart_items")
    .upsert(
      { user_id: profile.id, listing_id },
      { onConflict: "user_id,listing_id", ignoreDuplicates: true }
    );

  if (insertError) {
    // Check if it's a duplicate (already in cart)
    if (insertError.code === "23505") {
      return c.json({ added: false, reason: "already_in_cart" });
    }
    console.error("Error adding to cart:", insertError);
    return c.json({ error: "Failed to add to cart" }, 500);
  }

  return c.json({ added: true }, 201);
});

/**
 * GET /api/cart
 * Fetch cart items grouped by seller with bundle shipping calculations.
 */
cart.get("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Fetch cart items with listing + seller data + cover photo
  const { data: cartItems, error } = await supabase
    .from("cart_items")
    .select(
      `
      id, listing_id, added_at,
      listings!cart_items_listing_id_fkey(
        id, title, price_amount, price_currency, status,
        shipping_cost_amount, free_shipping, seller_id,
        listing_photos(url, position),
        profiles!listings_seller_id_fkey(id, display_name, avatar_url, stripe_account_id, stripe_onboarding_complete)
      )
    `
    )
    .eq("user_id", profile.id)
    .order("added_at", { ascending: false });

  if (error) {
    console.error("Error fetching cart:", error);
    return c.json({ error: "Failed to fetch cart" }, 500);
  }

  if (!cartItems || cartItems.length === 0) {
    return c.json({
      groups: [],
      summary: {
        items_total: 0,
        shipping_total: 0,
        bundle_savings: 0,
        grand_total: 0,
        item_count: 0,
      },
      removed_count: 0,
      removed_titles: [],
    });
  }

  // Separate active vs non-active items
  const activeItems: typeof cartItems = [];
  const removedItems: { id: string; title: string }[] = [];

  for (const item of cartItems) {
    const listing = item.listings as unknown as Record<string, unknown> | null;
    if (!listing || (listing.status as string) !== "active") {
      removedItems.push({
        id: item.id,
        title: listing ? (listing.title as string) : "Unknown item",
      });
    } else {
      activeItems.push(item);
    }
  }

  // Auto-cleanup: delete non-active items from cart
  if (removedItems.length > 0) {
    const removedIds = removedItems.map((r) => r.id);
    await supabase.from("cart_items").delete().in("id", removedIds);
  }

  // Group active items by seller
  const sellerGroups = new Map<
    string,
    {
      seller_id: string;
      seller_name: string;
      seller_avatar_url: string | null;
      items: Array<{
        listing_id: string;
        title: string;
        price_amount: number;
        price_currency: string;
        cover_photo_url: string | null;
        shipping_cost_amount: number;
        free_shipping: boolean;
        shipping_status?: "paid" | "free" | "bundled";
      }>;
    }
  >();

  for (const item of activeItems) {
    const listing = item.listings as unknown as Record<string, unknown>;
    const seller = listing.profiles as unknown as Record<string, unknown>;
    const photos = listing.listing_photos as unknown as Array<Record<string, unknown>> | null;

    const sellerId = seller.id as string;

    // Get cover photo (position 0 or first)
    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    if (!sellerGroups.has(sellerId)) {
      sellerGroups.set(sellerId, {
        seller_id: sellerId,
        seller_name: (seller.display_name as string) || "Unknown Seller",
        seller_avatar_url: (seller.avatar_url as string | null) || null,
        items: [],
      });
    }

    sellerGroups.get(sellerId)!.items.push({
      listing_id: listing.id as string,
      title: listing.title as string,
      price_amount: listing.price_amount as number,
      price_currency: (listing.price_currency as string) || "AUD",
      cover_photo_url: coverUrl,
      shipping_cost_amount: (listing.shipping_cost_amount as number) || 0,
      free_shipping: (listing.free_shipping as boolean) || false,
    });
  }

  // Calculate bundle shipping per group and build response
  const groups: Array<{
    seller_id: string;
    seller_name: string;
    seller_avatar_url: string | null;
    items: Array<{
      listing_id: string;
      title: string;
      price_amount: number;
      price_currency: string;
      cover_photo_url: string | null;
      shipping_cost_amount: number;
      free_shipping: boolean;
      shipping_status: "paid" | "free" | "bundled";
    }>;
    items_subtotal: number;
    shipping_total: number;
    shipping_before_discount: number;
    bundle_savings: number;
  }> = [];

  let totalItemsAmount = 0;
  let totalShipping = 0;
  let totalBundleSavings = 0;
  let totalItemCount = 0;

  for (const [, group] of sellerGroups) {
    const shippingCalc = calculateBundleShipping(
      group.items.map((i) => ({
        listing_id: i.listing_id,
        shipping_cost_amount: i.shipping_cost_amount,
        free_shipping: i.free_shipping,
      }))
    );

    const itemsSubtotal = group.items.reduce((sum, i) => sum + i.price_amount, 0);

    const enrichedItems = group.items.map((i) => ({
      ...i,
      shipping_status: shippingCalc.item_statuses.get(i.listing_id) || "free" as const,
    }));

    groups.push({
      seller_id: group.seller_id,
      seller_name: group.seller_name,
      seller_avatar_url: group.seller_avatar_url,
      items: enrichedItems,
      items_subtotal: itemsSubtotal,
      shipping_total: shippingCalc.shipping_total,
      shipping_before_discount: shippingCalc.shipping_before_discount,
      bundle_savings: shippingCalc.bundle_savings,
    });

    totalItemsAmount += itemsSubtotal;
    totalShipping += shippingCalc.shipping_total;
    totalBundleSavings += shippingCalc.bundle_savings;
    totalItemCount += group.items.length;
  }

  return c.json({
    groups,
    summary: {
      items_total: totalItemsAmount,
      shipping_total: totalShipping,
      bundle_savings: totalBundleSavings,
      grand_total: totalItemsAmount + totalShipping,
      item_count: totalItemCount,
    },
    removed_count: removedItems.length,
    removed_titles: removedItems.map((r) => r.title),
  });
});

/**
 * DELETE /api/cart/:listing_id
 * Remove an item from the cart.
 */
cart.delete("/:listing_id", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const listingId = c.req.param("listing_id");
  const supabase = createSupabaseAdmin();

  await supabase
    .from("cart_items")
    .delete()
    .eq("user_id", profile.id)
    .eq("listing_id", listingId);

  return c.json({ removed: true });
});

/**
 * POST /api/cart/merge
 * Merge guest cart items into authenticated user's cart.
 * Uses ON CONFLICT DO NOTHING for idempotent merge.
 */
cart.post("/merge", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = mergeCartSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_ids } = parsed.data;

  // Fetch active listings only
  const { data: activeLlstings } = await supabase
    .from("listings")
    .select("id")
    .in("id", listing_ids)
    .eq("status", "active");

  const activeIds = (activeLlstings || []).map((l) => l.id);

  if (activeIds.length === 0) {
    return c.json({ merged_count: 0 });
  }

  // Bulk insert with conflict handling
  const rows = activeIds.map((listing_id) => ({
    user_id: profile.id,
    listing_id,
  }));

  const { data: inserted } = await supabase
    .from("cart_items")
    .upsert(rows, { onConflict: "user_id,listing_id", ignoreDuplicates: true })
    .select("id");

  return c.json({ merged_count: inserted?.length ?? 0 });
});

/**
 * POST /api/cart/checkout
 * Create a single PaymentIntent for the entire cart using Separate Charges and Transfers.
 */
cart.post("/checkout", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Parse optional body for apply_credits flag
  const body = await c.req.json().catch(() => ({}));
  const applyCredits = (body as Record<string, unknown>).apply_credits !== false;

  // Fetch all cart items with listing + seller data
  const { data: cartItems, error } = await supabase
    .from("cart_items")
    .select(
      `
      listing_id,
      listings!cart_items_listing_id_fkey(
        id, title, price_amount, price_currency, status,
        shipping_cost_amount, free_shipping, seller_id,
        profiles!listings_seller_id_fkey(id, display_name, stripe_account_id, stripe_onboarding_complete)
      )
    `
    )
    .eq("user_id", profile.id);

  if (error) {
    console.error("Error fetching cart for checkout:", error);
    return c.json({ error: "Failed to fetch cart" }, 500);
  }

  if (!cartItems || cartItems.length === 0) {
    return c.json({ error: "Cart is empty" }, 400);
  }

  // Validate all listings are still active
  const unavailableItems: string[] = [];
  for (const item of cartItems) {
    const listing = item.listings as unknown as Record<string, unknown> | null;
    if (!listing || (listing.status as string) !== "active") {
      unavailableItems.push(
        listing ? (listing.title as string) : "Unknown item"
      );
    }
  }

  if (unavailableItems.length > 0) {
    return c.json(
      { error: "unavailable_items", items: unavailableItems },
      409
    );
  }

  // Early check: Stripe must be configured for checkout
  if (!process.env.STRIPE_SECRET_KEY) {
    return c.json({ error: "Payments are not configured. Please try again later." }, 503);
  }

  // Validate all sellers have completed Stripe onboarding
  const unverifiedSellers: string[] = [];
  const seenSellers = new Set<string>();
  for (const item of cartItems) {
    const listing = item.listings as unknown as Record<string, unknown>;
    const seller = listing.profiles as unknown as Record<string, unknown>;
    const sellerId = seller.id as string;
    if (seenSellers.has(sellerId)) continue;
    seenSellers.add(sellerId);

    if (!(seller.stripe_onboarding_complete as boolean) || !(seller.stripe_account_id as string)) {
      unverifiedSellers.push((seller.display_name as string) || "Unknown Seller");
    }
  }

  if (unverifiedSellers.length > 0) {
    return c.json(
      { error: "seller_not_verified", seller_names: unverifiedSellers },
      400
    );
  }

  // Build seller groups
  const sellerGroupMap = new Map<
    string,
    {
      seller_id: string;
      stripe_account_id: string;
      listing_ids: string[];
      items: Array<{
        listing_id: string;
        price_amount: number;
        shipping_cost_amount: number;
        free_shipping: boolean;
      }>;
    }
  >();

  for (const item of cartItems) {
    const listing = item.listings as unknown as Record<string, unknown>;
    const seller = listing.profiles as unknown as Record<string, unknown>;
    const sellerId = seller.id as string;

    if (!sellerGroupMap.has(sellerId)) {
      sellerGroupMap.set(sellerId, {
        seller_id: sellerId,
        stripe_account_id: seller.stripe_account_id as string,
        listing_ids: [],
        items: [],
      });
    }

    const group = sellerGroupMap.get(sellerId)!;
    group.listing_ids.push(listing.id as string);
    group.items.push({
      listing_id: listing.id as string,
      price_amount: listing.price_amount as number,
      shipping_cost_amount: (listing.shipping_cost_amount as number) || 0,
      free_shipping: (listing.free_shipping as boolean) || false,
    });
  }

  // Calculate per-seller totals with bundle shipping and commission
  const sellerGroups: Array<{
    seller_id: string;
    stripe_account_id: string;
    items_subtotal: number;
    shipping_total: number;
    commission_amount: number;
    commission_rate: number;
    seller_payout: number;
    listing_ids: string[];
  }> = [];

  let grandTotal = 0;
  const allListingIds: string[] = [];

  for (const [, group] of sellerGroupMap) {
    const shippingCalc = calculateBundleShipping(group.items);
    const itemsSubtotal = group.items.reduce((sum, i) => sum + i.price_amount, 0);

    // Commission on items only, NOT shipping
    const commissionRate = await getSellerCommissionRate(group.seller_id);
    const commissionAmount = Math.round(itemsSubtotal * (commissionRate / 100));
    const sellerPayout = itemsSubtotal - commissionAmount + shippingCalc.shipping_total;
    const groupTotal = itemsSubtotal + shippingCalc.shipping_total;

    sellerGroups.push({
      seller_id: group.seller_id,
      stripe_account_id: group.stripe_account_id,
      items_subtotal: itemsSubtotal,
      shipping_total: shippingCalc.shipping_total,
      commission_amount: commissionAmount,
      commission_rate: commissionRate,
      seller_payout: sellerPayout,
      listing_ids: group.listing_ids,
    });

    grandTotal += groupTotal;
    allListingIds.push(...group.listing_ids);
  }

  // ---- Credit application ----
  let creditApplied = 0;
  if (applyCredits) {
    const creditBalance = await getAvailableCreditBalance(profile.id);
    const totalItemsAmount = sellerGroups.reduce((s, g) => s + g.items_subtotal, 0);
    creditApplied = Math.min(creditBalance, totalItemsAmount); // Credits cover items only, NOT shipping
  }

  const chargeAmount = grandTotal - creditApplied;

  // Generate a unique cart checkout ID
  const cartCheckoutId = crypto.randomUUID();

  // Atomic inventory reservation: update all listings from 'active' to 'reserved'
  const { data: reserved, error: reserveError } = await supabase
    .from("listings")
    .update({ status: "reserved" })
    .in("id", allListingIds)
    .eq("status", "active")
    .select("id");

  if (reserveError) {
    console.error("Error reserving listings:", reserveError);
    return c.json({ error: "Failed to reserve items" }, 500);
  }

  // Check that all items were successfully reserved (race condition protection)
  if (!reserved || reserved.length !== allListingIds.length) {
    // Revert any that were reserved
    if (reserved && reserved.length > 0) {
      await supabase
        .from("listings")
        .update({ status: "active" })
        .in(
          "id",
          reserved.map((r) => r.id)
        );
    }
    return c.json(
      { error: "unavailable_items", items: ["Some items were sold while you were checking out"] },
      409
    );
  }

  // ---- Zero-charge handling: credits cover everything ----
  if (chargeAmount < 50) {
    try {
      const currency = "AUD";

      for (const group of sellerGroups) {
        const orderNumber = generateOrderNumber();
        const groupTotal = group.items_subtotal + group.shipping_total;

        const { data: order, error: orderError } = await supabase
          .from("orders")
          .insert({
            order_number: orderNumber,
            listing_id: group.listing_ids[0],
            buyer_id: profile.id,
            seller_id: group.seller_id,
            amount: groupTotal,
            currency,
            commission_rate: group.commission_rate,
            commission_amount: group.commission_amount,
            seller_payout: group.seller_payout,
            buyer_email: "",
            stripe_payment_intent_id: null,
            status: "paid" as OrderStatus,
          })
          .select()
          .single();

        if (orderError) {
          console.error(`Error creating zero-charge order for seller ${group.seller_id}:`, orderError);
          continue;
        }

        // Mark all group listings as 'sold'
        await supabase
          .from("listings")
          .update({ status: "sold" })
          .in("id", group.listing_ids);

        // Create Stripe Transfer for seller payout (shipping charges still need to be transferred)
        if (group.stripe_account_id && group.seller_payout > 0) {
          try {
            await getStripe().transfers.create({
              amount: group.seller_payout,
              currency: currency.toLowerCase(),
              destination: group.stripe_account_id,
              transfer_group: `cart_${cartCheckoutId}`,
              metadata: {
                order_number: orderNumber,
                seller_id: group.seller_id,
                zero_charge: "true",
              },
            });
          } catch (transferError) {
            console.error(`Transfer failed for zero-charge order seller ${group.seller_id}:`, transferError);
          }
        }

        // Notify seller
        if (order) {
          const paidTemplate = orderPaidNotification(
            `Order #${orderNumber}`,
            groupTotal,
            currency,
            group.seller_payout
          );
          await createNotification({
            user_id: group.seller_id,
            type: "order_paid",
            ...paidTemplate,
            data: { order_id: order.id },
          });
        }
      }

      // Clear buyer's cart
      await supabase.from("cart_items").delete().eq("user_id", profile.id);

      // Redeem credits
      if (creditApplied > 0) {
        await redeemCredits(profile.id, creditApplied);
      }

      return c.json({
        checkout_id: cartCheckoutId,
        grand_total: grandTotal,
        credit_applied: creditApplied,
        orders_created: true,
      });
    } catch (zeroChargeError) {
      // Revert reservations on failure
      await supabase
        .from("listings")
        .update({ status: "active" })
        .in("id", allListingIds);

      console.error("Error in zero-charge checkout:", zeroChargeError);
      return c.json({ error: "Failed to complete checkout" }, 500);
    }
  }

  // ---- Normal charge: create PaymentIntent with reduced amount ----
  try {
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: chargeAmount,
      currency: "aud",
      transfer_group: `cart_${cartCheckoutId}`,
      metadata: {
        checkout_type: "cart",
        cart_checkout_id: cartCheckoutId,
        buyer_profile_id: profile.id,
        buyer_email: "",
        credit_applied: creditApplied.toString(),
        seller_groups: JSON.stringify(
          sellerGroups.map((g) => ({
            seller_id: g.seller_id,
            stripe_account_id: g.stripe_account_id,
            items_subtotal: g.items_subtotal,
            shipping_total: g.shipping_total,
            commission_amount: g.commission_amount,
            commission_rate: g.commission_rate,
            seller_payout: g.seller_payout,
            listing_ids: g.listing_ids,
          }))
        ),
      },
    });

    return c.json({
      clientSecret: paymentIntent.client_secret,
      checkout_id: cartCheckoutId,
      grand_total: grandTotal,
      credit_applied: creditApplied,
    });
  } catch (stripeError) {
    // Revert reservations on Stripe failure
    await supabase
      .from("listings")
      .update({ status: "active" })
      .in("id", allListingIds);

    console.error("Error creating cart PaymentIntent:", stripeError);
    return c.json({ error: "Failed to create payment" }, 500);
  }
});

export default cart;
