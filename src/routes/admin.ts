import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { adminAuthMiddleware } from "../middleware/adminAuth.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  LISTING_STATUSES,
  OCCASION_TAGS,
} from "../types/listings.js";
import {
  createNotification,
  listingApprovedNotification,
  listingRejectedNotification,
  tierUpgradeNotification,
  tierDowngradeNotification,
  followedSellerNewListingNotification,
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
admin.use("/referrals/*", adminAuthMiddleware);
admin.use("/analytics/*", adminAuthMiddleware);
admin.use("/moderation/*", adminAuthMiddleware);
admin.use("/config/*", adminAuthMiddleware);
admin.use("/notification-toggles", adminAuthMiddleware);
admin.use("/notification-toggles/*", adminAuthMiddleware);
admin.use("/sellers/*", adminAuthMiddleware);

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
      "*, listing_photos(*), profiles!listings_seller_id_fkey(display_name, avatar_url, location, stripe_account_id, stripe_onboarding_complete)",
      { count: "exact" }
    )
    .eq("status", "pending_review")
    .order(orderCol, { ascending })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error("Error fetching pending listings:", error);
    return c.json({ error: "Failed to fetch pending listings" }, 500);
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
              data: { listing_id: listingId, seller_id: sellerId },
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.error("[admin] Follower notification error:", err);
      }
    })();
  }

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
      const { data: listing, error: fetchError } = await supabase
        .from("listings")
        .select("*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url, stripe_account_id, stripe_onboarding_complete)")
        .eq("id", id)
        .single();

      if (fetchError || !listing) {
        results.push({ id, success: false, error: "Listing not found" });
        continue;
      }

      if (listing.status !== "pending_review") {
        results.push({ id, success: false, error: `Status is '${listing.status}', not pending_review` });
        continue;
      }

      const seller = listing.profiles as { id: string; clerk_id: string; display_name: string; avatar_url: string; stripe_account_id: string | null; stripe_onboarding_complete: boolean } | null;
      if (action === "approve" && !seller?.stripe_onboarding_complete) {
        results.push({ id, success: false, error: "Seller has not completed Stripe onboarding" });
        continue;
      }

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
          data: { listing_id: id },
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
                    data: { listing_id: id, seller_id: seller.id },
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

  return c.json({ listing: result });
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
});

admin.put("/listings/:id", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = adminUpdateListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("id")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

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

  if (Object.keys(updateData).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
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

  return c.json({ listing: updated });
});

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
        data: { new_tier: change.newTier, old_tier: change.oldTier },
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
        data: { new_tier: change.newTier, old_tier: change.oldTier },
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

  // Create notification for the user
  createNotification({
    user_id: parsed.data.user_id,
    type: "account_suspended",
    title: "Account Suspended",
    body: `Your account has been suspended: ${parsed.data.reason}`,
    data: { reason: parsed.data.reason },
  }).catch((err) => console.error("[admin] Suspension notification error:", err));

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

export default admin;
