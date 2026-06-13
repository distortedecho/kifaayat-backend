// ============================================================
// Admin service (Phase 2.8 + 2.9)
//
// routes/admin.ts is ~3000 lines and a full extraction would be
// high-risk and low-value. This service pulls out only the handlers
// that benefit most from service-layer extraction:
//
//   - getDashboardMetrics: ported to a single tagged-template query
//     via the direct Postgres client when DATABASE_URL is available.
//     Falls back to the existing Supabase JS implementation when
//     Supavisor is not configured so dev still works.
//
//   - approveListing / rejectListing: emit `listing:approved` and
//     `listing:rejected` events instead of firing notifications
//     inline so the route handler can return faster.
//
// Intentionally deferred to a future phase:
//   - user suspension / ban
//   - all /config/* CRUD
//   - analytics/search-demand / analytics/categories / analytics/sellers
//   - moderation flows
//   - notification toggle CRUD
//   - Stripe sellers refresh
// These all live in routes/admin.ts still and have had no behavioral
// change.
// ============================================================

import { createSupabaseAdmin } from "../lib/supabase.js";
import { hasDirectDb, getSql } from "../lib/db.js";
import { emit } from "../lib/events.js";
import { logger } from "../lib/logger.js";

export class AdminServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "AdminServiceError";
  }
}

export interface DashboardMetrics {
  total_gmv: number;
  platform_revenue: number;
  active_listings: number;
  conversion_rate: number;
  pending_review_count: number;
  total_users: number;
}

/**
 * Aggregate the dashboard headline metrics. Uses the direct Postgres
 * client for a single-round-trip aggregation when available,
 * otherwise falls back to the previous Supabase JS `Promise.all`
 * implementation.
 */
export async function getDashboardMetrics(
  rangeDate: Date | null
): Promise<DashboardMetrics> {
  if (hasDirectDb()) {
    try {
      const sql = getSql();
      const rangeISO = rangeDate ? rangeDate.toISOString() : null;
      const rows = await sql<
        Array<{
          total_gmv: string | number | null;
          platform_revenue: string | number | null;
          order_count: string | number | null;
          listings_created: string | number | null;
          active_listings: string | number | null;
          pending_review_count: string | number | null;
          total_users: string | number | null;
        }>
      >`
        SELECT
          COALESCE(SUM(o.amount) FILTER (
            WHERE ${rangeISO}::timestamptz IS NULL OR o.created_at >= ${rangeISO}::timestamptz
          ), 0) AS total_gmv,
          COALESCE(SUM(o.commission_amount) FILTER (
            WHERE ${rangeISO}::timestamptz IS NULL OR o.created_at >= ${rangeISO}::timestamptz
          ), 0) AS platform_revenue,
          COUNT(o.id) FILTER (
            WHERE ${rangeISO}::timestamptz IS NULL OR o.created_at >= ${rangeISO}::timestamptz
          ) AS order_count,
          (
            SELECT COUNT(*) FROM listings
            WHERE ${rangeISO}::timestamptz IS NULL OR created_at >= ${rangeISO}::timestamptz
          ) AS listings_created,
          (SELECT COUNT(*) FROM listings WHERE status = 'active') AS active_listings,
          (SELECT COUNT(*) FROM listings WHERE status = 'pending_review') AS pending_review_count,
          (SELECT COUNT(*) FROM profiles) AS total_users
        FROM orders o
      `;
      const row = rows[0];
      const totalGmv = Number(row.total_gmv || 0);
      const platformRevenue = Number(row.platform_revenue || 0);
      const orderCount = Number(row.order_count || 0);
      const listingsCreated = Number(row.listings_created || 0);
      const conversionRate =
        listingsCreated > 0
          ? Math.round((orderCount / listingsCreated) * 1000) / 10
          : 0;

      return {
        total_gmv: totalGmv,
        platform_revenue: platformRevenue,
        active_listings: Number(row.active_listings || 0),
        conversion_rate: conversionRate,
        pending_review_count: Number(row.pending_review_count || 0),
        total_users: Number(row.total_users || 0),
      };
    } catch (err) {
      logger.error("adminService.dashboard_direct_pg_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // fall through to Supabase JS path
    }
  }

  const supabase = createSupabaseAdmin();
  let ordersQuery = supabase.from("orders").select("amount, commission_amount");
  let listingsCreatedQuery = supabase
    .from("listings")
    .select("id", { count: "exact", head: true });
  if (rangeDate) {
    const rangeISO = rangeDate.toISOString();
    ordersQuery = ordersQuery.gte("created_at", rangeISO);
    listingsCreatedQuery = listingsCreatedQuery.gte("created_at", rangeISO);
  }
  const [ordersResult, listingsCreatedResult, activeListingsResult, pendingResult, usersResult] =
    await Promise.all([
      ordersQuery,
      listingsCreatedQuery,
      supabase
        .from("listings")
        .select("id", { count: "exact", head: true })
        .eq("status", "active"),
      supabase
        .from("listings")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_review"),
      supabase.from("profiles").select("id", { count: "exact", head: true }),
    ]);

  const orders = ordersResult.data || [];
  const totalGmv = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const platformRevenue = orders.reduce(
    (sum, o) => sum + (o.commission_amount || 0),
    0
  );
  const listingsCreated = listingsCreatedResult.count || 0;
  const orderCount = orders.length;
  const conversionRate =
    listingsCreated > 0
      ? Math.round((orderCount / listingsCreated) * 1000) / 10
      : 0;

  return {
    total_gmv: totalGmv,
    platform_revenue: platformRevenue,
    active_listings: activeListingsResult.count || 0,
    conversion_rate: conversionRate,
    pending_review_count: pendingResult.count || 0,
    total_users: usersResult.count || 0,
  };
}

export interface ApproveListingResult {
  listing: Record<string, unknown>;
  sellerClerkId: string | null;
  sellerName: string | null;
  coverPhotoUrl: string | null;
}

/**
 * Approve a pending listing. Returns enough context for the route
 * handler to still fire its email helper (which takes Clerk IDs).
 * Emits `listing:approved` for notification dispatch.
 */
export async function approveListing(
  listingId: string
): Promise<ApproveListingResult> {
  const supabase = createSupabaseAdmin();

  // PostgREST's inferred type for big embedded selects collapses to a
  // bag-of-strings, so we narrow manually after the .single() call.
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
    };
  };

  const { data: listingRaw, error: fetchError } = await supabase
    .from("listings")
    .select(
      "*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url, " +
        "payout_method, stripe_account_id, stripe_onboarding_complete, " +
        "wise_account_holder, wise_bank_country, wise_bank_currency, " +
        "wise_routing_code, wise_account_number, paypal_email)"
    )
    .eq("id", listingId)
    .single();
  if (fetchError || !listingRaw) {
    throw new AdminServiceError("Listing not found", 404);
  }
  const listing = listingRaw as unknown as ListingRow;

  if (listing.status !== "pending_review") {
    throw new AdminServiceError(
      `Cannot approve listing with status '${listing.status}'`,
      400
    );
  }

  const seller = listing.profiles;

  // Any usable payout method qualifies — Stripe Connect, Wise, or PayPal.
  // See services/payoutService.ts for what "usable" means per method.
  const { resolveSellerPayoutMethod } = await import("./payoutService.js");
  if (!resolveSellerPayoutMethod(seller)) {
    throw new AdminServiceError(
      "Cannot approve: seller has not set up a payout method (Stripe / Wise / PayPal)",
      400
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update({ status: "active", rejection_reason: null })
    .eq("id", listingId)
    .select()
    .single();
  if (updateError || !updated) {
    logger.error("adminService.approve_failed", {
      listing_id: listingId,
      error: updateError?.message,
    });
    throw new AdminServiceError("Failed to approve listing", 500);
  }

  const { data: coverPhoto } = await supabase
    .from("listing_photos")
    .select("url")
    .eq("listing_id", listingId)
    .order("position", { ascending: true })
    .limit(1)
    .single();

  emit("listing:approved", {
    listingId,
    sellerId: seller.id,
    title: listing.title,
  });

  return {
    listing: updated,
    sellerClerkId: seller.clerk_id,
    sellerName: seller.display_name,
    coverPhotoUrl: coverPhoto?.url || null,
  };
}

export interface RejectListingResult {
  listing: Record<string, unknown>;
  sellerClerkId: string | null;
  sellerName: string | null;
  coverPhotoUrl: string | null;
}

/**
 * Reject a pending listing. Emits `listing:rejected` for
 * notification dispatch and returns context for the email helper.
 */
export async function rejectListing(
  listingId: string,
  reason: string
): Promise<RejectListingResult> {
  const supabase = createSupabaseAdmin();

  const { data: listing, error: fetchError } = await supabase
    .from("listings")
    .select(
      "*, profiles!listings_seller_id_fkey(id, clerk_id, display_name, avatar_url)"
    )
    .eq("id", listingId)
    .single();
  if (fetchError || !listing) {
    throw new AdminServiceError("Listing not found", 404);
  }
  if (listing.status !== "pending_review") {
    throw new AdminServiceError(
      `Cannot reject listing with status '${listing.status}'`,
      400
    );
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update({ status: "draft", rejection_reason: reason })
    .eq("id", listingId)
    .select()
    .single();
  if (updateError || !updated) {
    logger.error("adminService.reject_failed", {
      listing_id: listingId,
      error: updateError?.message,
    });
    throw new AdminServiceError("Failed to reject listing", 500);
  }

  const seller = listing.profiles as {
    id: string;
    clerk_id: string;
    display_name: string;
    avatar_url: string;
  } | null;

  const { data: coverPhoto } = await supabase
    .from("listing_photos")
    .select("url")
    .eq("listing_id", listingId)
    .order("position", { ascending: true })
    .limit(1)
    .single();

  if (seller) {
    emit("listing:rejected", {
      listingId,
      sellerId: seller.id,
      title: listing.title,
      reason,
    });
  }

  return {
    listing: updated,
    sellerClerkId: seller?.clerk_id || null,
    sellerName: seller?.display_name || null,
    coverPhotoUrl: coverPhoto?.url || null,
  };
}
