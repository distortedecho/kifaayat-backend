import { Hono } from "hono";
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
} from "../lib/notifications.js";

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
    .order(orderCol, { ascending });

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

  return c.json({ listings: result, total: count || 0 });
});

admin.post("/listings/:id/approve", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url, stripe_account_id, stripe_onboarding_complete)")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "pending_review") {
    return c.json({ error: `Cannot approve listing with status '${listing.status}'` }, 400);
  }

  const seller = listing.profiles as { id: string; clerk_id: string; display_name: string; avatar_url: string; stripe_account_id: string | null; stripe_onboarding_complete: boolean } | null;
  if (!seller?.stripe_onboarding_complete) {
    return c.json({ error: "Cannot approve: seller has not completed Stripe onboarding" }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update({ status: "active", rejection_reason: null })
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error approving listing:", updateError);
    return c.json({ error: "Failed to approve listing" }, 500);
  }

  if (seller) {
    const template = listingApprovedNotification(listing.title);
    createNotification({
      user_id: seller.id,
      type: "listing_approved",
      title: template.title,
      body: template.body,
      data: { listing_id: listingId },
    }).catch((err) => console.error("[admin] Notification error:", err));

    const { data: coverPhoto } = await supabase
      .from("listing_photos")
      .select("url")
      .eq("listing_id", listingId)
      .order("position", { ascending: true })
      .limit(1)
      .single();

    sendListingReviewEmail({
      sellerClerkId: seller.clerk_id,
      sellerName: seller.display_name || "Seller",
      listingTitle: listing.title,
      listingPhotoUrl: coverPhoto?.url || "",
      listingId,
      approved: true,
    }).catch((err) => console.error("[admin] Email error:", err));
  }

  return c.json({ listing: updated });
});

admin.post("/listings/:id/reject", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  const bodySchema = z.object({
    reason: z.string().min(1, "Rejection reason is required"),
  });
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  const { reason } = parsed.data;

  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select("*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url)")
    .eq("id", listingId)
    .single();

  if (fetchError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "pending_review") {
    return c.json({ error: `Cannot reject listing with status '${listing.status}'` }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update({ status: "draft", rejection_reason: reason })
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error rejecting listing:", updateError);
    return c.json({ error: "Failed to reject listing" }, 500);
  }

  const seller = listing.profiles as { id: string; clerk_id: string; display_name: string; avatar_url: string } | null;
  if (seller) {
    const template = listingRejectedNotification(listing.title, reason);
    createNotification({
      user_id: seller.id,
      type: "listing_rejected",
      title: template.title,
      body: template.body,
      data: { listing_id: listingId },
    }).catch((err) => console.error("[admin] Notification error:", err));

    const { data: coverPhoto } = await supabase
      .from("listing_photos")
      .select("url")
      .eq("listing_id", listingId)
      .order("position", { ascending: true })
      .limit(1)
      .single();

    sendListingReviewEmail({
      sellerClerkId: seller.clerk_id,
      sellerName: seller.display_name || "Seller",
      listingTitle: listing.title,
      listingPhotoUrl: coverPhoto?.url || "",
      listingId,
      approved: false,
      rejectionReason: reason,
    }).catch((err) => console.error("[admin] Email error:", err));
  }

  return c.json({ listing: updated });
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

  const users = await Promise.all(
    (profiles || []).map(async (profile) => {
      const [listingCount, orderData] = await Promise.all([
        supabase
          .from("listings")
          .select("id", { count: "exact", head: true })
          .eq("seller_id", profile.id),
        supabase
          .from("orders")
          .select("amount")
          .eq("seller_id", profile.id),
      ]);

      const orders = orderData.data || [];
      return {
        ...profile,
        listing_count: listingCount.count || 0,
        order_count: orders.length,
        total_sales_amount: orders.reduce((sum, o) => sum + (o.amount || 0), 0),
      };
    })
  );

  return c.json({ users, total: count || 0, page, limit });
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

// ============================================================
// Dashboard Analytics
// ============================================================

admin.get("/dashboard", async (c) => {
  const supabase = createSupabaseAdmin();
  const rangeDate = parseRange(c.req.query("range"));

  let ordersQuery = supabase.from("orders").select("amount, commission_amount");
  let listingsCreatedQuery = supabase.from("listings").select("id", { count: "exact", head: true });

  if (rangeDate) {
    const rangeISO = rangeDate.toISOString();
    ordersQuery = ordersQuery.gte("created_at", rangeISO);
    listingsCreatedQuery = listingsCreatedQuery.gte("created_at", rangeISO);
  }

  const [ordersResult, listingsCreatedResult, activeListingsResult, pendingResult, usersResult] =
    await Promise.all([
      ordersQuery,
      listingsCreatedQuery,
      supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "active"),
      supabase.from("listings").select("id", { count: "exact", head: true }).eq("status", "pending_review"),
      supabase.from("profiles").select("id", { count: "exact", head: true }),
    ]);

  const orders = ordersResult.data || [];
  const totalGmv = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const platformRevenue = orders.reduce((sum, o) => sum + (o.commission_amount || 0), 0);
  const listingsCreated = listingsCreatedResult.count || 0;
  const orderCount = orders.length;
  const conversionRate = listingsCreated > 0 ? Math.round((orderCount / listingsCreated) * 1000) / 10 : 0;

  return c.json({
    metrics: {
      total_gmv: totalGmv,
      platform_revenue: platformRevenue,
      active_listings: activeListingsResult.count || 0,
      conversion_rate: conversionRate,
      pending_review_count: pendingResult.count || 0,
      total_users: usersResult.count || 0,
    },
  });
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
    .select("commission_rate")
    .limit(1)
    .single();

  if (error) {
    console.error("Error fetching admin settings:", error);
    return c.json({ error: "Failed to fetch settings" }, 500);
  }

  return c.json({ settings: { commission_rate: data.commission_rate } });
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

export default admin;
