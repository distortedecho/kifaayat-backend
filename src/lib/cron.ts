import cron from "node-cron";
import { createSupabaseAdmin } from "./supabase.js";
import {
  createNotification,
  isoMatchFoundNotification,
} from "./notifications.js";
import { matchISOPost } from "../routes/ai.js";

/**
 * Initialize all scheduled cron jobs.
 * Called once after the server starts.
 */
export function initCronJobs() {
  // Auto-complete delivered orders after 48 hours (runs every 6 hours)
  cron.schedule("0 */6 * * *", async () => {
    console.log("[cron] Running auto-complete check...");
    try {
      const supabase = createSupabaseAdmin();
      const cutoff = new Date(
        Date.now() - 48 * 60 * 60 * 1000
      ).toISOString();

      const { data, error } = await supabase
        .from("orders")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("status", "delivered")
        .lt("updated_at", cutoff)
        .select("id");

      if (error) throw error;
      if (data?.length) {
        console.log(`[cron] Auto-completed ${data.length} orders`);
      }
    } catch (err) {
      console.error("[cron] Auto-complete failed:", err);
    }
  });

  // ============================================================
  // ISO Community Cron Jobs
  // ============================================================

  // Daily ISO matching refresh at 3:00 AM
  cron.schedule("0 3 * * *", async () => {
    console.log("[ISO Cron] Starting daily ISO matching refresh...");
    try {
      const supabase = createSupabaseAdmin();

      // 1. Fetch all active ISO posts
      const { data: activePosts, error } = await supabase
        .from("iso_posts")
        .select("id")
        .eq("status", "active");

      if (error || !activePosts) {
        console.error("[ISO Cron] Failed to fetch active posts:", error);
        return;
      }

      // 2. Auto-close posts older than 30 days
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
        console.log(
          `[ISO Cron] Auto-closed ${expiredPosts.length} expired ISO posts`
        );
      }

      // 3. Re-run matching for each active (non-expired) post
      const expiredIds = new Set(
        (expiredPosts || []).map((ep: Record<string, unknown>) => ep.id)
      );
      const stillActive = activePosts.filter(
        (p: Record<string, unknown>) => !expiredIds.has(p.id)
      );

      let totalNewMatches = 0;
      for (const post of stillActive) {
        try {
          // Get existing match listing IDs before refresh
          const { data: existingMatches } = await supabase
            .from("iso_matches")
            .select("listing_id")
            .eq("iso_post_id", post.id);
          const existingIds = new Set(
            (existingMatches || []).map(
              (m: Record<string, unknown>) => m.listing_id
            )
          );

          // Run matching
          const matchCount = await matchISOPost(post.id as string);

          // Check for NEW matches (not in existingIds)
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

              // Send push notification to ISO post author
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
          console.error(
            `[ISO Cron] Matching failed for post ${post.id}:`,
            postErr
          );
        }
      }

      console.log(
        `[ISO Cron] Completed. Processed ${stillActive.length} posts, ${totalNewMatches} new matches found.`
      );
    } catch (err) {
      console.error("[ISO Cron] Error:", err);
    }
  });

  console.log("[cron] Scheduled jobs initialized");
}
