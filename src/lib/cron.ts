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
} from "./notifications.js";
import { matchISOPost } from "../routes/ai.js";

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
          data: { order_id: order.id, listing_id: order.listing_id },
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
        data: { order_id: order.id, listing_id: order.listing_id },
      });
    }
  } catch (err) {
    console.error("[job] runAutoCompleteOrders failed:", err);
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
                data: { iso_post_id: post.id },
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
