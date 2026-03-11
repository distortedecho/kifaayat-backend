import { Hono } from "hono";
import { z } from "zod";
import { createClerkClient } from "@clerk/backend";
import { clerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  createNotification,
  listingApprovedNotification,
  listingRejectedNotification,
} from "../lib/notifications.js";

const admin = new Hono();

// ============================================================
// Admin Guard Middleware
// ============================================================

async function isAdmin(clerkUserId: string): Promise<{ admin: boolean; profileId: string | null }> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, is_admin")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return { admin: false, profileId: null };
  return { admin: data.is_admin === true, profileId: data.id };
}

// Apply Clerk auth + admin check to ALL routes
admin.use("*", clerkMiddleware, async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  const { admin: isAdminUser } = await isAdmin(clerkUserId);
  if (!isAdminUser) {
    return c.json({ error: "Forbidden: admin access required" }, 403);
  }
  await next();
});

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
 * Looks up seller email via Clerk, then POSTs to email-hooks endpoint.
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
    const clerk = createClerkClient({
      secretKey: process.env.CLERK_SECRET_KEY || "",
    });
    const user = await clerk.users.getUser(params.sellerClerkId);
    const sellerEmail = user.emailAddresses[0]?.emailAddress;
    if (!sellerEmail) return;

    const port = process.env.PORT || "3001";
    await fetch(`http://localhost:${port}/api/email-hooks/listing-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      },
      body: JSON.stringify({
        seller_email: sellerEmail,
        seller_name: params.sellerName,
        listing_title: params.listingTitle,
        listing_photo_url: params.listingPhotoUrl,
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
// Listing Review Queue
// ============================================================

/**
 * GET /api/admin/listings/pending
 * Returns all pending_review listings with photos and seller info.
 */
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

/**
 * POST /api/admin/listings/:id/approve
 * Approve a single listing (pending_review -> active).
 */
admin.post("/listings/:id/approve", async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Fetch listing with seller info
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

  // Gate: seller must have completed Stripe onboarding
  const seller = listing.profiles as { id: string; clerk_id: string; display_name: string; avatar_url: string; stripe_account_id: string | null; stripe_onboarding_complete: boolean } | null;
  if (!seller?.stripe_onboarding_complete) {
    return c.json({ error: "Cannot approve: seller has not completed Stripe onboarding" }, 400);
  }

  // Update status
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

  // Fire-and-forget: in-app + push notification
  if (seller) {
    const template = listingApprovedNotification(listing.title);
    createNotification({
      user_id: seller.id,
      type: "listing_approved",
      title: template.title,
      body: template.body,
      data: { listing_id: listingId },
    }).catch((err) => console.error("[admin] Notification error:", err));

    // Get cover photo URL for email
    const { data: coverPhoto } = await supabase
      .from("listing_photos")
      .select("url")
      .eq("listing_id", listingId)
      .order("position", { ascending: true })
      .limit(1)
      .single();

    // Fire-and-forget: email
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

/**
 * POST /api/admin/listings/:id/reject
 * Reject a single listing (pending_review -> draft).
 */
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

  // Fetch listing with seller info
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

  // Update status
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

  // Fire-and-forget: in-app + push notification
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

    // Get cover photo URL for email
    const { data: coverPhoto } = await supabase
      .from("listing_photos")
      .select("url")
      .eq("listing_id", listingId)
      .order("position", { ascending: true })
      .limit(1)
      .single();

    // Fire-and-forget: email
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

/**
 * POST /api/admin/listings/batch
 * Batch approve or reject multiple listings.
 */
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
      // Fetch listing with seller info
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

      // Gate: seller must have completed Stripe onboarding for approval
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

      // Fire-and-forget notifications
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

        // Get cover photo URL for email
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
    } catch (err) {
      results.push({ id, success: false, error: "Unexpected error" });
    }
  }

  return c.json({ results });
});

// ============================================================
// User Management
// ============================================================

/**
 * GET /api/admin/users
 * List all users with listing/order counts.
 */
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

  // Fetch computed counts for each user
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

/**
 * POST /api/admin/users/:id/suspend
 * Suspend a user.
 */
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

/**
 * POST /api/admin/users/:id/unsuspend
 * Unsuspend a user.
 */
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

/**
 * POST /api/admin/users/:id/ban
 * Ban a user and deactivate all their active listings.
 */
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

  // Ban user
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

  // Deactivate all active listings by this user
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

/**
 * GET /api/admin/dashboard
 * Dashboard metrics for a time range.
 */
admin.get("/dashboard", async (c) => {
  const supabase = createSupabaseAdmin();
  const rangeDate = parseRange(c.req.query("range"));

  // Build date-filtered queries
  let ordersQuery = supabase.from("orders").select("amount, commission_amount");
  let listingsCreatedQuery = supabase.from("listings").select("id", { count: "exact", head: true });

  if (rangeDate) {
    const rangeISO = rangeDate.toISOString();
    ordersQuery = ordersQuery.gte("created_at", rangeISO);
    listingsCreatedQuery = listingsCreatedQuery.gte("created_at", rangeISO);
  }

  const [
    ordersResult,
    listingsCreatedResult,
    activeListingsResult,
    pendingResult,
    usersResult,
  ] = await Promise.all([
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
  const conversionRate = listingsCreated > 0
    ? Math.round((orderCount / listingsCreated) * 1000) / 10
    : 0;

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

/**
 * GET /api/admin/dashboard/timeseries
 * Time-series data for charts.
 */
admin.get("/dashboard/timeseries", async (c) => {
  const supabase = createSupabaseAdmin();
  const range = c.req.query("range") || "30d";
  const rangeDate = parseRange(range);

  // Default to 30 days if no range date
  const startDate = rangeDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  // Generate list of dates in range
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  // Fetch raw data
  const [ordersResult, listingsResult, usersResult] = await Promise.all([
    supabase
      .from("orders")
      .select("amount, created_at")
      .gte("created_at", startDate.toISOString()),
    supabase
      .from("listings")
      .select("created_at")
      .gte("created_at", startDate.toISOString()),
    supabase
      .from("profiles")
      .select("created_at")
      .gte("created_at", startDate.toISOString()),
  ]);

  const orders = ordersResult.data || [];
  const listings = listingsResult.data || [];
  const users = usersResult.data || [];

  // Aggregate by date
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

  // Fill gaps with zeros
  const series = dates.map((date) => ({
    date,
    gmv: gmvByDate[date] || 0,
    new_listings: listingsByDate[date] || 0,
    new_users: usersByDate[date] || 0,
  }));

  return c.json({ series });
});

/**
 * GET /api/admin/dashboard/export
 * CSV export of dashboard metrics.
 */
admin.get("/dashboard/export", async (c) => {
  const supabase = createSupabaseAdmin();
  const range = c.req.query("range") || "30d";
  const rangeDate = parseRange(range);

  const startDate = rangeDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = new Date();

  // Generate list of dates in range
  const dates: string[] = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  // Fetch raw data
  const [ordersResult, listingsResult, usersResult] = await Promise.all([
    supabase
      .from("orders")
      .select("amount, commission_amount, created_at")
      .gte("created_at", startDate.toISOString()),
    supabase
      .from("listings")
      .select("created_at")
      .gte("created_at", startDate.toISOString()),
    supabase
      .from("profiles")
      .select("created_at")
      .gte("created_at", startDate.toISOString()),
  ]);

  const orders = ordersResult.data || [];
  const listings = listingsResult.data || [];
  const users = usersResult.data || [];

  // Aggregate by date
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

  // Build CSV
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

/**
 * GET /api/admin/settings
 * Read admin settings (commission_rate).
 */
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

/**
 * PUT /api/admin/settings
 * Update commission_rate.
 */
admin.put("/settings", async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const settingsSchema = z.object({
    commission_rate: z.number().min(0).max(100),
  });
  const body = await c.req.json();
  const parsed = settingsSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }

  // Look up admin profile ID for updated_by
  const { admin: _, profileId } = await isAdmin(clerkUserId);

  // Get the first (only) settings row
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
      updated_by: profileId,
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
