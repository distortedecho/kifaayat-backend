// ============================================================
// Recurring job implementations (Phase 2.10)
//
// Previously this file scheduled jobs via `node-cron`. In Phase 2.10
// scheduling moved to `lib/jobs.ts` (pg-boss) so we get crash
// recovery, retries, and a shared queue across instances. The
// business logic here is still the source of truth -- pg-boss
// worker handlers import these functions.
//
// Each exported function is idempotent and safe to call from any
// worker process; it never mutates module-level state.
// ============================================================

import { createSupabaseAdmin } from "./supabase.js";
import {
  createNotification,
  isoMatchFoundNotification,
  orderAutoCompleteNotification,
  orderRejectedNotification,
} from "./notifications.js";
import { matchISOPost } from "../routes/ai.js";
import { getStripe } from "./stripeClient.js";

/**
 * Auto-complete delivered orders that have sat in "delivered" state
 * longer than the grace period (48h).
 */
export async function runAutoCompleteOrders(): Promise<void> {
  console.log("[job] runAutoCompleteOrders start");
  try {
    const supabase = createSupabaseAdmin();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    // 1) Legacy path: orders still in "delivered" past the 48h cutoff.
    const { data: deliveredData, error: deliveredError } = await supabase
      .from("orders")
      .update({
        status: "complete",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("status", "delivered")
      .lt("updated_at", cutoff)
      .select("id");
    if (deliveredError) throw deliveredError;
    if (deliveredData?.length) {
      console.log(`[job] Auto-completed ${deliveredData.length} delivered orders`);
    }

    // 2) New path: shipped orders past their explicit auto_complete_at
    // deadline. Mirrors the /cron/auto-complete HTTP endpoint so the
    // cron and webhook paths both notify the correct parties.
    const { data: overdueOrders, error: overdueError } = await supabase
      .from("orders")
      .select(
        "id, buyer_id, seller_id, listing_id, currency, seller_payout, listings!orders_listing_id_fkey(title)"
      )
      .eq("status", "shipped")
      .not("auto_complete_at", "is", null)
      .lte("auto_complete_at", new Date().toISOString());
    if (overdueError) throw overdueError;

    for (const order of overdueOrders || []) {
      const { error: updateError } = await supabase
        .from("orders")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
        })
        .eq("id", order.id as string);
      if (updateError) {
        console.error(`[job] Failed to auto-complete order ${order.id}:`, updateError);
        continue;
      }

      const listingRaw = order.listings as unknown;
      const listing = Array.isArray(listingRaw)
        ? (listingRaw[0] as Record<string, unknown> | undefined)
        : (listingRaw as Record<string, unknown> | null);
      const listingTitle = listing ? (listing.title as string) : "your item";

      if (order.buyer_id) {
        await createNotification({
          user_id: order.buyer_id as string,
          type: "order_complete",
          ...orderAutoCompleteNotification(listingTitle, "buyer"),
          data: { order_id: order.id, listing_id: order.listing_id, role: "buyer" },
        });
      }
      await createNotification({
        user_id: order.seller_id as string,
        type: "order_complete",
        ...orderAutoCompleteNotification(
          listingTitle,
          "seller",
          order.seller_payout as number,
          order.currency as string
        ),
        data: { order_id: order.id, listing_id: order.listing_id, role: "seller" },
      });
    }
  } catch (err) {
    console.error("[job] runAutoCompleteOrders failed:", err);
  }
}

/**
 * Auto-reject a single order if the seller has not accepted within the deadline.
 * Fired by a pg-boss delayed job enqueued at payment time (48h delay).
 * Idempotent: skips if the order is no longer in 'paid' state or if seller already accepted.
 */
export async function autoRejectOrder(orderId: string): Promise<void> {
  console.log(`[job] autoRejectOrder start: orderId=${orderId}`);
  try {
    const supabase = createSupabaseAdmin();

    const { data: order, error } = await supabase
      .from("orders")
      .select(
        "id, status, seller_accepted_at, listing_id, buyer_id, seller_id, stripe_payment_intent_id, listings!orders_listing_id_fkey(title)"
      )
      .eq("id", orderId)
      .single();

    if (error || !order) {
      console.error(`[job] autoRejectOrder: order ${orderId} not found`);
      return;
    }

    // Skip if seller already acted (accepted or rejected)
    if (order.status !== "paid" || order.seller_accepted_at) {
      console.log(
        `[job] autoRejectOrder: order ${orderId} skipped (status=${order.status}, accepted=${!!order.seller_accepted_at})`
      );
      return;
    }

    const listingRaw = order.listings as unknown;
    const listing = Array.isArray(listingRaw)
      ? (listingRaw[0] as Record<string, unknown> | undefined)
      : (listingRaw as Record<string, unknown> | null);
    const listingTitle = listing ? (listing.title as string) : "your item";

    // Restore listing to active
    await supabase
      .from("listings")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", order.listing_id as string);

    // Cancel order
    await supabase
      .from("orders")
      .update({
        status: "cancelled",
        seller_rejection_reason: "Seller did not respond within 48 hours",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    // Attempt Stripe refund (fire-and-forget, log on failure). With escrow
    // the funds are sitting in Kifaayat's balance, so this is a clean
    // refund — no seller-side clawback required.
    if (order.stripe_payment_intent_id) {
      try {
        await getStripe().refunds.create({
          payment_intent: order.stripe_payment_intent_id as string,
        });
        console.log(`[job] autoRejectOrder: refund issued for order ${orderId}`);
      } catch (refundErr) {
        console.error(
          `[job] autoRejectOrder: Stripe refund failed for order ${orderId}:`,
          refundErr
        );
      }
    }

    // Tombstone the payout ledger row so the admin dashboard doesn't
    // surface this as a pending disbursement.
    try {
      const { cancelPayoutForOrder } = await import("../services/payoutService.js");
      await cancelPayoutForOrder(orderId, "Auto-rejected: seller did not respond within 48 hours");
    } catch (err) {
      console.error(`[job] autoRejectOrder: payout cancel failed for ${orderId}:`, err);
    }

    // Notify buyer
    if (order.buyer_id) {
      await createNotification({
        user_id: order.buyer_id as string,
        type: "order_rejected",
        ...orderRejectedNotification(listingTitle),
        data: { order_id: orderId, listing_id: order.listing_id, auto_rejected: true, role: "buyer" },
      });
    }

    console.log(`[job] autoRejectOrder complete: orderId=${orderId}`);
  } catch (err) {
    console.error(`[job] autoRejectOrder failed: orderId=${orderId}`, err);
  }
}

/**
 * Daily ISO matching refresh:
 *  1. Auto-close ISO posts older than 30 days.
 *  2. Re-run AI matching for every still-active post.
 *  3. Notify authors when new matches appear.
 */
export async function runIsoMatchingRefresh(): Promise<void> {
  console.log("[job] runIsoMatchingRefresh start");
  try {
    const supabase = createSupabaseAdmin();

    const { data: activePosts, error } = await supabase
      .from("iso_posts")
      .select("id")
      .eq("status", "active");
    if (error || !activePosts) {
      console.error("[job] Failed to fetch active ISO posts:", error);
      return;
    }

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: expiredPosts } = await supabase
      .from("iso_posts")
      .update({ status: "closed", updated_at: new Date().toISOString() })
      .eq("status", "active")
      .lt("created_at", thirtyDaysAgo)
      .select("id");

    if (expiredPosts && expiredPosts.length > 0) {
      console.log(`[job] Auto-closed ${expiredPosts.length} expired ISO posts`);
    }

    const expiredIds = new Set(
      (expiredPosts || []).map((ep: Record<string, unknown>) => ep.id)
    );
    const stillActive = activePosts.filter(
      (p: Record<string, unknown>) => !expiredIds.has(p.id)
    );

    let totalNewMatches = 0;
    for (const post of stillActive) {
      try {
        const { data: existingMatches } = await supabase
          .from("iso_matches")
          .select("listing_id")
          .eq("iso_post_id", post.id);
        const existingIds = new Set(
          (existingMatches || []).map(
            (m: Record<string, unknown>) => m.listing_id
          )
        );

        const matchCount = await matchISOPost(post.id as string);

        if (matchCount > 0) {
          const { data: currentMatches } = await supabase
            .from("iso_matches")
            .select("listing_id")
            .eq("iso_post_id", post.id);

          const newMatchIds = (currentMatches || []).filter(
            (m: Record<string, unknown>) => !existingIds.has(m.listing_id)
          );

          if (newMatchIds.length > 0) {
            totalNewMatches += newMatchIds.length;
            const { data: isoPost } = await supabase
              .from("iso_posts")
              .select("author_id, description")
              .eq("id", post.id)
              .single();
            if (isoPost) {
              const template = isoMatchFoundNotification(
                (isoPost.description as string) || "your request"
              );
              await createNotification({
                user_id: isoPost.author_id as string,
                type: "iso_match",
                ...template,
                // ISO author is a prospective buyer.
                data: { iso_post_id: post.id, role: "buyer" },
              });
            }
          }
        }
      } catch (postErr) {
        console.error(`[job] ISO matching failed for post ${post.id}:`, postErr);
      }

      // Deliberate 3s pause between posts so a cron burst cannot
      // starve user-facing AI traffic sharing the single Gemini key.
      // matchISOPost itself already routes through the cronGeminiQueue.
      await new Promise((r) => setTimeout(r, 3000));
    }

    console.log(
      `[job] ISO matching refresh complete. Processed ${stillActive.length} posts, ${totalNewMatches} new matches.`
    );
  } catch (err) {
    console.error("[job] runIsoMatchingRefresh failed:", err);
  }
}
