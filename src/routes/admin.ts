import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { adminAuthMiddleware, requireAdminPermission } from "../middleware/adminAuth.js";
import { ADMIN_PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type AdminRole } from "../lib/adminRoles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  LISTING_STATUSES,
  OCCASION_TAGS,
  CURATION_TAGS,
} from "../types/listings.js";
import {
  createNotification,
  listingApprovedNotification,
  listingRejectedNotification,
  tierUpgradeNotification,
  tierDowngradeNotification,
  followedSellerNewListingNotification,
  orderDeliveredNotification,
  orderRejectedNotification,
} from "../lib/notifications.js";
import {
  getDashboardMetrics,
  approveListing as approveListingService,
  rejectListing as rejectListingService,
  AdminServiceError,
} from "../services/adminService.js";
import { calculateTrustTier, computeCategoryMedians } from "../lib/trust-tiers.js";
import {
  TIER_LABELS,
  DEFAULT_TIER_THRESHOLDS,
  DEFAULT_TIER_COMMISSION_RATES,
  type TrustTier,
  type TierThreshold,
} from "../types/trust.js";
import { NOTIFICATION_TYPES } from "../types/transactions.js";
import {
  resolveSellerPayoutMethod,
  refundOrderPayment,
  cancelPayoutForOrder,
  releasePayoutForOrder,
} from "../services/payoutService.js";
import { auditFromContext } from "../lib/audit.js";
import { hasDirectDb, getSql } from "../lib/db.js";

const admin = new Hono();

// ============================================================
// Public Auth Route (no middleware)
// ============================================================

admin.post("/auth/login", async (c) => {
  const bodySchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid email or password" }, 400);
  }

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error || !data.session) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (adminEmails.length > 0 && !adminEmails.includes(data.user.email?.toLowerCase() || "")) {
    return c.json({ error: "Forbidden: admin access required" }, 403);
  }

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
  });
});

admin.post("/auth/refresh", async (c) => {
  const bodySchema = z.object({ refresh_token: z.string().min(1) });
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "refresh_token required" }, 400);
  }

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: parsed.data.refresh_token,
  });

  if (error || !data.session) {
    return c.json({ error: "Invalid refresh token" }, 401);
  }

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  });
});

// ============================================================
// Protected routes (require admin auth)
// ============================================================

admin.use("/listings", adminAuthMiddleware);
admin.use("/listings/*", adminAuthMiddleware);
admin.use("/users", adminAuthMiddleware);
admin.use("/users/*", adminAuthMiddleware);
admin.use("/dashboard", adminAuthMiddleware);
admin.use("/dashboard/*", adminAuthMiddleware);
admin.use("/settings", adminAuthMiddleware);
admin.use("/settings/*", adminAuthMiddleware);
admin.use("/referrals", adminAuthMiddleware);
admin.use("/referrals/*", adminAuthMiddleware);
admin.use("/analytics/*", adminAuthMiddleware);
admin.use("/moderation/*", adminAuthMiddleware);
admin.use("/config/*", adminAuthMiddleware);
admin.use("/payouts", adminAuthMiddleware);
admin.use("/payouts/*", adminAuthMiddleware);
admin.use("/notification-toggles", adminAuthMiddleware);
admin.use("/notification-toggles/*", adminAuthMiddleware);
admin.use("/sellers/*", adminAuthMiddleware);
admin.use("/audit-log", adminAuthMiddleware);
admin.use("/audit-log/*", adminAuthMiddleware);
admin.use("/transactions", adminAuthMiddleware);
admin.use("/transactions/*", adminAuthMiddleware);
admin.use("/offers", adminAuthMiddleware);
admin.use("/offers/*", adminAuthMiddleware);
admin.use("/team", adminAuthMiddleware);
admin.use("/team/*", adminAuthMiddleware);
admin.use("/reviews", adminAuthMiddleware);
admin.use("/reviews/*", adminAuthMiddleware);
admin.use("/export/*", adminAuthMiddleware);
admin.use("/content", adminAuthMiddleware);
admin.use("/content/*", adminAuthMiddleware);

// ============================================================
// Helpers
// ============================================================

function parseRange(range: string | undefined): Date | null {
  const r = range || "30d";
  if (r === "all") return null;
  const match = r.match(/^(\d+)d$/);
  if (!match) return null;
  const days = parseInt(match[1], 10);
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

/**
 * Fire-and-forget email notification for listing review.
 * Looks up seller email from Clerk (still used for mobile users), then POSTs to email-hooks.
 */
async function sendListingReviewEmail(params: {
  sellerClerkId: string;
  sellerName: string;
  listingTitle: string;
  listingPhotoUrl: string;
  listingId: string;
  approved: boolean;
  rejectionReason?: string;
}): Promise<void> {
  try {
    // Look up seller email via Clerk (mobile users still use Clerk)
    let sellerEmail: string | null = null;
    try {
      const { createClerkClient } = await import("@clerk/backend");
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY || "",
      });
      const user = await clerk.users.getUser(params.sellerClerkId);
      sellerEmail = user.emailAddresses[0]?.emailAddress || null;
    } catch {
      console.warn("[admin] Could not look up seller email via Clerk");
    }

    if (!sellerEmail) return;

    const baseUrl =
      process.env.API_URL ||
      process.env.BACKEND_URL ||
      `http://localhost:${process.env.PORT || "3001"}`;

    await fetch(`${baseUrl}/api/email-hooks/listing-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      },
      body: JSON.stringify({
        seller_email: sellerEmail,
        seller_name: params.sellerName,
        listing_title: params.listingTitle,
        listing_photo_url: params.listingPhotoUrl || undefined,
        listing_id: params.listingId,
        approved: params.approved,
        rejection_reason: params.rejectionReason,
      }),
    });
  } catch (err) {
    console.error("[admin] Failed to send listing review email:", err);
  }
}

// ============================================================
// All Listings (browse, filter, search)
// ============================================================

admin.get("/listings/all", async (c) => {
  const supabase = createSupabaseAdmin();

  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const category = c.req.query("category") || "";
  const sort = c.req.query("sort") || "created_at";
  const order = c.req.query("order") || "desc";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const offset = (page - 1) * limit;

  const allowedSortCols = ["created_at", "price_amount", "title", "category"];
  const sortCol = allowedSortCols.includes(sort) ? sort : "created_at";
  const ascending = order === "asc";

  let query = supabase
    .from("listings")
    .select(
      "*, listing_photos(*), profiles!listings_seller_id_fkey(display_name, avatar_url, location)",
      { count: "exact" }
    )
    .order(sortCol, { ascending })
    .range(offset, offset + limit - 1);

  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  if (search) {
    query = query.ilike("title", `%${search}%`);
  }

  if (category) {
    query = query.eq("category", category);
  }

  const { data: listings, error, count } = await query;

  if (error) {
    console.error("Error fetching all listings:", error);
    return c.json({ error: "Failed to fetch listings" }, 500);
  }

  const result = (listings || []).map((listing) => ({
    ...listing,
    photos: (listing.listing_photos || []).sort(
      (a: { position: number }, b: { position: number }) => a.position - b.position
    ),
    seller: listing.profiles || null,
    listing_photos: undefined,
    profiles: undefined,
  }));

  return c.json({ listings: result, total: count || 0, page, limit });
});

// ============================================================
// Listing Review Queue
// ============================================================

admin.get("/listings/pending", async (c) => {
  const supabase = createSupabaseAdmin();
  const sort = c.req.query("sort") || "oldest_first";

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const page = Math.max(parseInt(pageParam || "1", 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    100
  );
  const offset = (page - 1) * limit;

  let orderCol = "created_at";
  let ascending = true;

  if (sort === "newest_first") {
    ascending = false;
  } else if (sort === "by_category") {
    orderCol = "category";
    ascending = true;
  }

  const { data: listings, error, count } = await supabase
    .from("listings")
    .select(
      "*, listing_photos(*), profiles!listings_seller_id_fkey(" +
        "display_name, avatar_url, location, payout_method, " +
        "stripe_account_id, stripe_onboarding_complete, " +
        "wise_account_holder, wise_bank_country, wise_bank_currency, " +
        "wise_routing_code, wise_account_number, wise_account_type, paypal_email)",
      { count: "exact" }
    )
    .eq("status", "pending_review")
    .order(orderCol, { ascending })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error fetching pending listings:", error);
    return c.json({ error: "Failed to fetch pending listings" }, 500);
  }

  const result = ((listings || []) as unknown as Array<Record<string, unknown>>).map((listing) => {
    const sellerRaw = (listing.profiles as Record<string, unknown> | null) || null;
    // Resolve which method the seller can actually be paid with, so the admin
    // UI can display "Stripe / Wise / PayPal / Not connected" without
    // re-implementing the precedence rules. null = nothing configured.
    const resolved = sellerRaw
      ? resolveSellerPayoutMethod({
          payout_method: (sellerRaw.payout_method as string | null) ?? null,
          stripe_account_id: (sellerRaw.stripe_account_id as string | null) ?? null,
          stripe_onboarding_complete:
            (sellerRaw.stripe_onboarding_complete as boolean | null) ?? null,
          wise_account_holder: (sellerRaw.wise_account_holder as string | null) ?? null,
          wise_bank_country: (sellerRaw.wise_bank_country as string | null) ?? null,
          wise_bank_currency: (sellerRaw.wise_bank_currency as string | null) ?? null,
          wise_routing_code: (sellerRaw.wise_routing_code as string | null) ?? null,
          wise_account_number: (sellerRaw.wise_account_number as string | null) ?? null,
          paypal_email: (sellerRaw.paypal_email as string | null) ?? null,
        })
      : null;
    // Distinguish the seller's CHOSEN method from what's payable right now.
    //   payout_method_resolved — payable-now method (falls back off an
    //     incomplete Stripe to Wise/PayPal); use for the manual-payout flow.
    //   payout_method_chosen   — what the seller actually selected.
    //   stripe_status          — not_connected | incomplete | complete.
    // The admin UI should show the CHOSEN method + stripe_status badge so an
    // incomplete-Stripe seller reads as "Stripe · onboarding incomplete", not
    // silently as "PayPal".
    const stripeStatus = sellerRaw
      ? !sellerRaw.stripe_account_id
        ? "not_connected"
        : sellerRaw.stripe_onboarding_complete
        ? "complete"
        : "incomplete"
      : "not_connected";
    const seller = sellerRaw
      ? {
          ...sellerRaw,
          payout_method_resolved: resolved,
          payout_method_chosen: (sellerRaw.payout_method as string | null) ?? null,
          stripe_status: stripeStatus,
        }
      : null;
    const photos = (listing.listing_photos as Array<{ position: number }> | null) || [];
    return {
      ...listing,
      photos: photos.sort((a, b) => a.position - b.position),
      seller,
      listing_photos: undefined,
      profiles: undefined,
    };
  });

  return c.json({
    items: result,
    listings: result,
    total: count || 0,
    page,
    limit,
  });
});

admin.post("/listings/:id/approve", async (c) => {
  const listingId = c.req.param("id");

  let result;
  try {
    result = await approveListingService(listingId);
  } catch (err) {
    if (err instanceof AdminServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    }
    console.error("Unexpected error approving listing:", err);
    return c.json({ error: "Failed to approve listing" }, 500);
  }

  // Send "listing approved" email via Resend. The service already
  // emitted `listing:approved` for notification dispatch.
  if (result.sellerClerkId) {
    sendListingReviewEmail({
      sellerClerkId: result.sellerClerkId,
      sellerName: result.sellerName || "Seller",
      listingTitle: (result.listing as Record<string, unknown>).title as string,
      listingPhotoUrl: result.coverPhotoUrl || "",
      listingId,
      approved: true,
    }).catch((err) => console.error("[admin] Email error:", err));
  }

  // Notify followers of this seller about the new listing.
  const listingRow = result.listing as Record<string, unknown>;
  const sellerId = listingRow.seller_id as string | undefined;
  if (sellerId) {
    (async () => {
      try {
        const supabase = createSupabaseAdmin();
        const { data: followers } = await supabase
          .from("seller_follows")
          .select("follower_id")
          .eq("seller_id", sellerId);

        if (followers && followers.length > 0) {
          const sellerName = result.sellerName || "A seller you follow";
          const template = followedSellerNewListingNotification(
            sellerName,
            listingRow.title as string
          );
          for (const f of followers) {
            createNotification({
              user_id: f.follower_id,
              type: "followed_seller_new_listing",
              title: template.title,
              body: template.body,
              // Followers receive this as buyers — discovery surface.
              data: { listing_id: listingId, seller_id: sellerId, role: "buyer" },
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error("[admin] Follower notification error:", err);
      }
    })();
  }

  void auditFromContext(c, {
    action: "listing.approve",
    targetType: "listing",
    targetId: listingId,
    metadata: { title: listingRow.title ?? null, seller_id: sellerId ?? null },
  });

  return c.json({ listing: result.listing });
});

admin.post("/listings/:id/reject", async (c) => {
  const listingId = c.req.param("id");

  const bodySchema = z.object({
    reason: z.string().min(1, "Rejection reason is required"),
  });
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { reason } = parsed.data;

  let result;
  try {
    result = await rejectListingService(listingId, reason);
  } catch (err) {
    if (err instanceof AdminServiceError) {
      return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    }
    console.error("Unexpected error rejecting listing:", err);
    return c.json({ error: "Failed to reject listing" }, 500);
  }

  if (result.sellerClerkId) {
    sendListingReviewEmail({
      sellerClerkId: result.sellerClerkId,
      sellerName: result.sellerName || "Seller",
      listingTitle: (result.listing as Record<string, unknown>).title as string,
      listingPhotoUrl: result.coverPhotoUrl || "",
      listingId,
      approved: false,
      rejectionReason: reason,
    }).catch((err) => console.error("[admin] Email error:", err));
  }

  void auditFromContext(c, {
    action: "listing.reject",
    targetType: "listing",
    targetId: listingId,
    reason,
    metadata: { title: (result.listing as Record<string, unknown>).title ?? null },
  });

  return c.json({ listing: result.listing });
});

admin.post("/listings/batch", async (c) => {
  const supabase = createSupabaseAdmin();

  const batchSchema = z.object({
    listing_ids: z.array(z.string().uuid()).min(1),
    action: z.enum(["approve", "reject"]),
    reason: z.string().optional(),
  }).refine(
    (data) => data.action !== "reject" || (data.reason && data.reason.length > 0),
    { message: "Reason is required when rejecting", path: ["reason"] }
  );

  const body = await c.req.json();
  const parsed = batchSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { listing_ids, action, reason } = parsed.data;
  const results: Array<{ id: string; success: boolean; error?: string }> = [];

  for (const id of listing_ids) {
    try {
      // PostgREST collapses big embedded selects to a bag-of-strings type,
      // so we narrow manually after the .single() call.
      type ListingRow = {
        status: string;
        title: string;
        profiles: {
          id: string;
          clerk_id: string;
          display_name: string;
          avatar_url: string;
          payout_method: string | null;
          stripe_account_id: string | null;
          stripe_onboarding_complete: boolean | null;
          wise_account_holder: string | null;
          wise_bank_country: string | null;
          wise_bank_currency: string | null;
          wise_routing_code: string | null;
          wise_account_number: string | null;
          paypal_email: string | null;
        } | null;
      };
      const { data: listingRaw, error: fetchError } = await supabase
        .from("listings")
        .select(
          "*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url, " +
            "payout_method, stripe_account_id, stripe_onboarding_complete, " +
            "wise_account_holder, wise_bank_country, wise_bank_currency, " +
            "wise_routing_code, wise_account_number, paypal_email)"
        )
        .eq("id", id)
        .single();

      if (fetchError || !listingRaw) {
        results.push({ id, success: false, error: "Listing not found" });
        continue;
      }
      const listing = listingRaw as unknown as ListingRow;

      if (listing.status !== "pending_review") {
        results.push({ id, success: false, error: `Status is '${listing.status}', not pending_review` });
        continue;
      }

      const seller = listing.profiles;
      // Approval is a CONTENT decision. Payout readiness is NOT gated here —
      // the admin sees the seller's payout status (payout_method_chosen /
      // stripe_status) and decides. If the seller's chosen payout isn't ready
      // the listing still can't be PURCHASED (checkout enforces that via
      // resolveSellerPayoutMethod), so no money is ever taken for a payee we
      // can't pay. This matches "publish/approve freely, gate at purchase".
      const updatePayload: Record<string, unknown> =
        action === "approve"
          ? { status: "active", rejection_reason: null }
          : { status: "draft", rejection_reason: reason };

      const { error: updateError } = await supabase
        .from("listings")
        .update(updatePayload)
        .eq("id", id);

      if (updateError) {
        results.push({ id, success: false, error: "Update failed" });
        continue;
      }

      results.push({ id, success: true });

      if (seller) {
        const template =
          action === "approve"
            ? listingApprovedNotification(listing.title)
            : listingRejectedNotification(listing.title, reason);

        createNotification({
          user_id: seller.id,
          type: action === "approve" ? "listing_approved" : "listing_rejected",
          title: template.title,
          body: template.body,
          data: { listing_id: id, role: "seller" },
        }).catch((err) => console.error("[admin] Batch notification error:", err));

        const { data: coverPhoto } = await supabase
          .from("listing_photos")
          .select("url")
          .eq("listing_id", id)
          .order("position", { ascending: true })
          .limit(1)
          .single();

        sendListingReviewEmail({
          sellerClerkId: seller.clerk_id,
          sellerName: seller.display_name || "Seller",
          listingTitle: listing.title,
          listingPhotoUrl: coverPhoto?.url || "",
          listingId: id,
          approved: action === "approve",
          rejectionReason: reason,
        }).catch((err) => console.error("[admin] Batch email error:", err));

        if (action === "approve") {
          // Notify followers
          Promise.resolve(
            supabase
              .from("seller_follows")
              .select("follower_id")
              .eq("seller_id", seller.id)
          )
            .then(({ data: followers }) => {
              if (followers && followers.length > 0) {
                const tmpl = followedSellerNewListingNotification(
                  seller.display_name || "A seller you follow",
                  listing.title
                );
                for (const f of followers) {
                  createNotification({
                    user_id: f.follower_id,
                    type: "followed_seller_new_listing",
                    title: tmpl.title,
                    body: tmpl.body,
                    data: { listing_id: id, seller_id: seller.id, role: "buyer" },
                  }).catch(() => {});
                }
              }
            })
            .catch(() => {});
        }
      }
    } catch {
      results.push({ id, success: false, error: "Unexpected error" });
    }
  }

  void auditFromContext(c, {
    action: action === "approve" ? "listing.approve" : "listing.reject",
    targetType: "listing",
    targetId: null,
    reason: reason ?? null,
    metadata: {
      batch: true,
      requested: listing_ids.length,
      succeeded: results.filter((r) => r.success).map((r) => r.id),
      failed: results.filter((r) => !r.success).map((r) => r.id),
    },
  });

  return c.json({ results });
});

// ============================================================
// Admin Create Listing (direct to active, skips review)
// ============================================================

const adminCreateListingSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
    })
    .optional(),
  occasion_tags: z.array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]])).optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().positive(),
  price_currency: z.enum(["AUD", "USD", "NZD"]).optional(),
  original_price_amount: z.number().int().positive().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).optional(),
});

admin.post("/listings", async (c) => {
  const supabase = createSupabaseAdmin();
  const adminProfileId = c.get("adminProfileId");

  const body = await c.req.json();
  const parsed = adminCreateListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: listing, error } = await supabase
    .from("listings")
    .insert({
      seller_id: adminProfileId,
      title: parsed.data.title,
      description: parsed.data.description || null,
      category: parsed.data.category,
      condition: parsed.data.condition,
      measurements: parsed.data.measurements || {},
      occasion_tags: parsed.data.occasion_tags || [],
      colors: parsed.data.colors || [],
      price_amount: parsed.data.price_amount,
      price_currency: parsed.data.price_currency || "AUD",
      original_price_amount: parsed.data.original_price_amount || null,
      negotiable: parsed.data.negotiable ?? false,
      shipping_info: parsed.data.shipping_info || null,
      status: "active",
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating admin listing:", error);
    return c.json({ error: "Failed to create listing" }, 500);
  }

  void auditFromContext(c, {
    action: "listing.create",
    targetType: "listing",
    targetId: (listing as Record<string, unknown>).id as string,
    metadata: { title: parsed.data.title, on_behalf_seller: adminProfileId },
  });

  return c.json({ listing }, 201);
});

admin.post("/listings/:id/photos", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: listing } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (!listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const formData = await c.req.formData();
  const file = formData.get("photo") as File | null;

  if (!file) {
    return c.json({ error: "No photo provided" }, 400);
  }

  const { count } = await supabase
    .from("listing_photos")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId);

  if (count && count >= 15) {
    return c.json({ error: "Maximum 15 photos per listing" }, 400);
  }

  const position = count || 0;
  const ext = file.name.split(".").pop() || "jpg";
  const storagePath = `listings/${listingId}/${Date.now()}_${position}.${ext}`;

  const buffer = await file.arrayBuffer();

  const { error: uploadError } = await supabase.storage
    .from("listing-photos")
    .upload(storagePath, buffer, {
      contentType: file.type || "image/jpeg",
      upsert: false,
    });

  if (uploadError) {
    console.error("Photo upload error:", uploadError);
    return c.json({ error: "Failed to upload photo" }, 500);
  }

  const { data: urlData } = supabase.storage.from("listing-photos").getPublicUrl(storagePath);

  const { data: photo, error: dbError } = await supabase
    .from("listing_photos")
    .insert({
      listing_id: listingId,
      storage_path: storagePath,
      url: urlData.publicUrl,
      position,
    })
    .select()
    .single();

  if (dbError) {
    console.error("Photo DB insert error:", dbError);
    return c.json({ error: "Failed to save photo record" }, 500);
  }

  return c.json({ photo }, 201);
});

// ============================================================
// Admin Listing CRUD (get single, update, status change, delete)
// ============================================================

admin.get("/listings/:id", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: listing, error } = await supabase
    .from("listings")
    .select(
      "*, listing_photos(*), profiles!listings_seller_id_fkey(id, display_name, avatar_url, location, stripe_onboarding_complete)"
    )
    .eq("id", listingId)
    .single();

  if (error || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const result = {
    ...listing,
    photos: (listing.listing_photos || []).sort(
      (a: { position: number }, b: { position: number }) => a.position - b.position
    ),
    seller: listing.profiles || null,
    listing_photos: undefined,
    profiles: undefined,
  };

  // Phase 4 enrichment (Screen 04): every offer + transaction raised against
  // this listing, and its public comments. Additive to the response.
  const [offers, orders, comments] = await Promise.all([
    supabase
      .from("offers")
      .select("id, amount, currency, status, round, offered_by, created_at, buyer_id")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false }),
    supabase
      .from("orders")
      .select("id, order_number, amount, currency, status, buyer_id, created_at")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false }),
    supabase
      .from("listing_comments")
      .select("*")
      .eq("listing_id", listingId)
      .order("created_at", { ascending: false }),
  ]);

  return c.json({
    listing: result,
    offers: offers.data ?? [],
    transactions: orders.data ?? [],
    comments: comments.data ?? [],
  });
});

const adminUpdateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]).optional(),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]).optional(),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
    })
    .nullable()
    .optional(),
  occasion_tags: z.array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]])).optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().positive().optional(),
  price_currency: z.enum(["AUD", "USD", "NZD"]).optional(),
  original_price_amount: z.number().int().positive().nullable().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).nullable().optional(),
  // Admin-curated chip tags (Bridal Edit / Designer Edit / Top Picks /
  // Popular Brands) that drive the buyer-facing curation filter. Strict
  // enum so a typo can never silently leak into the buyer UI.
  curation_tags: z
    .array(z.enum(CURATION_TAGS as unknown as [string, ...string[]]))
    .optional(),
  // Optional edit reason (Screen 05). Kept optional so curation-tag saves
  // (which reuse this endpoint) don't break; recorded in the audit + diff
  // when provided.
  reason: z.string().max(1000).optional(),
});

// Shared handler so PUT and PATCH on the same path do the same thing.
// PATCH is the semantically correct verb for partial updates (which is
// what this is — every field is optional); admin FE was sending PATCH
// and getting 404 because we only had PUT registered.
const adminUpdateListingHandler = async (c: import("hono").Context) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = adminUpdateListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Fetch the full current row so we can persist a before/after diff.
  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }
  const before = existing as Record<string, unknown>;

  const updateData: Record<string, unknown> = {};
  const input = parsed.data;
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.category !== undefined) updateData.category = input.category;
  if (input.condition !== undefined) updateData.condition = input.condition;
  if (input.measurements !== undefined) updateData.measurements = input.measurements;
  if (input.occasion_tags !== undefined) updateData.occasion_tags = input.occasion_tags;
  if (input.colors !== undefined) updateData.colors = input.colors;
  if (input.price_amount !== undefined) updateData.price_amount = input.price_amount;
  if (input.price_currency !== undefined) updateData.price_currency = input.price_currency;
  if (input.original_price_amount !== undefined) updateData.original_price_amount = input.original_price_amount;
  if (input.negotiable !== undefined) updateData.negotiable = input.negotiable;
  if (input.shipping_info !== undefined) updateData.shipping_info = input.shipping_info;
  if (input.curation_tags !== undefined) updateData.curation_tags = input.curation_tags;

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  // Before/after field diff (Screen 05) for the audit trail.
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(updateData)) {
    diff[k] = { before: before[k] ?? null, after: updateData[k] };
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updateData)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing:", updateError);
    return c.json({ error: "Failed to update listing" }, 500);
  }

  void auditFromContext(c, {
    action: "listing.edit",
    targetType: "listing",
    targetId: listingId,
    reason: input.reason ?? null,
    metadata: { fields: Object.keys(updateData), diff },
  });

  // Notify the seller when a content field (not just curation) changed
  // (Screen 05: the reason is sent to them). Needs schema-34.
  const contentChanged = Object.keys(updateData).some((k) => k !== "curation_tags");
  if (contentChanged && before.seller_id) {
    createNotification({
      user_id: before.seller_id as string,
      type: "listing_updated",
      title: "Your listing was updated",
      body: `An admin updated "${(updated as Record<string, unknown>).title}".${input.reason ? ` Reason: ${input.reason}` : ""}`,
      data: { listing_id: listingId, role: "seller" },
    }).catch(() => {});
  }

  return c.json({ listing: updated });
};

admin.put("/listings/:id", adminUpdateListingHandler);
admin.patch("/listings/:id", adminUpdateListingHandler);

admin.patch("/listings/:id/status", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const statusSchema = z.object({
    status: z.enum(LISTING_STATUSES as unknown as [string, ...string[]]),
  });

  const body = await c.req.json();
  const parsed = statusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Invalid status", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("id, status")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.status === parsed.data.status) {
    return c.json({ error: `Listing is already '${parsed.data.status}'` }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update({ status: parsed.data.status, rejection_reason: null })
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing status:", updateError);
    return c.json({ error: "Failed to update listing status" }, 500);
  }

  void auditFromContext(c, {
    action: "listing.status_change",
    targetType: "listing",
    targetId: listingId,
    metadata: { from: existing.status, to: parsed.data.status },
  });

  return c.json({ listing: updated });
});

admin.delete("/listings/:id", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  const { data: photos } = await supabase
    .from("listing_photos")
    .select("storage_path")
    .eq("listing_id", listingId);

  if (photos && photos.length > 0) {
    const paths = photos.map((p) => p.storage_path);
    await supabase.storage.from("listing-photos").remove(paths);
  }

  await supabase.from("listing_photos").delete().eq("listing_id", listingId);

  const { error: deleteError } = await supabase
    .from("listings")
    .delete()
    .eq("id", listingId);

  if (deleteError) {
    console.error("Error deleting listing:", deleteError);
    return c.json({ error: "Failed to delete listing" }, 500);
  }

  void auditFromContext(c, {
    action: "listing.delete",
    targetType: "listing",
    targetId: listingId,
    metadata: { photos_removed: photos?.length ?? 0 },
  });

  return c.json({ success: true });
});

// ============================================================
// User Management
// ============================================================

admin.get("/users", async (c) => {
  const supabase = createSupabaseAdmin();
  const search = c.req.query("search") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const offset = (page - 1) * limit;

  let query = supabase
    .from("profiles")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.ilike("display_name", `%${search}%`);
  }

  const { data: profiles, error, count } = await query;

  if (error) {
    console.error("Error fetching users:", error);
    return c.json({ error: "Failed to fetch users" }, 500);
  }

  const userIds = (profiles || []).map((p) => p.id as string);

  // Batched queries: avoid N+1 by fetching all listings and orders for the
  // current page in two calls and grouping in JS.
  const listingCountMap = new Map<string, number>();
  const orderCountMap = new Map<string, number>();
  const orderTotalMap = new Map<string, number>();

  if (userIds.length > 0) {
    const [allListings, allOrders] = await Promise.all([
      supabase
        .from("listings")
        .select("seller_id")
        .in("seller_id", userIds),
      supabase
        .from("orders")
        .select("seller_id, amount")
        .in("seller_id", userIds),
    ]);

    for (const row of allListings.data || []) {
      const sid = row.seller_id as string;
      listingCountMap.set(sid, (listingCountMap.get(sid) || 0) + 1);
    }

    for (const row of allOrders.data || []) {
      const sid = row.seller_id as string;
      const amt = (row.amount as number) || 0;
      orderCountMap.set(sid, (orderCountMap.get(sid) || 0) + 1);
      orderTotalMap.set(sid, (orderTotalMap.get(sid) || 0) + amt);
    }
  }

  const users = (profiles || []).map((profile) => ({
    ...profile,
    listing_count: listingCountMap.get(profile.id as string) || 0,
    order_count: orderCountMap.get(profile.id as string) || 0,
    total_sales_amount: orderTotalMap.get(profile.id as string) || 0,
  }));

  return c.json({ items: users, users, total: count || 0, page, limit });
});

admin.post("/users/:id/suspend", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const bodySchema = z.object({
    reason: z.string().min(1, "Suspension reason is required"),
  });
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: user, error } = await supabase
    .from("profiles")
    .update({
      suspended_at: new Date().toISOString(),
      suspension_reason: parsed.data.reason,
    })
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    console.error("Error suspending user:", error);
    return c.json({ error: "Failed to suspend user" }, 500);
  }

  void auditFromContext(c, {
    action: "user.suspend",
    targetType: "user",
    targetId: userId,
    reason: parsed.data.reason,
  });

  return c.json({ user });
});

admin.post("/users/:id/unsuspend", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: user, error } = await supabase
    .from("profiles")
    .update({
      suspended_at: null,
      suspension_reason: null,
    })
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    console.error("Error unsuspending user:", error);
    return c.json({ error: "Failed to unsuspend user" }, 500);
  }

  void auditFromContext(c, {
    action: "user.unsuspend",
    targetType: "user",
    targetId: userId,
  });

  return c.json({ user });
});

admin.post("/users/:id/ban", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const bodySchema = z.object({
    reason: z.string().min(1, "Ban reason is required"),
  });
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: user, error } = await supabase
    .from("profiles")
    .update({
      banned_at: new Date().toISOString(),
      ban_reason: parsed.data.reason,
    })
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    console.error("Error banning user:", error);
    return c.json({ error: "Failed to ban user" }, 500);
  }

  await supabase
    .from("listings")
    .update({ status: "deactivated" })
    .eq("seller_id", userId)
    .eq("status", "active");

  void auditFromContext(c, {
    action: "user.ban",
    targetType: "user",
    targetId: userId,
    reason: parsed.data.reason,
    metadata: { deactivated_active_listings: true },
  });

  return c.json({ user });
});

admin.post("/users/:id/unban", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: user, error } = await supabase
    .from("profiles")
    .update({
      banned_at: null,
      ban_reason: null,
    })
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    console.error("Error unbanning user:", error);
    return c.json({ error: "Failed to unban user" }, 500);
  }

  void auditFromContext(c, {
    action: "user.unban",
    targetType: "user",
    targetId: userId,
  });

  return c.json({ user });
});

// ============================================================
// Dashboard Analytics
// ============================================================

admin.get("/dashboard", async (c) => {
  const rangeDate = parseRange(c.req.query("range"));
  const metrics = await getDashboardMetrics(rangeDate);
  return c.json({ metrics });
});

admin.get("/dashboard/timeseries", async (c) => {
  const supabase = createSupabaseAdmin();
  const range = c.req.query("range") || "30d";
  const rangeDate = parseRange(range);

  const startDate = rangeDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  const [ordersResult, listingsResult, usersResult] = await Promise.all([
    supabase.from("orders").select("amount, created_at").gte("created_at", startDate.toISOString()),
    supabase.from("listings").select("created_at").gte("created_at", startDate.toISOString()),
    supabase.from("profiles").select("created_at").gte("created_at", startDate.toISOString()),
  ]);

  const orders = ordersResult.data || [];
  const listings = listingsResult.data || [];
  const users = usersResult.data || [];

  const gmvByDate: Record<string, number> = {};
  const listingsByDate: Record<string, number> = {};
  const usersByDate: Record<string, number> = {};

  for (const order of orders) {
    const date = order.created_at.split("T")[0];
    gmvByDate[date] = (gmvByDate[date] || 0) + (order.amount || 0);
  }
  for (const listing of listings) {
    const date = listing.created_at.split("T")[0];
    listingsByDate[date] = (listingsByDate[date] || 0) + 1;
  }
  for (const user of users) {
    const date = user.created_at.split("T")[0];
    usersByDate[date] = (usersByDate[date] || 0) + 1;
  }

  const series = dates.map((date) => ({
    date,
    gmv: gmvByDate[date] || 0,
    new_listings: listingsByDate[date] || 0,
    new_users: usersByDate[date] || 0,
  }));

  return c.json({ series });
});

admin.get("/dashboard/export", async (c) => {
  const supabase = createSupabaseAdmin();
  const range = c.req.query("range") || "30d";
  const rangeDate = parseRange(range);

  const startDate = rangeDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  const [ordersResult, listingsResult, usersResult] = await Promise.all([
    supabase.from("orders").select("amount, commission_amount, created_at").gte("created_at", startDate.toISOString()),
    supabase.from("listings").select("created_at").gte("created_at", startDate.toISOString()),
    supabase.from("profiles").select("created_at").gte("created_at", startDate.toISOString()),
  ]);

  const orders = ordersResult.data || [];
  const listings = listingsResult.data || [];
  const users = usersResult.data || [];

  const gmvByDate: Record<string, number> = {};
  const revenueByDate: Record<string, number> = {};
  const ordersByDate: Record<string, number> = {};
  const listingsByDate: Record<string, number> = {};
  const usersByDate: Record<string, number> = {};

  for (const order of orders) {
    const date = order.created_at.split("T")[0];
    gmvByDate[date] = (gmvByDate[date] || 0) + (order.amount || 0);
    revenueByDate[date] = (revenueByDate[date] || 0) + (order.commission_amount || 0);
    ordersByDate[date] = (ordersByDate[date] || 0) + 1;
  }
  for (const listing of listings) {
    const date = listing.created_at.split("T")[0];
    listingsByDate[date] = (listingsByDate[date] || 0) + 1;
  }
  for (const user of users) {
    const date = user.created_at.split("T")[0];
    usersByDate[date] = (usersByDate[date] || 0) + 1;
  }

  const csvRows = ["Date,GMV,Platform Revenue,New Listings,New Users,New Orders"];
  for (const date of dates) {
    csvRows.push(
      `${date},${gmvByDate[date] || 0},${revenueByDate[date] || 0},${listingsByDate[date] || 0},${usersByDate[date] || 0},${ordersByDate[date] || 0}`
    );
  }

  const csv = csvRows.join("\n");
  const filename = `kifaayat-dashboard-${range}-${new Date().toISOString().split("T")[0]}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});

// ============================================================
// Admin Settings (Commission)
// ============================================================

admin.get("/settings", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("admin_settings")
    .select("commission_rate, tier_thresholds, tier_commission_rates")
    .limit(1)
    .single();

  if (error) {
    console.error("Error fetching admin settings:", error);
    return c.json({ error: "Failed to fetch settings" }, 500);
  }

  return c.json({
    settings: {
      commission_rate: data.commission_rate,
      tier_thresholds: data.tier_thresholds || DEFAULT_TIER_THRESHOLDS,
      tier_commission_rates: data.tier_commission_rates || DEFAULT_TIER_COMMISSION_RATES,
    },
  });
});

admin.put("/settings", async (c) => {
  const adminProfileId = c.get("adminProfileId");
  const supabase = createSupabaseAdmin();

  const settingsSchema = z.object({
    commission_rate: z.number().min(0).max(100),
  });
  const body = await c.req.json();
  const parsed = settingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .limit(1)
    .single();

  if (!existing) {
    return c.json({ error: "Settings not found" }, 404);
  }

  const { data, error } = await supabase
    .from("admin_settings")
    .update({
      commission_rate: parsed.data.commission_rate,
      updated_by: adminProfileId,
    })
    .eq("id", existing.id)
    .select("commission_rate")
    .single();

  if (error) {
    console.error("Error updating settings:", error);
    return c.json({ error: "Failed to update settings" }, 500);
  }

  void auditFromContext(c, {
    action: "settings.edit",
    targetType: "settings",
    targetId: "commission_rate",
    metadata: { commission_rate: parsed.data.commission_rate },
  });

  return c.json({ settings: { commission_rate: data.commission_rate } });
});

// ============================================================
// Tier Configuration Endpoints
// ============================================================

const tierThresholdSchema = z.object({
  min_sales: z.number().int().min(0),
  min_rating: z.number().min(0).max(5),
  min_days: z.number().int().min(0),
  require_stripe: z.boolean(),
});

const tierSettingsSchema = z.object({
  tier_thresholds: z.record(z.string(), tierThresholdSchema).optional(),
  tier_commission_rates: z.record(z.string(), z.number().min(0).max(100)).optional(),
});

admin.get("/settings/tiers", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("admin_settings")
    .select("tier_thresholds, tier_commission_rates")
    .limit(1)
    .single();

  if (error) {
    console.error("Error fetching tier settings:", error);
    return c.json({ error: "Failed to fetch tier settings" }, 500);
  }

  return c.json({
    tier_thresholds: data.tier_thresholds || DEFAULT_TIER_THRESHOLDS,
    tier_commission_rates: data.tier_commission_rates || DEFAULT_TIER_COMMISSION_RATES,
  });
});

admin.patch("/settings/tiers", async (c) => {
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = tierSettingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { tier_thresholds, tier_commission_rates } = parsed.data;

  if (!tier_thresholds && !tier_commission_rates) {
    return c.json({ error: "At least one of tier_thresholds or tier_commission_rates must be provided" }, 400);
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .limit(1)
    .single();

  if (!existing) {
    return c.json({ error: "Settings not found" }, 404);
  }

  const updatePayload: Record<string, unknown> = {};
  if (tier_thresholds) updatePayload.tier_thresholds = tier_thresholds;
  if (tier_commission_rates) updatePayload.tier_commission_rates = tier_commission_rates;

  const { data, error } = await supabase
    .from("admin_settings")
    .update(updatePayload)
    .eq("id", existing.id)
    .select("tier_thresholds, tier_commission_rates")
    .single();

  if (error) {
    console.error("Error updating tier settings:", error);
    return c.json({ error: "Failed to update tier settings" }, 500);
  }

  void auditFromContext(c, {
    action: "settings.edit",
    targetType: "settings",
    targetId: "tiers",
    metadata: updatePayload,
  });

  return c.json({
    tier_thresholds: data.tier_thresholds,
    tier_commission_rates: data.tier_commission_rates,
  });
});

// ============================================================
// Admin Manual Tier Override
// ============================================================

const trustTierOverrideSchema = z.object({
  trust_tier: z.number().int().min(0).max(3).nullable(),
});

admin.patch("/users/:id/trust-tier", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = trustTierOverrideSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { trust_tier } = parsed.data;

  const updatePayload: Record<string, unknown> = {};

  if (trust_tier !== null) {
    // Setting override: update both trust_tier_override and trust_tier
    updatePayload.trust_tier_override = trust_tier;
    updatePayload.trust_tier = trust_tier;
  } else {
    // Removing override: set trust_tier_override to null (trust_tier recalculated on next cron)
    updatePayload.trust_tier_override = null;
  }

  const { data: user, error } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", userId)
    .select("id, display_name, trust_tier, trust_tier_override")
    .single();

  if (error) {
    console.error("Error updating trust tier override:", error);
    return c.json({ error: "Failed to update trust tier" }, 500);
  }

  return c.json({ user });
});

// ============================================================
// Seller quality (Phase 0.4) — admin-only 0–5 rating (Screens 11/12)
// ============================================================

const sellerQualitySchema = z.object({
  // 0.0–5.0 in 0.5 steps; null clears the rating.
  seller_quality: z.number().min(0).max(5).nullable(),
});

/**
 * PATCH /api/admin/users/:id/seller-quality
 * Set/clear a seller's admin-only quality rating. Never shown to users.
 */
admin.patch("/users/:id/seller-quality", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = sellerQualitySchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  // Capture the prior value for the audit before/after.
  const { data: before } = await supabase
    .from("profiles")
    .select("seller_quality")
    .eq("id", userId)
    .single();

  const { data: user, error } = await supabase
    .from("profiles")
    .update({ seller_quality: parsed.data.seller_quality })
    .eq("id", userId)
    .select("id, display_name, seller_quality")
    .single();

  if (error || !user) {
    console.error("Error updating seller_quality:", error);
    return c.json({ error: "Failed to update seller quality" }, 500);
  }

  void auditFromContext(c, {
    action: "user.seller_quality_set",
    targetType: "user",
    targetId: userId,
    metadata: {
      before: before?.seller_quality ?? null,
      after: parsed.data.seller_quality,
    },
  });

  return c.json({ user });
});

// ============================================================
// Cron: Recalculate Trust Tiers
// ============================================================

admin.post("/cron/recalculate-tiers", async (c) => {
  // Protect by CRON_SECRET Bearer token (same pattern as orders cron)
  const authHeader = c.req.header("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return c.json({ error: "Server configuration error" }, 500);
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = createSupabaseAdmin();

  // Fetch tier thresholds from admin_settings
  const { data: settings } = await supabase
    .from("admin_settings")
    .select("tier_thresholds, tier_commission_rates")
    .limit(1)
    .single();

  const thresholds = (settings?.tier_thresholds || DEFAULT_TIER_THRESHOLDS) as Record<string, TierThreshold>;
  const commissionRates = (settings?.tier_commission_rates || DEFAULT_TIER_COMMISSION_RATES) as Record<string, number>;

  // Fetch all profiles WITHOUT manual override
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, display_name, trust_tier, created_at, stripe_onboarding_complete")
    .is("trust_tier_override", null);

  if (profilesError || !profiles) {
    console.error("Error fetching profiles for tier recalculation:", profilesError);
    return c.json({ error: "Failed to fetch profiles" }, 500);
  }

  if (profiles.length === 0) {
    // Compute and update category medians anyway
    const medians = await computeCategoryMedians(supabase);
    await supabase
      .from("admin_settings")
      .update({ category_medians: medians })
      .not("id", "is", null);
    return c.json({ updated: 0, total: 0, medians_updated: true });
  }

  const sellerIds = profiles.map((p) => p.id);

  // Batch query: completed order counts per seller
  const { data: orderCounts } = await supabase
    .from("orders")
    .select("seller_id")
    .eq("status", "complete")
    .in("seller_id", sellerIds);

  const salesBySeller: Record<string, number> = {};
  for (const row of orderCounts || []) {
    salesBySeller[row.seller_id] = (salesBySeller[row.seller_id] || 0) + 1;
  }

  // Batch query: avg ratings per reviewee (buyer reviews only, revealed)
  const { data: reviews } = await supabase
    .from("reviews")
    .select("reviewee_id, rating")
    .eq("reviewer_role", "buyer")
    .not("revealed_at", "is", null)
    .in("reviewee_id", sellerIds);

  const ratingsBySeller: Record<string, { sum: number; count: number }> = {};
  for (const row of reviews || []) {
    if (!ratingsBySeller[row.reviewee_id]) {
      ratingsBySeller[row.reviewee_id] = { sum: 0, count: 0 };
    }
    ratingsBySeller[row.reviewee_id].sum += row.rating;
    ratingsBySeller[row.reviewee_id].count += 1;
  }

  // Calculate new tiers and collect changes
  const now = Date.now();
  const tierChanges: Array<{
    id: string;
    displayName: string;
    oldTier: TrustTier;
    newTier: TrustTier;
  }> = [];
  const updates: Array<{ id: string; trust_tier: TrustTier }> = [];

  for (const profile of profiles) {
    const completedSales = salesBySeller[profile.id] || 0;
    const ratingData = ratingsBySeller[profile.id];
    const avgRating = ratingData ? ratingData.sum / ratingData.count : null;
    const accountAgeDays = Math.floor(
      (now - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24)
    );
    const stripeVerified = profile.stripe_onboarding_complete ?? false;

    const newTier = calculateTrustTier(
      completedSales,
      avgRating,
      accountAgeDays,
      stripeVerified,
      thresholds
    );

    const oldTier = (profile.trust_tier ?? 0) as TrustTier;

    if (newTier !== oldTier) {
      tierChanges.push({
        id: profile.id,
        displayName: profile.display_name || "Seller",
        oldTier,
        newTier,
      });
      updates.push({ id: profile.id, trust_tier: newTier });
    }
  }

  // Batch update sellers whose tier changed
  let updatedCount = 0;
  for (const update of updates) {
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ trust_tier: update.trust_tier })
      .eq("id", update.id);

    if (!updateError) {
      updatedCount++;
    } else {
      console.error(`Failed to update trust tier for ${update.id}:`, updateError);
    }
  }

  // Send tier change notifications
  for (const change of tierChanges) {
    const newTierLabel = TIER_LABELS[change.newTier];
    const oldTierLabel = TIER_LABELS[change.oldTier];
    const rate = commissionRates[String(change.newTier)] ?? 12;
    const autoApprove = change.newTier >= 2;

    if (change.newTier > change.oldTier) {
      const template = tierUpgradeNotification(
        change.displayName,
        change.newTier,
        newTierLabel,
        rate,
        autoApprove
      );
      createNotification({
        user_id: change.id,
        type: "tier_upgrade",
        title: template.title,
        body: template.body,
        // Tier changes are seller-only.
        data: { new_tier: change.newTier, old_tier: change.oldTier, role: "seller" },
      }).catch((err) => console.error("[cron] Tier upgrade notification error:", err));
    } else {
      const template = tierDowngradeNotification(
        change.displayName,
        change.newTier,
        newTierLabel,
        oldTierLabel
      );
      createNotification({
        user_id: change.id,
        type: "tier_downgrade",
        title: template.title,
        body: template.body,
        data: { new_tier: change.newTier, old_tier: change.oldTier, role: "seller" },
      }).catch((err) => console.error("[cron] Tier downgrade notification error:", err));
    }
  }

  // Compute and update category medians
  const medians = await computeCategoryMedians(supabase);
  await supabase
    .from("admin_settings")
    .update({ category_medians: medians })
    .not("id", "is", null);

  return c.json({ updated: updatedCount, total: profiles.length, medians_updated: true });
});

// ============================================================
// Admin Referral Code Management
// ============================================================

admin.patch("/referrals/:userId/disable", async (c) => {
  const userId = c.req.param("userId");
  const adminProfileId = c.get("adminProfileId");
  const supabase = createSupabaseAdmin();

  const { data: codeRow, error: fetchError } = await supabase
    .from("referral_codes")
    .select("id, code, disabled")
    .eq("user_id", userId)
    .single();

  if (fetchError || !codeRow) {
    return c.json({ error: "Referral code not found for this user" }, 404);
  }

  const { data: updated, error: updateError } = await supabase
    .from("referral_codes")
    .update({
      disabled: true,
      disabled_at: new Date().toISOString(),
      disabled_by: adminProfileId,
    })
    .eq("id", codeRow.id)
    .select("id, code, disabled, disabled_at")
    .single();

  if (updateError) {
    console.error("Error disabling referral code:", updateError);
    return c.json({ error: "Failed to disable referral code" }, 500);
  }

  void auditFromContext(c, {
    action: "referral.disable",
    targetType: "referral",
    targetId: userId,
    metadata: { code: codeRow.code },
  });

  return c.json({ success: true, code: updated });
});

admin.patch("/referrals/:userId/enable", async (c) => {
  const userId = c.req.param("userId");
  const supabase = createSupabaseAdmin();

  const { data: codeRow, error: fetchError } = await supabase
    .from("referral_codes")
    .select("id, code, disabled")
    .eq("user_id", userId)
    .single();

  if (fetchError || !codeRow) {
    return c.json({ error: "Referral code not found for this user" }, 404);
  }

  const { data: updated, error: updateError } = await supabase
    .from("referral_codes")
    .update({
      disabled: false,
      disabled_at: null,
      disabled_by: null,
    })
    .eq("id", codeRow.id)
    .select("id, code, disabled")
    .single();

  if (updateError) {
    console.error("Error enabling referral code:", updateError);
    return c.json({ error: "Failed to enable referral code" }, 500);
  }

  void auditFromContext(c, {
    action: "referral.enable",
    targetType: "referral",
    targetId: userId,
    metadata: { code: codeRow.code },
  });

  return c.json({ success: true, code: updated });
});

// ============================================================
// Analytics Endpoints
// ============================================================

admin.get("/analytics/search-demand", async (c) => {
  const supabase = createSupabaseAdmin();
  const rangeDate = parseRange(c.req.query("range"));

  // Top 20 search terms with count
  let topTermsQuery = supabase
    .from("search_queries")
    .select("term");

  if (rangeDate) {
    topTermsQuery = topTermsQuery.gte("created_at", rangeDate.toISOString());
  }

  const { data: searchRows } = await topTermsQuery;

  const termCounts: Record<string, number> = {};
  const zeroResultCounts: Record<string, number> = {};

  for (const row of searchRows || []) {
    const term = (row.term || "").toLowerCase().trim();
    if (!term) continue;
    termCounts[term] = (termCounts[term] || 0) + 1;
  }

  // Zero result terms: re-query with result_count = 0
  let zeroQuery = supabase
    .from("search_queries")
    .select("term")
    .eq("result_count", 0);

  if (rangeDate) {
    zeroQuery = zeroQuery.gte("created_at", rangeDate.toISOString());
  }

  const { data: zeroRows } = await zeroQuery;

  for (const row of zeroRows || []) {
    const term = (row.term || "").toLowerCase().trim();
    if (!term) continue;
    zeroResultCounts[term] = (zeroResultCounts[term] || 0) + 1;
  }

  const top_terms = Object.entries(termCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  const zero_result_terms = Object.entries(zeroResultCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  // Demand-supply gaps: terms where search count > 3x listing count
  const { data: activeListings } = await supabase
    .from("listings")
    .select("title, category")
    .eq("status", "active");

  const demand_supply_gaps: Array<{ term: string; search_count: number; listing_count: number }> = [];
  for (const { term, count } of top_terms) {
    const matchingListings = (activeListings || []).filter(
      (l) => l.title?.toLowerCase().includes(term)
    ).length;
    if (count > 3 * Math.max(matchingListings, 1)) {
      demand_supply_gaps.push({ term, search_count: count, listing_count: matchingListings });
    }
  }

  return c.json({ top_terms, zero_result_terms, demand_supply_gaps });
});

admin.get("/analytics/categories", async (c) => {
  const supabase = createSupabaseAdmin();
  const rangeDate = parseRange(c.req.query("range"));

  let query = supabase
    .from("listings")
    .select("category, price_amount")
    .eq("status", "active");

  if (rangeDate) {
    query = query.gte("created_at", rangeDate.toISOString());
  }

  const { data: listings, error } = await query;

  if (error) {
    console.error("Error fetching category analytics:", error);
    return c.json({ error: "Failed to fetch category analytics" }, 500);
  }

  const catCounts: Record<string, number> = {};
  const catPrices: Record<string, { sum: number; count: number }> = {};

  for (const listing of listings || []) {
    const cat = listing.category || "unknown";
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    if (!catPrices[cat]) catPrices[cat] = { sum: 0, count: 0 };
    catPrices[cat].sum += listing.price_amount || 0;
    catPrices[cat].count += 1;
  }

  const listings_by_category = Object.entries(catCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const avg_price_by_category = Object.entries(catPrices)
    .map(([name, { sum, count }]) => ({
      name,
      avg_price: Math.round(sum / count),
    }))
    .sort((a, b) => b.avg_price - a.avg_price);

  return c.json({ listings_by_category, avg_price_by_category });
});

admin.get("/analytics/sellers", async (c) => {
  const supabase = createSupabaseAdmin();
  const rangeDate = parseRange(c.req.query("range"));

  let ordersQuery = supabase
    .from("orders")
    .select("seller_id, total_amount, created_at");

  if (rangeDate) {
    ordersQuery = ordersQuery.gte("created_at", rangeDate.toISOString());
  }

  const { data: orders, error } = await ordersQuery;

  if (error) {
    console.error("Error fetching seller analytics:", error);
    return c.json({ error: "Failed to fetch seller analytics" }, 500);
  }

  const sellerStats: Record<string, { gmv: number; count: number }> = {};
  for (const order of orders || []) {
    if (!order.seller_id) continue;
    if (!sellerStats[order.seller_id]) sellerStats[order.seller_id] = { gmv: 0, count: 0 };
    sellerStats[order.seller_id].gmv += order.total_amount || 0;
    sellerStats[order.seller_id].count += 1;
  }

  // Get top 10 by GMV
  const topSellerIds = Object.entries(sellerStats)
    .sort((a, b) => b[1].gmv - a[1].gmv)
    .slice(0, 10)
    .map(([id]) => id);

  if (topSellerIds.length === 0) {
    return c.json({ top_sellers: [] });
  }

  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url")
    .in("id", topSellerIds);

  const profileMap: Record<string, { display_name: string; avatar_url: string | null }> = {};
  for (const p of profiles || []) {
    profileMap[p.id] = { display_name: p.display_name || "Unknown", avatar_url: p.avatar_url };
  }

  // Average response time: use messages table (time from first buyer message to seller reply)
  const top_sellers = topSellerIds.map((sellerId) => {
    const stats = sellerStats[sellerId];
    const profile = profileMap[sellerId];
    return {
      seller_id: sellerId,
      display_name: profile?.display_name || "Unknown",
      avatar_url: profile?.avatar_url || null,
      total_gmv: stats.gmv,
      sales_count: stats.count,
      avg_response_time_hours: null as number | null, // Would require message analysis
    };
  });

  return c.json({ top_sellers });
});

// ============================================================
// Moderation Endpoints
// ============================================================

admin.get("/moderation/flagged", async (c) => {
  const supabase = createSupabaseAdmin();

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const page = Math.max(parseInt(pageParam || "1", 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    100
  );
  const offset = (page - 1) * limit;

  // Fetch a bounded window of pending message flags.
  // We range over flags (not conversations); the handler still groups to
  // unique conversations, so the returned count may be <= limit per page.
  const { data: flags, error, count } = await supabase
    .from("fraud_flags")
    .select("id, entity_id, flag_type, details, created_at", {
      count: "exact",
    })
    .eq("entity_type", "message")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error fetching flagged messages:", error);
    return c.json({ error: "Failed to fetch flagged messages" }, 500);
  }

  if (!flags || flags.length === 0) {
    return c.json({
      items: [],
      conversations: [],
      page,
      limit,
      total: count || 0,
    });
  }

  // Get message details for each flag
  const messageIds = [...new Set(flags.map((f) => f.entity_id))];
  const { data: messages } = await supabase
    .from("messages")
    .select("id, conversation_id, content, sender_id")
    .in("id", messageIds);

  const messageMap: Record<string, { conversation_id: string; content: string; sender_id: string }> = {};
  for (const msg of messages || []) {
    messageMap[msg.id] = msg;
  }

  // Group flags by conversation
  const convFlags: Record<string, {
    flag_count: number;
    flag_types: Set<string>;
    latest_flag_at: string;
    preview: string;
  }> = {};

  for (const flag of flags) {
    const msg = messageMap[flag.entity_id];
    if (!msg) continue;
    const convId = msg.conversation_id;
    if (!convFlags[convId]) {
      convFlags[convId] = {
        flag_count: 0,
        flag_types: new Set(),
        latest_flag_at: flag.created_at,
        preview: (msg.content || "").slice(0, 100),
      };
    }
    convFlags[convId].flag_count += 1;
    convFlags[convId].flag_types.add(flag.flag_type);
    if (flag.created_at > convFlags[convId].latest_flag_at) {
      convFlags[convId].latest_flag_at = flag.created_at;
    }
  }

  // Get conversation participant info
  const convIds = Object.keys(convFlags);
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id")
    .in("id", convIds);

  const participantIds = new Set<string>();
  for (const conv of conversations || []) {
    if (conv.buyer_id) participantIds.add(conv.buyer_id);
    if (conv.seller_id) participantIds.add(conv.seller_id);
  }

  const { data: participantProfiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", [...participantIds]);

  const nameMap: Record<string, string> = {};
  for (const p of participantProfiles || []) {
    nameMap[p.id] = p.display_name || "Unknown";
  }

  const convMap: Record<string, { buyer_id: string; seller_id: string }> = {};
  for (const conv of conversations || []) {
    convMap[conv.id] = { buyer_id: conv.buyer_id, seller_id: conv.seller_id };
  }

  const result = convIds
    .map((convId) => {
      const info = convFlags[convId];
      const conv = convMap[convId];
      return {
        conversation_id: convId,
        participants: conv
          ? [nameMap[conv.buyer_id] || "Unknown", nameMap[conv.seller_id] || "Unknown"]
          : [],
        flag_count: info.flag_count,
        flag_types: [...info.flag_types],
        latest_flag_at: info.latest_flag_at,
        preview: info.preview,
      };
    })
    .sort((a, b) => b.latest_flag_at.localeCompare(a.latest_flag_at));

  return c.json({
    items: result,
    conversations: result,
    page,
    limit,
    total: count || 0,
  });
});

admin.get("/moderation/conversation/:id", async (c) => {
  const conversationId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Get conversation metadata
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id, listing_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  // Get participant profiles
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url")
    .in("id", [conversation.buyer_id, conversation.seller_id].filter(Boolean));

  // Get listing info if exists
  let listing = null;
  if (conversation.listing_id) {
    const { data: listingData } = await supabase
      .from("listings")
      .select("id, title, price_amount")
      .eq("id", conversation.listing_id)
      .single();
    listing = listingData;
  }

  // Get all messages
  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("id, sender_id, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (msgError) {
    console.error("Error fetching conversation messages:", msgError);
    return c.json({ error: "Failed to fetch messages" }, 500);
  }

  // Get flags for messages in this conversation
  const messageIds = (messages || []).map((m) => m.id);
  let flagMap: Record<string, Array<{ id: string; flag_type: string; details: Record<string, unknown> | null; status: string }>> = {};

  if (messageIds.length > 0) {
    const { data: flags } = await supabase
      .from("fraud_flags")
      .select("id, entity_id, flag_type, details, status")
      .eq("entity_type", "message")
      .in("entity_id", messageIds);

    for (const flag of flags || []) {
      if (!flagMap[flag.entity_id]) flagMap[flag.entity_id] = [];
      flagMap[flag.entity_id].push({
        id: flag.id,
        flag_type: flag.flag_type,
        details: flag.details,
        status: flag.status,
      });
    }
  }

  const messagesWithFlags = (messages || []).map((msg) => ({
    ...msg,
    flags: flagMap[msg.id] || [],
    is_flagged: !!flagMap[msg.id] && flagMap[msg.id].length > 0,
  }));

  return c.json({
    conversation: {
      id: conversation.id,
      participants: profiles || [],
      listing,
    },
    messages: messagesWithFlags,
  });
});

admin.post("/moderation/warn", async (c) => {
  const supabase = createSupabaseAdmin();

  const warnSchema = z.object({
    conversation_id: z.string().uuid(),
    message: z.string().optional(),
  });

  const body = await c.req.json();
  const parsed = warnSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const defaultMessage =
    "Sharing contact info violates our terms. Keep transactions on Kifaayat for buyer protection.";
  const warningContent = parsed.data.message || defaultMessage;

  // Insert system warning message
  const { error: msgError } = await supabase.from("messages").insert({
    conversation_id: parsed.data.conversation_id,
    sender_id: null,
    content: warningContent,
  });

  if (msgError) {
    console.error("Error inserting warning message:", msgError);
    return c.json({ error: "Failed to send warning" }, 500);
  }

  // Mark related pending flags as reviewed
  const { data: convMessages } = await supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", parsed.data.conversation_id);

  const convMessageIds = (convMessages || []).map((m) => m.id);

  if (convMessageIds.length > 0) {
    await supabase
      .from("fraud_flags")
      .update({ status: "reviewed", reviewed_at: new Date().toISOString() })
      .eq("entity_type", "message")
      .eq("status", "pending")
      .in("entity_id", convMessageIds);
  }

  void auditFromContext(c, {
    action: "moderation.warn",
    targetType: "message",
    targetId: parsed.data.conversation_id,
    metadata: { conversation_id: parsed.data.conversation_id },
  });

  return c.json({ success: true });
});

admin.post("/moderation/redact", async (c) => {
  const supabase = createSupabaseAdmin();

  const redactSchema = z.object({
    flag_id: z.string().uuid(),
  });

  const body = await c.req.json();
  const parsed = redactSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Get the flag
  const { data: flag, error: flagError } = await supabase
    .from("fraud_flags")
    .select("id, entity_id, details")
    .eq("id", parsed.data.flag_id)
    .eq("entity_type", "message")
    .single();

  if (flagError || !flag) {
    return c.json({ error: "Flag not found" }, 404);
  }

  // Get the message
  const { data: message, error: msgError } = await supabase
    .from("messages")
    .select("id, content")
    .eq("id", flag.entity_id)
    .single();

  if (msgError || !message) {
    return c.json({ error: "Message not found" }, 404);
  }

  // Replace matched content with [redacted]
  const matchedContent = (flag.details as Record<string, unknown>)?.matched_content as string | undefined;
  let redactedContent = message.content;
  if (matchedContent && redactedContent) {
    redactedContent = redactedContent.replace(matchedContent, "[redacted]");
  } else {
    redactedContent = "[redacted]";
  }

  // Update message content
  const { error: updateMsgError } = await supabase
    .from("messages")
    .update({ content: redactedContent })
    .eq("id", message.id);

  if (updateMsgError) {
    console.error("Error redacting message:", updateMsgError);
    return c.json({ error: "Failed to redact message" }, 500);
  }

  // Update flag status
  await supabase
    .from("fraud_flags")
    .update({ status: "actioned", reviewed_at: new Date().toISOString() })
    .eq("id", flag.id);

  void auditFromContext(c, {
    action: "moderation.message_redact",
    targetType: "message",
    targetId: message.id as string,
    metadata: { flag_id: flag.id },
  });

  return c.json({ success: true });
});

admin.post("/moderation/suspend", async (c) => {
  const supabase = createSupabaseAdmin();

  const suspendSchema = z.object({
    user_id: z.string().uuid(),
    reason: z.string().min(1),
  });

  const body = await c.req.json();
  const parsed = suspendSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Suspend the user
  const { error: suspendError } = await supabase
    .from("profiles")
    .update({ suspended_at: new Date().toISOString() })
    .eq("id", parsed.data.user_id);

  if (suspendError) {
    console.error("Error suspending user:", suspendError);
    return c.json({ error: "Failed to suspend user" }, 500);
  }

  // Mark all pending flags for this user as actioned
  // (flags where entity is a message sent by this user)
  const { data: userMessages } = await supabase
    .from("messages")
    .select("id")
    .eq("sender_id", parsed.data.user_id);

  const userMessageIds = (userMessages || []).map((m) => m.id);

  if (userMessageIds.length > 0) {
    await supabase
      .from("fraud_flags")
      .update({ status: "actioned", reviewed_at: new Date().toISOString() })
      .eq("entity_type", "message")
      .eq("status", "pending")
      .in("entity_id", userMessageIds);
  }

  // Create notification for the user — system-level, no buyer/seller role.
  createNotification({
    user_id: parsed.data.user_id,
    type: "account_suspended",
    title: "Account Suspended",
    body: `Your account has been suspended: ${parsed.data.reason}`,
    data: { reason: parsed.data.reason, role: "system" },
  }).catch((err) => console.error("[admin] Suspension notification error:", err));

  void auditFromContext(c, {
    action: "moderation.suspend",
    targetType: "user",
    targetId: parsed.data.user_id,
    reason: parsed.data.reason,
  });

  return c.json({ success: true });
});

// ============================================================
// Auto-Approve Config Endpoints
// ============================================================

admin.get("/settings/auto-approve", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("admin_settings")
    .select("auto_approve_config")
    .limit(1)
    .single();

  if (error) {
    console.error("Error fetching auto-approve config:", error);
    return c.json({ error: "Failed to fetch auto-approve config" }, 500);
  }

  return c.json({ auto_approve_config: data.auto_approve_config || {} });
});

admin.put("/settings/auto-approve", async (c) => {
  const supabase = createSupabaseAdmin();

  const autoApproveSchema = z.object({
    auto_approve_config: z.record(
      z.string(),
      z.object({
        enabled: z.boolean(),
        max_risk: z.number().int().min(0).max(100),
      })
    ),
  });

  const body = await c.req.json();
  const parsed = autoApproveSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: existing } = await supabase
    .from("admin_settings")
    .select("id")
    .limit(1)
    .single();

  if (!existing) {
    return c.json({ error: "Settings not found" }, 404);
  }

  const { data, error } = await supabase
    .from("admin_settings")
    .update({ auto_approve_config: parsed.data.auto_approve_config })
    .eq("id", existing.id)
    .select("auto_approve_config")
    .single();

  if (error) {
    console.error("Error updating auto-approve config:", error);
    return c.json({ error: "Failed to update auto-approve config" }, 500);
  }

  void auditFromContext(c, {
    action: "settings.edit",
    targetType: "settings",
    targetId: "auto_approve",
    metadata: { auto_approve_config: parsed.data.auto_approve_config },
  });

  return c.json({ auto_approve_config: data.auto_approve_config });
});

// ============================================================
// Categories CRUD
// ============================================================

admin.get("/config/categories", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: categories, error } = await supabase
    .from("categories")
    .select("*")
    .order("display_order", { ascending: true });

  if (error) {
    console.error("Error fetching categories:", error);
    return c.json({ error: "Failed to fetch categories" }, 500);
  }

  return c.json({ categories: categories || [] });
});

admin.post("/config/categories", async (c) => {
  const supabase = createSupabaseAdmin();

  const createCategorySchema = z.object({
    name: z.string().min(1).max(100),
    icon_url: z.string().url().optional(),
  });

  const body = await c.req.json();
  const parsed = createCategorySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Get max display_order
  const { data: maxRow } = await supabase
    .from("categories")
    .select("display_order")
    .order("display_order", { ascending: false })
    .limit(1)
    .single();

  const nextOrder = (maxRow?.display_order ?? -1) + 1;

  const { data: category, error } = await supabase
    .from("categories")
    .insert({
      name: parsed.data.name,
      icon_url: parsed.data.icon_url || null,
      display_order: nextOrder,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating category:", error);
    return c.json({ error: "Failed to create category" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: (category as Record<string, unknown>)?.id as string,
    metadata: { op: "category_create", name: parsed.data.name },
  });

  return c.json({ category }, 201);
});

admin.put("/config/categories/reorder", async (c) => {
  const supabase = createSupabaseAdmin();

  const reorderSchema = z.object({
    order: z.array(z.string().uuid()),
  });

  const body = await c.req.json();
  const parsed = reorderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Update each category's display_order to its array index
  for (let i = 0; i < parsed.data.order.length; i++) {
    const { error } = await supabase
      .from("categories")
      .update({ display_order: i, updated_at: new Date().toISOString() })
      .eq("id", parsed.data.order[i]);

    if (error) {
      console.error(`Error reordering category ${parsed.data.order[i]}:`, error);
    }
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: null,
    metadata: { op: "category_reorder", order: parsed.data.order },
  });

  return c.json({ success: true });
});

admin.put("/config/categories/:id", async (c) => {
  const categoryId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const updateCategorySchema = z.object({
    name: z.string().min(1).max(100).optional(),
    icon_url: z.string().url().nullable().optional(),
    is_active: z.boolean().optional(),
  });

  const body = await c.req.json();
  const parsed = updateCategorySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
  if (parsed.data.icon_url !== undefined) updatePayload.icon_url = parsed.data.icon_url;
  if (parsed.data.is_active !== undefined) updatePayload.is_active = parsed.data.is_active;

  const { data: category, error } = await supabase
    .from("categories")
    .update(updatePayload)
    .eq("id", categoryId)
    .select()
    .single();

  if (error) {
    console.error("Error updating category:", error);
    return c.json({ error: "Failed to update category" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: categoryId,
    metadata: { op: "category_update", changes: updatePayload },
  });

  return c.json({ category });
});

admin.delete("/config/categories/:id", async (c) => {
  const categoryId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Soft delete: set is_active = false
  const { error } = await supabase
    .from("categories")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", categoryId);

  if (error) {
    console.error("Error soft-deleting category:", error);
    return c.json({ error: "Failed to delete category" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: categoryId,
    metadata: { op: "category_delete" },
  });

  return c.json({ success: true });
});

// ============================================================
// Boost Pricing CRUD
// ============================================================

admin.get("/config/boost-pricing", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: tiers, error } = await supabase
    .from("boost_pricing_tiers")
    .select("*")
    .order("display_order", { ascending: true });

  if (error) {
    console.error("Error fetching boost pricing:", error);
    return c.json({ error: "Failed to fetch boost pricing" }, 500);
  }

  return c.json({ tiers: tiers || [] });
});

admin.post("/config/boost-pricing", async (c) => {
  const supabase = createSupabaseAdmin();

  const createBoostSchema = z.object({
    duration_days: z.number().int().positive(),
    price_cents: z.number().int().positive(),
  });

  const body = await c.req.json();
  const parsed = createBoostSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Get max display_order
  const { data: maxRow } = await supabase
    .from("boost_pricing_tiers")
    .select("display_order")
    .order("display_order", { ascending: false })
    .limit(1)
    .single();

  const nextOrder = (maxRow?.display_order ?? -1) + 1;

  const { data: tier, error } = await supabase
    .from("boost_pricing_tiers")
    .insert({
      duration_days: parsed.data.duration_days,
      price_cents: parsed.data.price_cents,
      display_order: nextOrder,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating boost tier:", error);
    return c.json({ error: "Failed to create boost tier" }, 500);
  }

  return c.json({ tier }, 201);
});

admin.put("/config/boost-pricing/:id", async (c) => {
  const tierId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const updateBoostSchema = z.object({
    duration_days: z.number().int().positive().optional(),
    price_cents: z.number().int().positive().optional(),
    is_active: z.boolean().optional(),
  });

  const body = await c.req.json();
  const parsed = updateBoostSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const updatePayload: Record<string, unknown> = {};
  if (parsed.data.duration_days !== undefined) updatePayload.duration_days = parsed.data.duration_days;
  if (parsed.data.price_cents !== undefined) updatePayload.price_cents = parsed.data.price_cents;
  if (parsed.data.is_active !== undefined) updatePayload.is_active = parsed.data.is_active;

  const { data: tier, error } = await supabase
    .from("boost_pricing_tiers")
    .update(updatePayload)
    .eq("id", tierId)
    .select()
    .single();

  if (error) {
    console.error("Error updating boost tier:", error);
    return c.json({ error: "Failed to update boost tier" }, 500);
  }

  return c.json({ tier });
});

// ============================================================
// Notification Type Config
// ============================================================

admin.get("/config/notification-types", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: types, error } = await supabase
    .from("notification_type_config")
    .select("*")
    .order("category", { ascending: true })
    .order("type_key", { ascending: true });

  if (error) {
    console.error("Error fetching notification types:", error);
    return c.json({ error: "Failed to fetch notification types" }, 500);
  }

  return c.json({ notification_types: types || [] });
});

admin.put("/config/notification-types/:id", async (c) => {
  const typeId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const updateNotifSchema = z.object({
    push_enabled: z.boolean().optional(),
    email_enabled: z.boolean().optional(),
  });

  const body = await c.req.json();
  const parsed = updateNotifSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.push_enabled !== undefined) updatePayload.push_enabled = parsed.data.push_enabled;
  if (parsed.data.email_enabled !== undefined) updatePayload.email_enabled = parsed.data.email_enabled;

  const { data: notifType, error } = await supabase
    .from("notification_type_config")
    .update(updatePayload)
    .eq("id", typeId)
    .select()
    .single();

  if (error) {
    console.error("Error updating notification type:", error);
    return c.json({ error: "Failed to update notification type" }, 500);
  }

  return c.json({ notification_type: notifType });
});

// ============================================================
// Editorial Tags CRUD
// ============================================================

admin.get("/config/editorial-tags", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: tags, error } = await supabase
    .from("editorial_tags")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("Error fetching editorial tags:", error);
    return c.json({ error: "Failed to fetch editorial tags" }, 500);
  }

  return c.json({ tags: tags || [] });
});

admin.post("/config/editorial-tags", async (c) => {
  const supabase = createSupabaseAdmin();

  const createTagSchema = z.object({
    name: z.string().min(1).max(100),
  });

  const body = await c.req.json();
  const parsed = createTagSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: tag, error } = await supabase
    .from("editorial_tags")
    .insert({ name: parsed.data.name })
    .select()
    .single();

  if (error) {
    console.error("Error creating editorial tag:", error);
    return c.json({ error: "Failed to create editorial tag" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: (tag as Record<string, unknown>)?.id as string,
    metadata: { op: "editorial_tag_create", name: parsed.data.name },
  });

  return c.json({ tag }, 201);
});

admin.put("/config/editorial-tags/:id", async (c) => {
  const tagId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const updateTagSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
  });

  const body = await c.req.json();
  const parsed = updateTagSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const updatePayload: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updatePayload.name = parsed.data.name;
  if (parsed.data.is_active !== undefined) updatePayload.is_active = parsed.data.is_active;

  const { data: tag, error } = await supabase
    .from("editorial_tags")
    .update(updatePayload)
    .eq("id", tagId)
    .select()
    .single();

  if (error) {
    console.error("Error updating editorial tag:", error);
    return c.json({ error: "Failed to update editorial tag" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: tagId,
    metadata: { op: "editorial_tag_update", changes: updatePayload },
  });

  return c.json({ tag });
});

admin.delete("/config/editorial-tags/:id", async (c) => {
  const tagId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Soft delete: set is_active = false
  const { error } = await supabase
    .from("editorial_tags")
    .update({ is_active: false })
    .eq("id", tagId);

  if (error) {
    console.error("Error soft-deleting editorial tag:", error);
    return c.json({ error: "Failed to delete editorial tag" }, 500);
  }

  void auditFromContext(c, {
    action: "taxonomy.edit",
    targetType: "taxonomy",
    targetId: tagId,
    metadata: { op: "editorial_tag_delete" },
  });

  return c.json({ success: true });
});

// ============================================================
// Listing Editorial Tag Assignment
// ============================================================

admin.put("/listings/:id/tags", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const setTagsSchema = z.object({
    tag_ids: z.array(z.string().uuid()),
  });

  const body = await c.req.json();
  const parsed = setTagsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Delete existing tags for this listing
  await supabase
    .from("listing_editorial_tags")
    .delete()
    .eq("listing_id", listingId);

  // Insert new tags
  if (parsed.data.tag_ids.length > 0) {
    const rows = parsed.data.tag_ids.map((tag_id) => ({
      listing_id: listingId,
      tag_id,
    }));

    const { error } = await supabase
      .from("listing_editorial_tags")
      .insert(rows);

    if (error) {
      console.error("Error assigning editorial tags:", error);
      return c.json({ error: "Failed to assign tags" }, 500);
    }
  }

  return c.json({ success: true });
});

admin.get("/listings/tags-summary", async (c) => {
  const supabase = createSupabaseAdmin();

  // Two modes:
  //  1. ?listing_ids=uuid,uuid,uuid — only return tags for these listings
  //     (preferred when admin UI already has a page of listings in memory).
  //  2. ?page=<n>&limit=<n> — paginate over the listing_editorial_tags table
  //     itself (default page=1, limit=50, max 100).
  const listingIdsParam = c.req.query("listing_ids");

  if (listingIdsParam) {
    const listingIds = listingIdsParam
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (listingIds.length === 0) {
      return c.json({ tags_summary: {} });
    }

    if (listingIds.length > 200) {
      return c.json({ error: "Maximum 200 listing IDs per request" }, 400);
    }

    const { data: tagAssignments, error } = await supabase
      .from("listing_editorial_tags")
      .select("listing_id, editorial_tags(name)")
      .in("listing_id", listingIds);

    if (error) {
      console.error("Error fetching tag summary:", error);
      return c.json({ error: "Failed to fetch tag summary" }, 500);
    }

    const summary: Record<string, string[]> = {};
    for (const row of tagAssignments || []) {
      const lid = row.listing_id as string;
      const tagName = (row.editorial_tags as unknown as { name: string })?.name;
      if (!tagName) continue;
      if (!summary[lid]) summary[lid] = [];
      summary[lid].push(tagName);
    }

    return c.json({ tags_summary: summary });
  }

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const page = Math.max(parseInt(pageParam || "1", 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    100
  );
  const offset = (page - 1) * limit;

  const { data: tagAssignments, error, count } = await supabase
    .from("listing_editorial_tags")
    .select("listing_id, editorial_tags(name)", { count: "exact" })
    .order("listing_id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error fetching tag summary:", error);
    return c.json({ error: "Failed to fetch tag summary" }, 500);
  }

  const summary: Record<string, string[]> = {};
  for (const row of tagAssignments || []) {
    const listingId = row.listing_id as string;
    const tagName = (row.editorial_tags as unknown as { name: string })?.name;
    if (!tagName) continue;
    if (!summary[listingId]) summary[listingId] = [];
    summary[listingId].push(tagName);
  }

  return c.json({
    tags_summary: summary,
    page,
    limit,
    total: count || 0,
  });
});

// ============================================================
// Notification Toggles
// ============================================================

/**
 * GET /api/admin/notification-toggles
 * Returns the current admin notification toggles.
 * Empty object means all notification types are enabled.
 */
admin.get("/notification-toggles", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: settings, error } = await supabase
    .from("admin_settings")
    .select("notification_toggles")
    .limit(1)
    .single();

  if (error) {
    console.error("Error fetching notification toggles:", error);
    return c.json({ error: "Failed to fetch notification toggles" }, 500);
  }

  return c.json({
    toggles: (settings?.notification_toggles || {}) as Record<string, boolean>,
  });
});

/**
 * PUT /api/admin/notification-toggles
 * Update admin notification toggles.
 * Body: { toggles: Record<string, boolean> }
 * e.g., { "weekly_digest": false, "re_engagement": false }
 * Keys must be valid notification type strings.
 */
admin.put("/notification-toggles", async (c) => {
  const supabase = createSupabaseAdmin();

  let body: { toggles?: Record<string, boolean> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { toggles } = body;

  if (!toggles || typeof toggles !== "object" || Array.isArray(toggles)) {
    return c.json({ error: "toggles must be an object" }, 400);
  }

  // Validate all keys are valid notification types
  const validTypes = new Set<string>(NOTIFICATION_TYPES);
  const invalidKeys = Object.keys(toggles).filter((k) => !validTypes.has(k));
  if (invalidKeys.length > 0) {
    return c.json({
      error: `Invalid notification types: ${invalidKeys.join(", ")}`,
    }, 400);
  }

  // Validate all values are booleans
  const invalidValues = Object.entries(toggles).filter(
    ([, v]) => typeof v !== "boolean"
  );
  if (invalidValues.length > 0) {
    return c.json({
      error: "All toggle values must be boolean",
    }, 400);
  }

  const { data: updated, error } = await supabase
    .from("admin_settings")
    .update({ notification_toggles: toggles })
    .select("notification_toggles")
    .limit(1)
    .single();

  if (error) {
    console.error("Error updating notification toggles:", error);
    return c.json({ error: "Failed to update notification toggles" }, 500);
  }

  return c.json({
    toggles: (updated?.notification_toggles || {}) as Record<string, boolean>,
  });
});

// ============================================================
// Stripe Status Refresh
// ============================================================

let _stripe: Stripe | null = null;
function getStripeAdmin(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not set");
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

admin.post("/sellers/:id/refresh-stripe", async (c) => {
  const sellerId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: profile, error: fetchError } = await supabase
    .from("profiles")
    .select("id, stripe_account_id, stripe_onboarding_complete")
    .eq("id", sellerId)
    .single();

  if (fetchError || !profile) {
    return c.json({ error: "Seller profile not found" }, 404);
  }

  if (!profile.stripe_account_id) {
    return c.json({ error: "Seller has no Stripe account linked" }, 400);
  }

  try {
    const account = await getStripeAdmin().accounts.retrieve(profile.stripe_account_id);
    const isComplete = (account.charges_enabled ?? false) && (account.payouts_enabled ?? false);

    const { error: updateError } = await supabase
      .from("profiles")
      .update({ stripe_onboarding_complete: isComplete })
      .eq("id", sellerId);

    if (updateError) {
      console.error("Error updating stripe status:", updateError);
      return c.json({ error: "Failed to update profile" }, 500);
    }

    return c.json({
      stripe_onboarding_complete: isComplete,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
    });
  } catch (err) {
    console.error("Error retrieving Stripe account:", err);
    return c.json({ error: "Failed to retrieve Stripe account status" }, 500);
  }
});

// ============================================================
// Payouts — admin dashboard for manual Wise / PayPal disbursement
// ============================================================

/**
 * GET /api/admin/payouts
 * List seller_payouts rows. Filter by status (?status=ready_for_payout
 * by default — what the admin actually needs to act on). Inlines the
 * seller's name + relevant payout details so the admin can copy-paste
 * into Wise / PayPal without leaving the page.
 *
 * Query params:
 *   status  — pending | ready_for_payout | sent | paid | failed | cancelled
 *             (default: ready_for_payout)
 *   method  — stripe | wise | paypal (optional filter)
 *   limit   — page size (default 50, max 200)
 *   cursor  — created_at ISO string for pagination
 */
admin.get("/payouts", async (c) => {
  const supabase = createSupabaseAdmin();

  const status = c.req.query("status") || "ready_for_payout";
  const method = c.req.query("method");
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1),
    200
  );
  const cursor = c.req.query("cursor");

  const validStatuses = ["pending", "ready_for_payout", "sent", "paid", "failed", "cancelled"];
  if (!validStatuses.includes(status)) {
    return c.json({ error: `Invalid status. Allowed: ${validStatuses.join(", ")}` }, 400);
  }

  let query = supabase
    .from("seller_payouts")
    .select(
      "id, seller_id, order_id, amount_cents, currency, method, status, " +
        "stripe_transfer_id, external_reference, failure_reason, paid_at, sent_at, created_at, updated_at, " +
        "orders!seller_payouts_order_id_fkey(order_number, listing_id, completed_at), " +
        "seller:profiles!seller_payouts_seller_id_fkey(id, display_name, payout_method, " +
        "stripe_account_id, wise_account_holder, wise_bank_country, wise_bank_currency, " +
        "wise_routing_code, wise_account_number, wise_account_type, paypal_email)"
    )
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (method) {
    if (!["stripe", "wise", "paypal"].includes(method)) {
      return c.json({ error: "Invalid method. Allowed: stripe, wise, paypal" }, 400);
    }
    query = query.eq("method", method);
  }

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: payouts, error } = await query;

  if (error) {
    console.error("Error fetching admin payouts:", error);
    return c.json({ error: "Failed to fetch payouts" }, 500);
  }

  const items = (payouts || []) as unknown as Array<Record<string, unknown>>;
  const nextCursor =
    items.length === limit
      ? (items[items.length - 1].created_at as string)
      : null;

  return c.json({ items, next_cursor: nextCursor });
});

/**
 * GET /api/admin/payouts/summary
 * Aggregate counts + amounts by status so the dashboard can show
 * "12 ready for payout / $5,432 owed" without paging through everything.
 */
admin.get("/payouts/summary", async (c) => {
  const supabase = createSupabaseAdmin();

  const { data: rows, error } = await supabase
    .from("seller_payouts")
    .select("status, method, amount_cents, currency");

  if (error) {
    console.error("Error fetching payouts summary:", error);
    return c.json({ error: "Failed to fetch summary" }, 500);
  }

  const summary: Record<string, { count: number; totals: Record<string, number> }> = {};
  for (const row of rows || []) {
    const status = row.status as string;
    const currency = row.currency as string;
    if (!summary[status]) summary[status] = { count: 0, totals: {} };
    summary[status].count += 1;
    summary[status].totals[currency] =
      (summary[status].totals[currency] || 0) + (row.amount_cents as number);
  }

  return c.json({ summary });
});

const markSentSchema = z.object({
  external_reference: z.string().min(1).max(200),
});

/**
 * POST /api/admin/payouts/:id/mark-sent
 * Admin manually disbursed this payout via Wise or PayPal — record the
 * external transaction id and flip status. For Stripe payouts this
 * endpoint refuses (those are automated via stripe.transfers.create).
 */
admin.post("/payouts/:id/mark-sent", async (c) => {
  const payoutId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = markSentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { data: payout, error: fetchError } = await supabase
    .from("seller_payouts")
    .select("id, method, status")
    .eq("id", payoutId)
    .single();

  if (fetchError || !payout) {
    return c.json({ error: "Payout not found" }, 404);
  }

  if (payout.method === "stripe") {
    return c.json(
      { error: "Stripe payouts are sent automatically via Transfers API — do not mark manually." },
      400
    );
  }

  if (payout.status !== "ready_for_payout") {
    return c.json(
      { error: `Cannot mark sent — payout is in '${payout.status}' status.` },
      400
    );
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("seller_payouts")
    .update({
      status: "paid",
      external_reference: parsed.data.external_reference,
      sent_at: now,
      paid_at: now,
    })
    .eq("id", payoutId)
    .eq("status", "ready_for_payout")
    .select()
    .single();

  if (updateError) {
    console.error("Error marking payout sent:", updateError);
    return c.json({ error: "Failed to mark payout sent" }, 500);
  }

  void auditFromContext(c, {
    action: "payout.mark_sent",
    targetType: "payout",
    targetId: payoutId,
    metadata: {
      method: payout.method,
      external_reference: parsed.data.external_reference,
      amount_cents: (updated as Record<string, unknown>)?.amount_cents ?? null,
      currency: (updated as Record<string, unknown>)?.currency ?? null,
    },
  });

  return c.json({ payout: updated });
});

const markFailedSchema = z.object({
  failure_reason: z.string().min(1).max(1000),
});

/**
 * POST /api/admin/payouts/:id/mark-failed
 * Admin couldn't disburse via Wise / PayPal (bank details wrong, account
 * frozen, etc). Records the reason and flips status — the seller can be
 * contacted to fix their details, then we retry by flipping back to
 * ready_for_payout (not yet automated; do it manually for now).
 */
admin.post("/payouts/:id/mark-failed", async (c) => {
  const payoutId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = markFailedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { data: payout, error: fetchError } = await supabase
    .from("seller_payouts")
    .select("id, status")
    .eq("id", payoutId)
    .single();

  if (fetchError || !payout) {
    return c.json({ error: "Payout not found" }, 404);
  }

  if (payout.status !== "ready_for_payout" && payout.status !== "pending") {
    return c.json(
      { error: `Cannot mark failed — payout is in '${payout.status}' status.` },
      400
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("seller_payouts")
    .update({
      status: "failed",
      failure_reason: parsed.data.failure_reason,
    })
    .eq("id", payoutId)
    .select()
    .single();

  if (updateError) {
    console.error("Error marking payout failed:", updateError);
    return c.json({ error: "Failed to mark payout failed" }, 500);
  }

  void auditFromContext(c, {
    action: "payout.mark_failed",
    targetType: "payout",
    targetId: payoutId,
    reason: parsed.data.failure_reason,
  });

  return c.json({ payout: updated });
});

const retrySchema = z.object({});

/**
 * POST /api/admin/payouts/:id/retry
 * Move a failed payout back to ready_for_payout so the admin can try
 * disbursing again (e.g. after the seller fixed their Wise details).
 */
admin.post("/payouts/:id/retry", async (c) => {
  const payoutId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Body validation kept for shape consistency; no fields needed today.
  await c.req.json().catch(() => ({}));
  retrySchema.safeParse({});

  const { data: payout, error: fetchError } = await supabase
    .from("seller_payouts")
    .select("id, method, status")
    .eq("id", payoutId)
    .single();

  if (fetchError || !payout) {
    return c.json({ error: "Payout not found" }, 404);
  }

  if (payout.status !== "failed") {
    return c.json(
      { error: `Cannot retry — payout is in '${payout.status}' status, not 'failed'.` },
      400
    );
  }

  // For Stripe, retrying = re-invoking the Transfers API. For Wise/PayPal,
  // retrying just flips back to ready_for_payout for the admin to redo.
  if (payout.method === "stripe") {
    const { releasePayoutForOrder } = await import("../services/payoutService.js");
    // First reset to pending so releasePayoutForOrder will act on it.
    const { error: resetError } = await supabase
      .from("seller_payouts")
      .update({ status: "pending", failure_reason: null })
      .eq("id", payoutId)
      .eq("status", "failed");
    if (resetError) {
      console.error("Error resetting failed stripe payout:", resetError);
      return c.json({ error: "Failed to reset payout" }, 500);
    }
    const { data: rowForOrder } = await supabase
      .from("seller_payouts")
      .select("order_id")
      .eq("id", payoutId)
      .single();
    if (rowForOrder?.order_id) {
      await releasePayoutForOrder(rowForOrder.order_id as string);
    }
    const { data: refreshed } = await supabase
      .from("seller_payouts")
      .select("*")
      .eq("id", payoutId)
      .single();
    void auditFromContext(c, {
      action: "payout.retry",
      targetType: "payout",
      targetId: payoutId,
      metadata: { method: "stripe" },
    });
    return c.json({ payout: refreshed });
  }

  const { data: updated, error: updateError } = await supabase
    .from("seller_payouts")
    .update({ status: "ready_for_payout", failure_reason: null })
    .eq("id", payoutId)
    .eq("status", "failed")
    .select()
    .single();

  if (updateError) {
    console.error("Error retrying payout:", updateError);
    return c.json({ error: "Failed to retry payout" }, 500);
  }

  void auditFromContext(c, {
    action: "payout.retry",
    targetType: "payout",
    targetId: payoutId,
    metadata: { method: payout.method },
  });

  return c.json({ payout: updated });
});

// ============================================================
// Audit log (Screen 23) — read-only, append-only trail
// ============================================================

/**
 * GET /api/admin/audit-log
 * Paginated, read-only view of the immutable admin action trail.
 * Filters: actor (id or email substring), action, target_type, from, to.
 * (Permission-gated to `audit.read` once roles land in Phase 0.2.)
 */
admin.get("/audit-log", async (c) => {
  const supabase = createSupabaseAdmin();
  const page = Math.max(parseInt(c.req.query("page") || "1", 10) || 1, 1);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
  const from = (page - 1) * limit;

  let query = supabase
    .from("admin_audit_log")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  const action = c.req.query("action");
  if (action) query = query.eq("action", action);
  const targetType = c.req.query("target_type");
  if (targetType) query = query.eq("target_type", targetType);
  const targetId = c.req.query("target_id");
  if (targetId) query = query.eq("target_id", targetId);
  const actor = c.req.query("actor");
  if (actor) {
    // actor may be a UUID (actor_id) or an email fragment. Only apply the
    // uuid equality when it actually looks like one — otherwise Postgres
    // rejects the cast — and always allow the email substring match.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor);
    query = isUuid
      ? query.or(`actor_id.eq.${actor},actor_email.ilike.%${actor}%`)
      : query.ilike("actor_email", `%${actor}%`);
  }
  const fromDate = c.req.query("from");
  if (fromDate) query = query.gte("created_at", fromDate);
  const toDate = c.req.query("to");
  if (toDate) query = query.lte("created_at", toDate);

  const { data, error, count } = await query;
  if (error) {
    console.error("Error loading audit log:", error);
    return c.json({ error: "Failed to load audit log" }, 500);
  }

  return c.json({ entries: data ?? [], total: count ?? 0, page, limit });
});

// ============================================================
// Transactions & offers (Phase 1) — Screens 07/08/09
// New admin surface; the app/web use /api/orders + /api/offers (untouched).
// ============================================================

// FE tabs → order statuses. "offers" is a separate ledger (below). There's
// no distinct "refunded" status — a refunded order lands in "cancelled".
const TX_TAB_STATUS: Record<string, string[]> = {
  awaiting_shipment: ["paid"],
  in_transit: ["shipped"],
  delivered: ["delivered"],
  completed: ["complete"],
  refunded: ["cancelled"],
};

/**
 * GET /api/admin/transactions
 * Sales + offers ledger (Screen 07). tab=all|offers|awaiting_shipment|
 * in_transit|delivered|completed|refunded, plus region / from / to / search
 * (ref or buyer email) / pagination. Commission (the 15% Kifaayat keeps) is
 * returned per row.
 */
admin.get("/transactions", async (c) => {
  const supabase = createSupabaseAdmin();
  const tab = c.req.query("tab") || "all";
  const page = Math.max(parseInt(c.req.query("page") || "1", 10) || 1, 1);
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 100);
  const offset = (page - 1) * limit;
  const search = c.req.query("search")?.trim();
  const region = c.req.query("region");
  const fromDate = c.req.query("from");
  const toDate = c.req.query("to");

  // --- Offers ledger ---
  if (tab === "offers") {
    const sellerEmbed = region
      ? "seller:profiles!offers_seller_id_fkey!inner(display_name, location)"
      : "seller:profiles!offers_seller_id_fkey(display_name, location)";
    let q = supabase
      .from("offers")
      .select(
        "id, listing_id, amount, currency, status, round, created_at, offered_by, " +
          "listings!offers_listing_id_fkey(title), " +
          "buyer:profiles!offers_buyer_id_fkey(display_name), " +
          sellerEmbed,
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (region) q = q.eq("seller.location", region);
    if (fromDate) q = q.gte("created_at", fromDate);
    if (toDate) q = q.lte("created_at", toDate);

    const { data, error, count } = await q;
    if (error) {
      console.error("Error loading offers ledger:", error);
      return c.json({ error: "Failed to load offers" }, 500);
    }
    const items = (data ?? []).map((o) => {
      const r = o as unknown as Record<string, unknown>;
      return {
        kind: "offer" as const,
        id: r.id,
        ref: `OFFER-${String(r.id).slice(0, 8)}`,
        listing: (r.listings as Record<string, unknown> | null)?.title ?? null,
        buyer: (r.buyer as Record<string, unknown> | null)?.display_name ?? null,
        seller: (r.seller as Record<string, unknown> | null)?.display_name ?? null,
        seller_location: (r.seller as Record<string, unknown> | null)?.location ?? null,
        amount: r.amount,
        currency: r.currency,
        commission: null,
        state: r.status,
        round: r.round,
        created_at: r.created_at,
      };
    });
    return c.json({ items, total: count ?? 0, page, limit });
  }

  // --- Sales (orders) ledger ---
  const sellerEmbed = region
    ? "seller:profiles!orders_seller_id_fkey!inner(display_name, location)"
    : "seller:profiles!orders_seller_id_fkey(display_name, location)";
  let q = supabase
    .from("orders")
    .select(
      "id, order_number, amount, currency, commission_amount, seller_payout, status, created_at, " +
        "listings!orders_listing_id_fkey(title), " +
        "buyer:profiles!orders_buyer_id_fkey(display_name), " +
        sellerEmbed,
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const statuses = TX_TAB_STATUS[tab];
  if (statuses) q = q.in("status", statuses);
  if (region) q = q.eq("seller.location", region);
  if (fromDate) q = q.gte("created_at", fromDate);
  if (toDate) q = q.lte("created_at", toDate);
  // Search by order ref or buyer email (seller-name search is a follow-up —
  // it needs a join filter or a denormalized column).
  if (search) q = q.or(`order_number.ilike.%${search}%,buyer_email.ilike.%${search}%`);

  const { data, error, count } = await q;
  if (error) {
    console.error("Error loading transactions:", error);
    return c.json({ error: "Failed to load transactions" }, 500);
  }
  const items = (data ?? []).map((o) => {
    const r = o as unknown as Record<string, unknown>;
    return {
      kind: "order" as const,
      id: r.id,
      ref: r.order_number,
      listing: (r.listings as Record<string, unknown> | null)?.title ?? null,
      buyer: (r.buyer as Record<string, unknown> | null)?.display_name ?? null,
      seller: (r.seller as Record<string, unknown> | null)?.display_name ?? null,
      seller_location: (r.seller as Record<string, unknown> | null)?.location ?? null,
      amount: r.amount,
      currency: r.currency,
      commission: r.commission_amount,
      seller_payout: r.seller_payout,
      state: r.status,
      created_at: r.created_at,
    };
  });
  return c.json({ items, total: count ?? 0, page, limit });
});

/**
 * GET /api/admin/transactions/:id
 * Full transaction record (Screen 08): money breakdown, shipment, timeline,
 * both parties. Mutating actions (refund / mark-delivered / force-advance)
 * land in the next increment.
 */
admin.get("/transactions/:id", async (c) => {
  const orderId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: order, error } = await supabase
    .from("orders")
    .select(
      "*, listings!orders_listing_id_fkey(id, title, listing_photos(url, position)), " +
        "buyer:profiles!orders_buyer_id_fkey(id, display_name, email, location), " +
        "seller:profiles!orders_seller_id_fkey(id, display_name, email, location)"
    )
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return c.json({ error: "Transaction not found" }, 404);
  }
  const o = order as unknown as Record<string, unknown>;

  const money = {
    sale: o.amount,
    item: o.item_amount ?? null,
    shipping: o.shipping_amount ?? null,
    voucher_discount: o.voucher_discount ?? null,
    commission_rate: o.commission_rate ?? null,
    commission: o.commission_amount ?? null,
    seller_payout: o.seller_payout ?? null,
    currency: o.currency,
    charge_id: o.stripe_payment_intent_id ?? null,
    note: "Stripe processing fee is handled by Stripe and not stored here.",
  };

  const shipment = {
    carrier: o.shipping_carrier ?? null,
    tracking: o.shipping_tracking_number ?? null,
    receipt_photo: o.shipping_receipt_photo_url ?? null,
    shipped_at: o.shipped_at ?? null,
    delivery_method: o.delivery_method ?? null,
  };

  // Reverse-chronological timeline built from the order's timestamps.
  const events: Array<{ at: string; event: string }> = [];
  const push = (at: unknown, event: string) => {
    if (at) events.push({ at: at as string, event });
  };
  push(o.created_at, "Order placed / paid");
  push(o.seller_accepted_at, "Seller accepted");
  push(o.shipped_at, "Shipped");
  push(o.delivered_at, "Delivered");
  push(o.completed_at, "Completed");
  if (o.status === "cancelled") push(o.updated_at, "Cancelled / refunded");
  const timeline = events.sort((a, b) => b.at.localeCompare(a.at));

  return c.json({ transaction: order, money, shipment, timeline });
});

// The forward order lifecycle. force-advance steps to the next state.
const ORDER_PROGRESSION = ["paid", "shipped", "delivered", "complete"] as const;

/**
 * POST /api/admin/transactions/:id/refund
 * Refund the buyer (Screen 08). Requires a reason, calls Stripe, cancels
 * the payout ledger row, frees a still-reserved listing, notifies the
 * buyer, and writes the audit trail. (Role-gating arrives with Phase 0.2.)
 */
admin.post("/transactions/:id/refund", requireAdminPermission("transactions.refund"), async (c) => {
  const orderId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const parsed = z
    .object({ reason: z.string().min(1, "A refund reason is required").max(1000) })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }
  const { reason } = parsed.data;

  const { data: orderRow, error } = await supabase
    .from("orders")
    .select(
      "id, status, stripe_payment_intent_id, listing_id, buyer_id, currency, amount, " +
        "listings!orders_listing_id_fkey(title)"
    )
    .eq("id", orderId)
    .single();
  if (error || !orderRow) return c.json({ error: "Transaction not found" }, 404);
  const order = orderRow as unknown as Record<string, unknown>;

  if (order.status === "cancelled") {
    return c.json({ error: "Order is already cancelled/refunded" }, 400);
  }
  if (!order.stripe_payment_intent_id) {
    return c.json({ error: "Order has no payment to refund" }, 400);
  }

  // Refund via Stripe first — if this throws, we do NOT flip the order.
  let refund;
  try {
    refund = await refundOrderPayment(order.stripe_payment_intent_id as string);
  } catch (err) {
    console.error("[admin] Refund failed:", err);
    return c.json({ error: "Stripe refund failed" }, 502);
  }

  const priorStatus = order.status as string;
  await supabase
    .from("orders")
    .update({
      status: "cancelled",
      seller_rejection_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  // Free the listing if it's still reserved (unshipped); leave sold items alone.
  await supabase
    .from("listings")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", order.listing_id as string)
    .eq("status", "reserved");

  await cancelPayoutForOrder(orderId, `Refunded by admin: ${reason}`);

  const listingTitle =
    ((order.listings as Record<string, unknown> | null)?.title as string) || "your item";
  if (order.buyer_id) {
    createNotification({
      user_id: order.buyer_id as string,
      type: "order_rejected",
      ...orderRejectedNotification(listingTitle, reason),
      data: { order_id: orderId, listing_id: order.listing_id, role: "buyer" },
    }).catch((e) => console.error("[admin] Refund notification error:", e));
  }

  void auditFromContext(c, {
    action: "transaction.refund",
    targetType: "order",
    targetId: orderId,
    reason,
    metadata: {
      refund_id: refund.id,
      amount: order.amount,
      currency: order.currency,
      prior_status: priorStatus,
    },
  });

  return c.json({ success: true, refund_id: refund.id });
});

/**
 * POST /api/admin/transactions/:id/mark-delivered
 * Operator marks an order delivered (Screen 08). Allowed from paid/shipped.
 */
admin.post("/transactions/:id/mark-delivered", async (c) => {
  const orderId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: orderRow, error } = await supabase
    .from("orders")
    .select("id, status, seller_id, listing_id, listings!orders_listing_id_fkey(title)")
    .eq("id", orderId)
    .single();
  if (error || !orderRow) return c.json({ error: "Transaction not found" }, 404);
  const order = orderRow as unknown as Record<string, unknown>;

  if (!["paid", "shipped"].includes(order.status as string)) {
    return c.json(
      { error: `Cannot mark delivered from '${order.status}'` },
      400
    );
  }

  const now = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("orders")
    .update({ status: "delivered", delivered_at: now, updated_at: now })
    .eq("id", orderId);
  if (updErr) {
    console.error("[admin] mark-delivered failed:", updErr);
    return c.json({ error: "Failed to mark delivered" }, 500);
  }

  const listingTitle =
    ((order.listings as Record<string, unknown> | null)?.title as string) || "the item";
  if (order.seller_id) {
    createNotification({
      user_id: order.seller_id as string,
      type: "order_delivered",
      ...orderDeliveredNotification(listingTitle),
      data: { order_id: orderId, listing_id: order.listing_id, role: "seller" },
    }).catch((e) => console.error("[admin] Delivered notification error:", e));
  }

  void auditFromContext(c, {
    action: "transaction.mark_delivered",
    targetType: "order",
    targetId: orderId,
    metadata: { from: order.status },
  });

  return c.json({ success: true });
});

/**
 * POST /api/admin/transactions/:id/force-advance
 * Operator override that steps the order to the next lifecycle state
 * (paid → shipped → delivered → complete). Requires a reason, audited.
 * Advancing to `complete` releases the seller payout (mirrors normal
 * completion). (Role-gating arrives with Phase 0.2.)
 */
admin.post("/transactions/:id/force-advance", requireAdminPermission("transactions.force_advance"), async (c) => {
  const orderId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const parsed = z
    .object({ reason: z.string().min(1, "A reason is required").max(1000) })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }
  const { reason } = parsed.data;

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, status, seller_id, listing_id")
    .eq("id", orderId)
    .single();
  if (error || !order) return c.json({ error: "Transaction not found" }, 404);

  const idx = ORDER_PROGRESSION.indexOf(order.status as (typeof ORDER_PROGRESSION)[number]);
  if (idx === -1 || idx >= ORDER_PROGRESSION.length - 1) {
    return c.json(
      { error: `Cannot advance from '${order.status}' (terminal or off-lifecycle)` },
      400
    );
  }
  const nextStatus = ORDER_PROGRESSION[idx + 1];

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status: nextStatus, updated_at: now };
  if (nextStatus === "shipped") {
    updates.shipped_at = now;
    updates.auto_complete_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  } else if (nextStatus === "delivered") {
    updates.delivered_at = now;
  } else if (nextStatus === "complete") {
    updates.completed_at = now;
  }

  const { error: updErr } = await supabase.from("orders").update(updates).eq("id", orderId);
  if (updErr) {
    console.error("[admin] force-advance failed:", updErr);
    return c.json({ error: "Failed to advance order" }, 500);
  }

  // Advancing to complete releases the seller payout, same as normal completion.
  if (nextStatus === "complete") {
    releasePayoutForOrder(orderId).catch((e) =>
      console.error("[admin] force-advance payout release failed:", e)
    );
  }

  void auditFromContext(c, {
    action: "transaction.force_advance",
    targetType: "order",
    targetId: orderId,
    reason,
    metadata: { from: order.status, to: nextStatus },
  });

  return c.json({ success: true, status: nextStatus });
});

/**
 * GET /api/admin/offers/:id
 * Read-only offer-thread oversight (Screen 09): the full round history for
 * this listing+buyer, both parties, outcome, and the lowest offer.
 */
admin.get("/offers/:id", async (c) => {
  const offerId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: offer, error } = await supabase
    .from("offers")
    .select(
      "*, listings!offers_listing_id_fkey(id, title), " +
        "buyer:profiles!offers_buyer_id_fkey(id, display_name), " +
        "seller:profiles!offers_seller_id_fkey(id, display_name)"
    )
    .eq("id", offerId)
    .single();

  if (error || !offer) {
    return c.json({ error: "Offer not found" }, 404);
  }
  const of = offer as unknown as Record<string, unknown>;

  // The full negotiation = every offer on this listing from this buyer,
  // in round order (each counter is a new row, offered_by = buyer|seller).
  const { data: thread } = await supabase
    .from("offers")
    .select("id, amount, currency, status, round, offered_by, message, created_at")
    .eq("listing_id", of.listing_id as string)
    .eq("buyer_id", of.buyer_id as string)
    .order("round", { ascending: true })
    .order("created_at", { ascending: true });

  const amounts = (thread ?? []).map((t) => (t as Record<string, unknown>).amount as number);
  const lowest = amounts.length ? Math.min(...amounts) : (of.amount as number);

  return c.json({
    offer,
    thread: thread ?? [],
    outcome: of.status,
    lowest_offer: lowest,
  });
});

// ============================================================
// Moderation: message hold/publish + reviews (Phase 3) — Screens 14/15
// ============================================================

/**
 * POST /api/admin/moderation/publish
 * Release a held message so the recipient can see it. (Reject = keep hidden
 * uses the existing /moderation/redact, or set moderation_hidden below.)
 */
admin.post("/moderation/publish", requireAdminPermission("moderation.act"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({ message_id: z.string().uuid(), action: z.enum(["publish", "hide"]).default("publish") })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { message_id, action } = parsed.data;

  const { data, error } = await supabase
    .from("messages")
    .update({
      moderation_hold: false,
      moderation_hidden: action === "hide",
      moderated_by: c.get("adminProfileId"),
      moderated_at: new Date().toISOString(),
    })
    .eq("id", message_id)
    .select("id, conversation_id")
    .single();
  if (error || !data) return c.json({ error: "Message not found" }, 404);

  // Resolve any pending flag on this message.
  await supabase
    .from("fraud_flags")
    .update({ status: "reviewed", reviewed_at: new Date().toISOString() })
    .eq("entity_type", "message")
    .eq("entity_id", message_id)
    .eq("status", "pending");

  void auditFromContext(c, {
    action: action === "publish" ? "moderation.message_publish" : "moderation.message_redact",
    targetType: "message",
    targetId: message_id,
  });
  return c.json({ success: true });
});

/**
 * GET /api/admin/reviews/flagged
 * Reviews flagged by a seller or auto-detected, not yet hidden.
 */
admin.get("/reviews/flagged", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("reviews")
    .select(
      "id, rating, comment, reviewer_role, flagged_at, flag_reason, flag_source, dispute_status, created_at, " +
        "reviewer:profiles!reviews_reviewer_id_fkey(id, display_name), " +
        "reviewee:profiles!reviews_reviewee_id_fkey(id, display_name)"
    )
    .not("flagged_at", "is", null)
    .is("hidden_at", null)
    .order("flagged_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("Error loading flagged reviews:", error);
    return c.json({ error: "Failed to load flagged reviews" }, 500);
  }
  return c.json({ reviews: data ?? [] });
});

/**
 * POST /api/admin/reviews/:id/hide
 * Hide a review from the public profile (kept on record + audit).
 */
admin.post("/reviews/:id/hide", requireAdminPermission("moderation.act"), async (c) => {
  const reviewId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z.object({ reason: z.string().max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason : undefined;

  const { data, error } = await supabase
    .from("reviews")
    .update({
      hidden_at: new Date().toISOString(),
      hidden_by: c.get("adminProfileId"),
      visible: false,
    })
    .eq("id", reviewId)
    .select("id")
    .single();
  if (error || !data) return c.json({ error: "Review not found" }, 404);

  void auditFromContext(c, {
    action: "review.hide",
    targetType: "review",
    targetId: reviewId,
    reason: reason ?? null,
  });
  return c.json({ success: true });
});

/**
 * POST /api/admin/reviews/:id/dispute
 * Open or resolve an in-console dispute on a review.
 */
admin.post("/reviews/:id/dispute", requireAdminPermission("moderation.act"), async (c) => {
  const reviewId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({ status: z.enum(["open", "resolved"]), note: z.string().max(1000).optional() })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data, error } = await supabase
    .from("reviews")
    .update({ dispute_status: parsed.data.status })
    .eq("id", reviewId)
    .select("id")
    .single();
  if (error || !data) return c.json({ error: "Review not found" }, 404);

  void auditFromContext(c, {
    action: "review.dispute",
    targetType: "review",
    targetId: reviewId,
    reason: parsed.data.note ?? null,
    metadata: { status: parsed.data.status },
  });
  return c.json({ success: true });
});

// ============================================================
// User record (Phase 2) — Screens 11/12
// ============================================================

/**
 * GET /api/admin/users/:id
 * Full user record: profile + payout setup + seller_quality + cross-linked
 * counts (listings, purchases, sales, reviews) + referral code.
 */
admin.get("/users/:id", async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error || !profile) return c.json({ error: "User not found" }, 404);

  const [listings, purchases, sales, reviews, refCode] = await Promise.all([
    supabase.from("listings").select("id", { count: "exact", head: true }).eq("seller_id", userId),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("buyer_id", userId),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("seller_id", userId),
    supabase.from("reviews").select("id", { count: "exact", head: true }).eq("reviewee_id", userId),
    supabase.from("referral_codes").select("code, disabled").eq("user_id", userId).maybeSingle(),
  ]);

  const p = profile as Record<string, unknown>;
  return c.json({
    user: profile,
    verification: {
      stripe_status: p.stripe_onboarding_complete
        ? "complete"
        : p.stripe_account_id
          ? "incomplete"
          : "not_connected",
    },
    seller_quality: p.seller_quality ?? null,
    counts: {
      listings: listings.count ?? 0,
      purchases: purchases.count ?? 0,
      sales: sales.count ?? 0,
      reviews: reviews.count ?? 0,
    },
    referral_code: refCode.data ?? null,
  });
});

/**
 * PATCH /api/admin/users/:id
 * Edit account details (audited). Limited to safe display fields.
 */
admin.patch("/users/:id", requireAdminPermission("users.ban"), async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      display_name: z.string().min(1).max(120).optional(),
      location: z.enum(["AU", "US", "NZ", "CA", "GB"]).nullable().optional(),
      bio: z.string().max(1000).nullable().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;
  if (Object.keys(updates).length === 0) return c.json({ error: "No fields to update" }, 400);

  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select("id, display_name, location, bio")
    .single();
  if (error || !data) return c.json({ error: "User not found" }, 404);

  void auditFromContext(c, {
    action: "user.edit",
    targetType: "user",
    targetId: userId,
    metadata: { changes: updates },
  });
  return c.json({ user: data });
});

/**
 * POST /api/admin/users/:id/reset-password
 * Revoke the user's Clerk sessions (force re-auth everywhere). Emailing a
 * reset link is a Clerk client flow; this is the server-side security action.
 */
admin.post("/users/:id/reset-password", requireAdminPermission("users.ban"), async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data: profile } = await supabase
    .from("profiles")
    .select("clerk_id")
    .eq("id", userId)
    .single();
  if (!profile?.clerk_id) return c.json({ error: "User has no Clerk account" }, 404);

  let revoked = 0;
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY || "" });
    const sessions = await clerk.sessions.getSessionList({ userId: profile.clerk_id as string });
    const list = (Array.isArray(sessions) ? sessions : sessions.data) as Array<{ id: string }>;
    for (const s of list) {
      await clerk.sessions.revokeSession(s.id).catch(() => {});
      revoked += 1;
    }
  } catch (err) {
    console.error("[admin] reset-password (revoke sessions) failed:", err);
    return c.json({ error: "Failed to revoke sessions" }, 500);
  }

  void auditFromContext(c, {
    action: "user.reset_password",
    targetType: "user",
    targetId: userId,
    metadata: { sessions_revoked: revoked },
  });
  return c.json({ success: true, sessions_revoked: revoked });
});

/**
 * POST /api/admin/users/:id/mask
 * Mint a Clerk sign-in token so the operator can act AS this user
 * (impersonation). Sensitive — role-gated + audited.
 */
admin.post("/users/:id/mask", requireAdminPermission("users.mask"), async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data: profile } = await supabase
    .from("profiles")
    .select("clerk_id")
    .eq("id", userId)
    .single();
  if (!profile?.clerk_id) return c.json({ error: "User has no Clerk account" }, 404);

  let token: string | null = null;
  try {
    const { createClerkClient } = await import("@clerk/backend");
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY || "" });
    const signIn = await clerk.signInTokens.createSignInToken({
      userId: profile.clerk_id as string,
      expiresInSeconds: 600,
    });
    token = signIn.token;
  } catch (err) {
    console.error("[admin] mask (sign-in token) failed:", err);
    return c.json({ error: "Failed to create mask token" }, 500);
  }

  void auditFromContext(c, {
    action: "user.mask",
    targetType: "user",
    targetId: userId,
  });
  return c.json({ sign_in_token: token, expires_in_seconds: 600 });
});

/**
 * DELETE /api/admin/users/:id
 * Permanent delete — owner only. Removes the profile (cascades their data)
 * and the Clerk account. Danger zone, always audited.
 */
admin.delete("/users/:id", requireAdminPermission("users.delete"), async (c) => {
  const userId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, clerk_id, email")
    .eq("id", userId)
    .single();
  if (!profile) return c.json({ error: "User not found" }, 404);

  // Delete the Clerk account first (best-effort), then the profile (cascades).
  if (profile.clerk_id) {
    try {
      const { createClerkClient } = await import("@clerk/backend");
      const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY || "" });
      await clerk.users.deleteUser(profile.clerk_id as string);
    } catch (err) {
      console.error("[admin] delete Clerk user failed (continuing):", err);
    }
  }

  const { error } = await supabase.from("profiles").delete().eq("id", userId);
  if (error) {
    console.error("[admin] user delete failed:", error);
    return c.json({ error: "Failed to delete user" }, 500);
  }

  void auditFromContext(c, {
    action: "user.delete",
    targetType: "user",
    targetId: userId,
    metadata: { email: profile.email, clerk_id: profile.clerk_id },
  });
  return c.json({ success: true });
});

// ============================================================
// Referrals dashboard (Phase 2) — Screen 13
// ============================================================

/**
 * GET /api/admin/referrals
 * Metrics (active codes, referral signups 30d, conversion, reward issued)
 * + the code table.
 */
admin.get("/referrals", async (c) => {
  const supabase = createSupabaseAdmin();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5).toISOString();

  const [activeCodes, signups30d, converted, codes] = await Promise.all([
    supabase.from("referral_codes").select("id", { count: "exact", head: true }).eq("disabled", false),
    supabase.from("referrals").select("id", { count: "exact", head: true }).gte("created_at", thirtyDaysAgo),
    supabase.from("referrals").select("id", { count: "exact", head: true }).eq("status", "qualified"),
    supabase
      .from("referral_codes")
      .select("id, code, code_type, campaign_name, user_id, disabled, created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  const { count: totalRefs } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true });
  const conversion =
    (totalRefs ?? 0) > 0 ? Math.round(((converted.count ?? 0) / (totalRefs ?? 1)) * 100) : 0;

  return c.json({
    metrics: {
      active_codes: activeCodes.count ?? 0,
      signups_30d: signups30d.count ?? 0,
      conversion_pct: conversion,
      qualified_total: converted.count ?? 0,
    },
    codes: codes.data ?? [],
  });
});

/**
 * POST /api/admin/referrals/campaign
 * Mint a one-off campaign code (no owner). User/influencer codes still
 * auto-issue on signup.
 */
admin.post("/referrals/campaign", async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      code: z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/),
      campaign_name: z.string().min(1).max(120),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data, error } = await supabase
    .from("referral_codes")
    .insert({
      user_id: null,
      code: parsed.data.code.toUpperCase(),
      code_type: "campaign",
      campaign_name: parsed.data.campaign_name,
      disabled: false,
    })
    .select("id, code, code_type, campaign_name")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "That code already exists" }, 409);
    }
    console.error("Error creating campaign code:", error);
    return c.json({ error: "Failed to create campaign code" }, 500);
  }

  void auditFromContext(c, {
    action: "referral.enable",
    targetType: "referral",
    targetId: (data as Record<string, unknown>).id as string,
    metadata: { op: "campaign_create", code: data.code, campaign: parsed.data.campaign_name },
  });
  return c.json({ code: data }, 201);
});

// ============================================================
// Dashboard honest metrics (Phase 6) — Screen 01
// Two live counters + the "nine metrics" (Health / Leaks / Growth). Two of
// the leak metrics (inquiry→purchase, seller response rate) are stubbed
// null pending inquiry/response tracking + a definition sign-off (§8.2).
// ============================================================

admin.get("/dashboard/metrics", async (c) => {
  if (!hasDirectDb()) return c.json({ error: "Service unavailable" }, 503);
  const sql = getSql();

  try {
    const [counters] = await sql`
      SELECT
        (SELECT COUNT(*) FROM listings WHERE status = 'active')::int AS active_listings,
        (SELECT COUNT(*) FROM profiles)::int AS total_users`;

    const [health] = await sql`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status <> 'cancelled'), 0)::bigint AS gmv,
        COALESCE(SUM(commission_amount) FILTER (WHERE status <> 'cancelled' AND created_at >= NOW() - INTERVAL '7 days'), 0)::bigint AS revenue_this_week,
        COUNT(*) FILTER (WHERE status <> 'cancelled' AND created_at >= NOW() - INTERVAL '7 days')::int AS weekly_orders,
        COUNT(DISTINCT buyer_id)::int AS distinct_buyers,
        COUNT(DISTINCT seller_id)::int AS distinct_sellers
      FROM orders`;

    const [liquidity] = await sql`
      SELECT
        ROUND(
          COUNT(*) FILTER (WHERE status = 'sold')::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )::float AS liquidity_rate
      FROM listings
      WHERE created_at <= NOW() - INTERVAL '90 days'`;

    const [stripe] = await sql`
      SELECT
        ROUND(
          COUNT(*) FILTER (WHERE stripe_onboarding_complete)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )::float AS stripe_activation
      FROM profiles
      WHERE id IN (SELECT DISTINCT seller_id FROM listings)`;

    const [growth] = await sql`
      SELECT
        (SELECT COUNT(*) FROM (
           SELECT buyer_id FROM orders GROUP BY buyer_id
           HAVING MIN(created_at) >= NOW() - INTERVAL '30 days'
         ) t)::int AS new_buyers,
        (SELECT COUNT(DISTINCT buyer_id) FROM orders
           WHERE created_at >= NOW() - INTERVAL '30 days')::int AS active_buyers`;

    const buyersPerSeller =
      health.distinct_sellers > 0
        ? Math.round((health.distinct_buyers / health.distinct_sellers) * 100) / 100
        : 0;

    return c.json({
      counters: {
        active_listings: counters.active_listings,
        total_users: counters.total_users,
      },
      metrics: {
        health: {
          gmv: Number(health.gmv),
          revenue_this_week: Number(health.revenue_this_week),
          weekly_orders: health.weekly_orders,
          buyers_per_seller: buyersPerSeller,
          liquidity_rate: liquidity.liquidity_rate ?? 0,
        },
        leaks: {
          // Stubbed — need inquiry logging + a confirmed definition (§8.2).
          inquiry_to_purchase: null,
          seller_response_rate: null,
          stripe_activation: stripe.stripe_activation ?? 0,
        },
        growth: {
          new_buyers: growth.new_buyers,
          active_buyers: growth.active_buyers,
        },
      },
      note:
        "inquiry_to_purchase + seller_response_rate are pending inquiry/response tracking and definition sign-off (§8.2).",
    });
  } catch (err) {
    console.error("[admin] dashboard metrics failed:", err);
    return c.json({ error: "Failed to compute metrics" }, 500);
  }
});

// ============================================================
// Content suite (Phase 5) — Screens 16–19
// Push copy, email templates, website/help pages, blog. content.edit gated.
// ============================================================

// ---- Push notifications (Screen 16) ----
admin.get("/content/push", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase
    .from("push_campaigns")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  return c.json({ campaigns: data ?? [] });
});

admin.post("/content/push", requireAdminPermission("content.edit"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(500),
      deep_link: z.string().max(300).optional(),
      audience: z.object({ market: z.string().optional(), segment: z.string().optional() }).optional(),
      scheduled_at: z.string().datetime().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { data, error } = await supabase
    .from("push_campaigns")
    .insert({
      title: parsed.data.title,
      body: parsed.data.body,
      deep_link: parsed.data.deep_link ?? null,
      audience: parsed.data.audience ?? {},
      status: parsed.data.scheduled_at ? "scheduled" : "draft",
      scheduled_at: parsed.data.scheduled_at ?? null,
      created_by: c.get("adminProfileId"),
    })
    .select("*")
    .single();
  if (error) return c.json({ error: "Failed to create push" }, 500);
  return c.json({ campaign: data }, 201);
});

admin.post("/content/push/:id/send", requireAdminPermission("content.edit"), async (c) => {
  const id = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data: camp } = await supabase.from("push_campaigns").select("*").eq("id", id).single();
  if (!camp) return c.json({ error: "Campaign not found" }, 404);
  if (camp.status === "sent") return c.json({ error: "Already sent" }, 400);

  const appId = process.env.ONESIGNAL_APP_ID;
  const restKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !restKey) {
    return c.json({ error: "OneSignal not configured" }, 503);
  }

  // Broadcast to subscribed users. Market/segment targeting can be refined
  // later via OneSignal tag filters once devices carry a market tag.
  let onesignalId: string | null = null;
  try {
    const payload: Record<string, unknown> = {
      app_id: appId,
      included_segments: ["Subscribed Users"],
      headings: { en: camp.title },
      contents: { en: camp.body },
    };
    if (camp.deep_link) payload.url = camp.deep_link;
    const res = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${restKey}` },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { id?: string; errors?: unknown };
    if (!res.ok) {
      console.error("[admin] push send failed:", json);
      return c.json({ error: "Push send failed" }, 502);
    }
    onesignalId = json.id ?? null;
  } catch (err) {
    console.error("[admin] push send error:", err);
    return c.json({ error: "Push send failed" }, 502);
  }

  await supabase
    .from("push_campaigns")
    .update({ status: "sent", sent_at: new Date().toISOString(), onesignal_id: onesignalId })
    .eq("id", id);

  void auditFromContext(c, {
    action: "content.publish",
    targetType: "content",
    targetId: id,
    metadata: { kind: "push", onesignal_id: onesignalId },
  });
  return c.json({ success: true, onesignal_id: onesignalId });
});

// ---- Email templates (Screen 17) ----
admin.get("/content/email-templates", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase
    .from("email_templates")
    .select("id, key, subject, version, updated_at")
    .order("key", { ascending: true });
  return c.json({ templates: data ?? [] });
});

admin.get("/content/email-templates/:key", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("email_templates")
    .select("*")
    .eq("key", c.req.param("key"))
    .maybeSingle();
  if (error) return c.json({ error: "Failed to load template" }, 500);
  return c.json({ template: data });
});

admin.put("/content/email-templates/:key", requireAdminPermission("content.edit"), async (c) => {
  const key = c.req.param("key");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      subject: z.string().min(1).max(300),
      heading: z.string().max(300).optional(),
      body: z.string().min(1),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: existing } = await supabase.from("email_templates").select("*").eq("key", key).maybeSingle();
  let result;
  if (existing) {
    // Snapshot the current version before overwriting (rollback support).
    await supabase.from("email_template_versions").insert({
      template_id: existing.id,
      version: existing.version,
      subject: existing.subject,
      heading: existing.heading,
      body: existing.body,
      created_by: c.get("adminProfileId"),
    });
    const { data } = await supabase
      .from("email_templates")
      .update({
        subject: parsed.data.subject,
        heading: parsed.data.heading ?? null,
        body: parsed.data.body,
        version: (existing.version as number) + 1,
        updated_by: c.get("adminProfileId"),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    result = data;
  } else {
    const { data } = await supabase
      .from("email_templates")
      .insert({
        key,
        subject: parsed.data.subject,
        heading: parsed.data.heading ?? null,
        body: parsed.data.body,
        updated_by: c.get("adminProfileId"),
      })
      .select("*")
      .single();
    result = data;
  }

  void auditFromContext(c, {
    action: "content.publish",
    targetType: "content",
    targetId: key,
    metadata: { kind: "email_template" },
  });
  return c.json({ template: result });
});

admin.get("/content/email-templates/:key/versions", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data: tpl } = await supabase.from("email_templates").select("id").eq("key", c.req.param("key")).maybeSingle();
  if (!tpl) return c.json({ versions: [] });
  const { data } = await supabase
    .from("email_template_versions")
    .select("version, subject, heading, created_at")
    .eq("template_id", tpl.id)
    .order("version", { ascending: false });
  return c.json({ versions: data ?? [] });
});

admin.post("/content/email-templates/:key/rollback", requireAdminPermission("content.edit"), async (c) => {
  const key = c.req.param("key");
  const supabase = createSupabaseAdmin();
  const parsed = z.object({ version: z.number().int().positive() }).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "version required" }, 400);

  const { data: tpl } = await supabase.from("email_templates").select("*").eq("key", key).single();
  if (!tpl) return c.json({ error: "Template not found" }, 404);
  const { data: snap } = await supabase
    .from("email_template_versions")
    .select("*")
    .eq("template_id", tpl.id)
    .eq("version", parsed.data.version)
    .single();
  if (!snap) return c.json({ error: "Version not found" }, 404);

  // Snapshot current, then restore the target snapshot as a new version.
  await supabase.from("email_template_versions").insert({
    template_id: tpl.id,
    version: tpl.version,
    subject: tpl.subject,
    heading: tpl.heading,
    body: tpl.body,
    created_by: c.get("adminProfileId"),
  });
  const { data } = await supabase
    .from("email_templates")
    .update({
      subject: snap.subject,
      heading: snap.heading,
      body: snap.body,
      version: (tpl.version as number) + 1,
      updated_by: c.get("adminProfileId"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tpl.id)
    .select("*")
    .single();

  void auditFromContext(c, {
    action: "content.publish",
    targetType: "content",
    targetId: key,
    metadata: { kind: "email_template", rolled_back_to: parsed.data.version },
  });
  return c.json({ template: data });
});

// ---- Website / help pages (Screen 18) ----
admin.get("/content/pages", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase
    .from("website_pages")
    .select("id, slug, title, status, version, published_at, updated_at")
    .order("slug", { ascending: true });
  return c.json({ pages: data ?? [] });
});

admin.get("/content/pages/:id", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase.from("website_pages").select("*").eq("id", c.req.param("id")).maybeSingle();
  if (!data) return c.json({ error: "Page not found" }, 404);
  return c.json({ page: data });
});

admin.post("/content/pages", requireAdminPermission("content.edit"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
      title: z.string().min(1).max(200),
      body_md: z.string().default(""),
      seo_title: z.string().max(200).optional(),
      seo_description: z.string().max(400).optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { data, error } = await supabase
    .from("website_pages")
    .insert({ ...parsed.data, updated_by: c.get("adminProfileId") })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return c.json({ error: "Slug already exists" }, 409);
    return c.json({ error: "Failed to create page" }, 500);
  }
  return c.json({ page: data }, 201);
});

admin.put("/content/pages/:id", requireAdminPermission("content.edit"), async (c) => {
  const id = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      title: z.string().min(1).max(200).optional(),
      body_md: z.string().optional(),
      seo_title: z.string().max(200).nullable().optional(),
      seo_description: z.string().max(400).nullable().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { data: existing } = await supabase.from("website_pages").select("*").eq("id", id).maybeSingle();
  if (!existing) return c.json({ error: "Page not found" }, 404);

  // Snapshot the current version.
  await supabase.from("website_page_versions").insert({
    page_id: id,
    version: existing.version,
    title: existing.title,
    body_md: existing.body_md,
    created_by: c.get("adminProfileId"),
  });
  const updates: Record<string, unknown> = {
    version: (existing.version as number) + 1,
    updated_by: c.get("adminProfileId"),
    updated_at: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;

  const { data } = await supabase.from("website_pages").update(updates).eq("id", id).select("*").single();
  void auditFromContext(c, { action: "content.publish", targetType: "content", targetId: id, metadata: { kind: "page_edit" } });
  return c.json({ page: data });
});

admin.post("/content/pages/:id/publish", requireAdminPermission("content.edit"), async (c) => {
  const id = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("website_pages")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, slug, status")
    .single();
  if (error || !data) return c.json({ error: "Page not found" }, 404);
  void auditFromContext(c, { action: "content.publish", targetType: "content", targetId: id, metadata: { kind: "page_publish", slug: data.slug } });
  return c.json({ page: data });
});

// ---- Blog (Screen 19) ----
admin.get("/content/blog", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data } = await supabase
    .from("blog_posts")
    .select("id, slug, title, status, tags, scheduled_at, published_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);
  return c.json({ posts: data ?? [] });
});

admin.post("/content/blog", requireAdminPermission("content.edit"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/),
      title: z.string().min(1).max(200),
      body_md: z.string().default(""),
      cover_image_url: z.string().url().optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
      scheduled_at: z.string().datetime().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const { data, error } = await supabase
    .from("blog_posts")
    .insert({
      slug: parsed.data.slug,
      title: parsed.data.title,
      body_md: parsed.data.body_md,
      cover_image_url: parsed.data.cover_image_url ?? null,
      tags: parsed.data.tags ?? [],
      status: parsed.data.scheduled_at ? "scheduled" : "draft",
      scheduled_at: parsed.data.scheduled_at ?? null,
      created_by: c.get("adminProfileId"),
    })
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") return c.json({ error: "Slug already exists" }, 409);
    return c.json({ error: "Failed to create post" }, 500);
  }
  return c.json({ post: data }, 201);
});

admin.put("/content/blog/:id", requireAdminPermission("content.edit"), async (c) => {
  const id = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      title: z.string().min(1).max(200).optional(),
      body_md: z.string().optional(),
      cover_image_url: z.string().url().nullable().optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;
  const { data, error } = await supabase.from("blog_posts").update(updates).eq("id", id).select("*").single();
  if (error || !data) return c.json({ error: "Post not found" }, 404);
  return c.json({ post: data });
});

admin.post("/content/blog/:id/publish", requireAdminPermission("content.edit"), async (c) => {
  const id = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("blog_posts")
    .update({ status: "published", published_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, slug, status")
    .single();
  if (error || !data) return c.json({ error: "Post not found" }, 404);
  void auditFromContext(c, { action: "content.publish", targetType: "content", targetId: id, metadata: { kind: "blog", slug: data.slug } });
  return c.json({ post: data });
});

// ============================================================
// Taxonomy (Phase 6) — Screen 20 (unified vocabularies)
// ============================================================

/**
 * GET /api/admin/config/taxonomy
 * All five vocabularies in one payload with listing counts. Categories +
 * editorial tags are DB-managed (CRUD elsewhere); sizes/occasions/curated
 * are code-locked enums (surfaced read-only with counts); designers are
 * their own large table (count + managed via /api/designers typeahead).
 */
admin.get("/config/taxonomy", async (c) => {
  const supabase = createSupabaseAdmin();

  const [categories, editorialTags, sizeRows, curatedCounts, designerCount] =
    await Promise.all([
      supabase.from("categories").select("*").order("display_order", { ascending: true }),
      supabase.from("editorial_tags").select("*").order("name", { ascending: true }),
      supabase.from("listings").select("estimated_size").eq("status", "active"),
      // curation_tags is an array column — count via containment.
      (async () => {
        const out: Record<string, number> = {};
        await Promise.all(
          (CURATION_TAGS as readonly string[]).map(async (t) => {
            const { count } = await supabase
              .from("listings")
              .select("id", { count: "exact", head: true })
              .contains("curation_tags", [t])
              .eq("status", "active");
            out[t] = count ?? 0;
          })
        );
        return out;
      })(),
      supabase.from("designers").select("id", { count: "exact", head: true }),
    ]);

  // Size counts from the active listings' estimated_size values.
  const sizeCounts: Record<string, number> = {};
  for (const r of (sizeRows.data ?? []) as Array<{ estimated_size: string | null }>) {
    const s = r.estimated_size;
    if (s) sizeCounts[s] = (sizeCounts[s] ?? 0) + 1;
  }

  return c.json({
    vocabularies: {
      categories: { managed: true, values: categories.data ?? [] },
      editorial_tags: { managed: true, values: editorialTags.data ?? [] },
      sizes: { managed: false, locked: true, counts: sizeCounts },
      occasions: {
        managed: false,
        locked: true,
        values: OCCASION_TAGS,
      },
      curated_edits: { managed: false, locked: true, counts: curatedCounts },
      designers: { managed: true, count: designerCount.count ?? 0, via: "/api/designers" },
    },
  });
});

// ============================================================
// Settings policies (Phase 6) — Screen 21
// ============================================================

/**
 * GET /api/admin/settings/policies
 * Commercial levers + core policies (cooling-off, min price, regions, flags).
 */
admin.get("/settings/policies", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_settings")
    .select(
      "commission_rate, cooling_off_days, min_listing_price_cents, active_regions, " +
        "require_receipt_for_designer, no_publish_without_review, hide_fees_from_sellers"
    )
    .limit(1)
    .single();
  if (error) {
    console.error("Error loading policies:", error);
    return c.json({ error: "Failed to load policies" }, 500);
  }
  return c.json({ policies: data });
});

/**
 * PATCH /api/admin/settings/policies
 */
admin.patch("/settings/policies", requireAdminPermission("settings.edit"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      cooling_off_days: z.number().int().min(0).max(60).optional(),
      min_listing_price_cents: z.number().int().min(0).optional(),
      active_regions: z.array(z.enum(["AU", "US", "NZ", "CA", "GB"])).min(1).optional(),
      require_receipt_for_designer: z.boolean().optional(),
      no_publish_without_review: z.boolean().optional(),
      hide_fees_from_sellers: z.boolean().optional(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;
  if (Object.keys(updates).length === 0) return c.json({ error: "No fields to update" }, 400);

  const { data: existing } = await supabase.from("admin_settings").select("id").limit(1).single();
  if (!existing) return c.json({ error: "Settings not found" }, 404);

  const { data, error } = await supabase
    .from("admin_settings")
    .update(updates)
    .eq("id", existing.id)
    .select(
      "cooling_off_days, min_listing_price_cents, active_regions, " +
        "require_receipt_for_designer, no_publish_without_review, hide_fees_from_sellers"
    )
    .single();
  if (error) {
    console.error("Error updating policies:", error);
    return c.json({ error: "Failed to update policies" }, 500);
  }

  void auditFromContext(c, {
    action: "settings.edit",
    targetType: "settings",
    targetId: "policies",
    metadata: updates,
  });
  return c.json({ policies: data });
});

// ============================================================
// Data export (Phase 6) — Screen 24 (CSV, PII-gated, audited)
// ============================================================

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((col) => esc(r[col])).join(",")).join("\n");
  return `${header}\n${body}`;
}

// Non-PII vs PII columns per dataset.
const EXPORT_SPECS: Record<
  string,
  { table: string; base: string[]; pii: string[] }
> = {
  users: {
    table: "profiles",
    base: ["id", "display_name", "location", "created_at", "seller_quality"],
    pii: ["email", "phone"],
  },
  listings: {
    table: "listings",
    base: ["id", "title", "category", "status", "price_amount", "price_currency", "seller_id", "created_at"],
    pii: [],
  },
  transactions: {
    table: "orders",
    base: ["id", "order_number", "status", "amount", "currency", "commission_amount", "seller_payout", "created_at"],
    pii: ["buyer_email"],
  },
};

/**
 * POST /api/admin/export/:dataset
 * CSV export of users | listings | transactions. PII columns are OFF by
 * default and require the `export.pii` permission + ?pii=true. Every export
 * is audited.
 */
admin.post("/export/:dataset", requireAdminPermission("export.run"), async (c) => {
  const dataset = c.req.param("dataset");
  const spec = EXPORT_SPECS[dataset];
  if (!spec) return c.json({ error: "Unknown dataset" }, 400);

  const wantPii = c.req.query("pii") === "true";
  const role = c.get("adminRole") as AdminRole | undefined;
  const override = c.get("adminPermissionsOverride") as { grant?: string[]; deny?: string[] } | null | undefined;
  const piiAllowed = wantPii && hasPermission(role, "export.pii", override);
  const columns = piiAllowed ? [...spec.base, ...spec.pii] : spec.base;

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from(spec.table)
    .select(columns.join(","))
    .limit(50000);
  if (error) {
    console.error("Export query failed:", error);
    return c.json({ error: "Export failed" }, 500);
  }

  const csv = toCsv((data ?? []) as unknown as Record<string, unknown>[], columns);

  void auditFromContext(c, {
    action: "export.run",
    targetType: "export",
    targetId: dataset,
    metadata: { rows: data?.length ?? 0, pii: piiAllowed, requested_pii: wantPii },
  });

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${dataset}-export.csv"`,
    },
  });
});

// ============================================================
// Team & access (Phase 0.2) — Screen 22
// ============================================================

/**
 * GET /api/admin/team
 * List admin members + the role→permission matrix (for the FE to render).
 */
admin.get("/team", async (c) => {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_users")
    .select("id, email, role, status, two_factor_enabled, invited_by, created_at, last_login_at")
    .order("created_at", { ascending: true });
  if (error) {
    console.error("Error loading team:", error);
    return c.json({ error: "Failed to load team" }, 500);
  }
  return c.json({
    members: data ?? [],
    permissions: ADMIN_PERMISSIONS,
    role_matrix: ROLE_PERMISSIONS,
  });
});

/**
 * POST /api/admin/team/invite  (owner only)
 * Pre-provision a member by email + role. They gain access on first login
 * (their supabase_user_id is stamped then). 2FA is enforced separately.
 */
admin.post("/team/invite", requireAdminPermission("team.manage"), async (c) => {
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({
      email: z.string().email(),
      role: z.enum(["admin", "moderator", "support"]),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Invited rows carry a placeholder supabase_user_id until first login
  // stamps the real one (keyed on email in the middleware bootstrap path).
  const { data, error } = await supabase
    .from("admin_users")
    .insert({
      supabase_user_id: crypto.randomUUID(),
      email: parsed.data.email.toLowerCase(),
      role: parsed.data.role,
      status: "invited",
      invited_by: c.get("adminProfileId"),
    })
    .select("id, email, role, status")
    .single();

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "That email is already a team member" }, 409);
    }
    console.error("Error inviting team member:", error);
    return c.json({ error: "Failed to invite member" }, 500);
  }

  void auditFromContext(c, {
    action: "team.invite",
    targetType: "team",
    targetId: (data as Record<string, unknown>).id as string,
    metadata: { email: parsed.data.email, role: parsed.data.role },
  });
  return c.json({ member: data }, 201);
});

/**
 * PATCH /api/admin/team/:id/role  (owner only)
 */
admin.patch("/team/:id/role", requireAdminPermission("team.manage"), async (c) => {
  const memberId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const parsed = z
    .object({ role: z.enum(["owner", "admin", "moderator", "support"]) })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data, error } = await supabase
    .from("admin_users")
    .update({ role: parsed.data.role })
    .eq("id", memberId)
    .select("id, email, role")
    .single();
  if (error || !data) {
    return c.json({ error: "Member not found" }, 404);
  }

  void auditFromContext(c, {
    action: "team.role_change",
    targetType: "team",
    targetId: memberId,
    metadata: { role: parsed.data.role },
  });
  return c.json({ member: data });
});

/**
 * POST /api/admin/team/:id/disable  (owner only)
 */
admin.post("/team/:id/disable", requireAdminPermission("team.manage"), async (c) => {
  const memberId = c.req.param("id");
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("admin_users")
    .update({ status: "disabled" })
    .eq("id", memberId)
    .select("id, email, status")
    .single();
  if (error || !data) return c.json({ error: "Member not found" }, 404);

  void auditFromContext(c, {
    action: "team.role_change",
    targetType: "team",
    targetId: memberId,
    metadata: { status: "disabled" },
  });
  return c.json({ member: data });
});

export default admin;
