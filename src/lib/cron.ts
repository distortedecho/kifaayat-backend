import cron from "node-cron";
import Stripe from "stripe";
import { createSupabaseAdmin } from "./supabase.js";
import {
  createNotification,
  rentalAutoDeclinedNotification,
  rentalDepositReleasedNotification,
  rentalCompleteNotification,
  rentalReturnDueNotification,
  isoMatchFoundNotification,
} from "./notifications.js";
import { matchISOPost } from "../routes/ai.js";

// Stripe lazy-init for deposit release cron
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
  // Rental Cron Jobs
  // ============================================================

  // 1. Auto-decline pending rental bookings older than 24 hours (runs every hour)
  cron.schedule("0 * * * *", async () => {
    console.log("[cron] Running rental auto-decline check...");
    try {
      const supabase = createSupabaseAdmin();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: pendingBookings, error } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, lender_id, listing_id")
        .eq("status", "pending_confirmation")
        .lt("created_at", cutoff);

      if (error) throw error;
      if (!pendingBookings?.length) return;

      // Update all to declined
      const ids = pendingBookings.map((b) => b.id);
      const { error: updateError } = await supabase
        .from("rental_bookings")
        .update({
          status: "declined",
          updated_at: new Date().toISOString(),
        })
        .in("id", ids);

      if (updateError) throw updateError;

      // Send notifications for each
      for (const booking of pendingBookings) {
        try {
          // Fetch listing title
          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          const template = rentalAutoDeclinedNotification(listing?.title || "Item");

          // Notify renter
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_auto_declined",
            ...template,
            data: { rental_booking_id: booking.id },
          });

          // Notify lender
          await createNotification({
            user_id: booking.lender_id,
            type: "rental_auto_declined",
            ...template,
            data: { rental_booking_id: booking.id },
          });
        } catch (notifErr) {
          console.error(`[cron] Auto-decline notification failed for booking ${booking.id}:`, notifErr);
        }
      }

      console.log(`[cron] Auto-declined ${pendingBookings.length} rental bookings`);
    } catch (err) {
      console.error("[cron] Rental auto-decline failed:", err);
    }
  });

  // 2. Auto-release deposits on returned bookings older than 48 hours (runs hourly at :30)
  cron.schedule("30 * * * *", async () => {
    console.log("[cron] Running rental deposit auto-release check...");
    try {
      const supabase = createSupabaseAdmin();
      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      const { data: returnedBookings, error } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, lender_id, listing_id, security_deposit, stripe_deposit_payment_intent_id")
        .eq("status", "returned")
        .eq("deposit_released", false)
        .lt("updated_at", cutoff);

      if (error) throw error;
      if (!returnedBookings?.length) return;

      for (const booking of returnedBookings) {
        try {
          // Cancel deposit PI to release hold
          if (booking.stripe_deposit_payment_intent_id) {
            try {
              await getStripe().paymentIntents.cancel(booking.stripe_deposit_payment_intent_id);
            } catch (stripeErr) {
              console.error(`[cron] Stripe cancel failed for deposit PI ${booking.stripe_deposit_payment_intent_id}:`, stripeErr);
              // Do NOT update deposit_released -- will retry next run
              continue;
            }
          }

          // Update booking to complete with deposit released
          await supabase
            .from("rental_bookings")
            .update({
              status: "complete",
              deposit_released: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", booking.id);

          // Fetch listing title
          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          // Notify renter -- deposit released
          const depositTemplate = rentalDepositReleasedNotification(
            booking.security_deposit,
            "AUD"
          );
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_deposit_released",
            ...depositTemplate,
            data: { rental_booking_id: booking.id },
          });

          // Notify both -- rental complete
          const completeTemplate = rentalCompleteNotification(listing?.title || "Item");
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_complete",
            ...completeTemplate,
            data: { rental_booking_id: booking.id },
          });
          await createNotification({
            user_id: booking.lender_id,
            type: "rental_complete",
            ...completeTemplate,
            data: { rental_booking_id: booking.id },
          });
        } catch (bookingErr) {
          console.error(`[cron] Deposit auto-release failed for booking ${booking.id}:`, bookingErr);
        }
      }

      console.log(`[cron] Processed ${returnedBookings.length} deposit auto-releases`);
    } catch (err) {
      console.error("[cron] Rental deposit auto-release failed:", err);
    }
  });

  // 3. Return-due reminders (runs daily at 9am)
  cron.schedule("0 9 * * *", async () => {
    console.log("[cron] Running rental return-due reminders...");
    try {
      const supabase = createSupabaseAdmin();
      const today = new Date();

      // 2 days from now
      const twoDaysOut = new Date(today);
      twoDaysOut.setDate(twoDaysOut.getDate() + 2);
      const twoDaysStr = twoDaysOut.toISOString().split("T")[0];

      // 1 day from now (urgent)
      const oneDayOut = new Date(today);
      oneDayOut.setDate(oneDayOut.getDate() + 1);
      const oneDayStr = oneDayOut.toISOString().split("T")[0];

      // Find bookings due in 2 days
      const { data: twoDayBookings } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, listing_id, end_date")
        .eq("status", "in_use")
        .eq("end_date", twoDaysStr);

      for (const booking of twoDayBookings || []) {
        try {
          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          const template = rentalReturnDueNotification(
            listing?.title || "Item",
            booking.end_date,
            2
          );
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_return_due",
            ...template,
            data: { rental_booking_id: booking.id },
          });
        } catch (notifErr) {
          console.error(`[cron] Return reminder failed for booking ${booking.id}:`, notifErr);
        }
      }

      // Find bookings due in 1 day (urgent)
      const { data: oneDayBookings } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, listing_id, end_date")
        .eq("status", "in_use")
        .eq("end_date", oneDayStr);

      for (const booking of oneDayBookings || []) {
        try {
          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          const template = rentalReturnDueNotification(
            listing?.title || "Item",
            booking.end_date,
            1
          );
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_return_due",
            ...template,
            data: { rental_booking_id: booking.id, urgent: true },
          });
        } catch (notifErr) {
          console.error(`[cron] Urgent return reminder failed for booking ${booking.id}:`, notifErr);
        }
      }

      const total = (twoDayBookings?.length || 0) + (oneDayBookings?.length || 0);
      if (total > 0) {
        console.log(`[cron] Sent ${total} rental return-due reminders`);
      }
    } catch (err) {
      console.error("[cron] Rental return-due reminders failed:", err);
    }
  });

  // 4. In-use and return-due automatic transitions (runs every 6 hours)
  cron.schedule("15 */6 * * *", async () => {
    console.log("[cron] Running rental lifecycle transitions...");
    try {
      const supabase = createSupabaseAdmin();
      const todayStr = new Date().toISOString().split("T")[0];
      const yesterdayStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      // shipped + start_date <= today -> in_use
      const { data: toInUse } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, lender_id, listing_id")
        .eq("status", "shipped")
        .lte("start_date", todayStr);

      for (const booking of toInUse || []) {
        try {
          await supabase
            .from("rental_bookings")
            .update({ status: "in_use", updated_at: new Date().toISOString() })
            .eq("id", booking.id);

          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          await createNotification({
            user_id: booking.renter_id,
            type: "rental_in_use",
            title: "Rental Period Started",
            body: `Your rental of "${listing?.title || "Item"}" has started. Enjoy!`,
            data: { rental_booking_id: booking.id },
          });
          await createNotification({
            user_id: booking.lender_id,
            type: "rental_in_use",
            title: "Rental Period Started",
            body: `Your item "${listing?.title || "Item"}" is now with the renter.`,
            data: { rental_booking_id: booking.id },
          });
        } catch (transErr) {
          console.error(`[cron] in_use transition failed for booking ${booking.id}:`, transErr);
        }
      }

      // in_use + end_date <= today -> return_due
      const { data: toReturnDue } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, lender_id, listing_id, end_date")
        .eq("status", "in_use")
        .lte("end_date", todayStr);

      for (const booking of toReturnDue || []) {
        try {
          await supabase
            .from("rental_bookings")
            .update({ status: "return_due", updated_at: new Date().toISOString() })
            .eq("id", booking.id);

          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          const template = rentalReturnDueNotification(
            listing?.title || "Item",
            booking.end_date,
            0
          );
          await createNotification({
            user_id: booking.renter_id,
            type: "rental_return_due",
            ...template,
            data: { rental_booking_id: booking.id },
          });
          await createNotification({
            user_id: booking.lender_id,
            type: "rental_return_due",
            title: "Return Due",
            body: `"${listing?.title || "Item"}" is due to be returned today.`,
            data: { rental_booking_id: booking.id },
          });
        } catch (transErr) {
          console.error(`[cron] return_due transition failed for booking ${booking.id}:`, transErr);
        }
      }

      // return_due + end_date < yesterday -> overdue notification (no auto-fees)
      const { data: overdue } = await supabase
        .from("rental_bookings")
        .select("id, renter_id, lender_id, listing_id")
        .eq("status", "return_due")
        .lt("end_date", yesterdayStr);

      for (const booking of overdue || []) {
        try {
          const { data: listing } = await supabase
            .from("listings")
            .select("title")
            .eq("id", booking.listing_id)
            .single();

          await createNotification({
            user_id: booking.renter_id,
            type: "rental_return_due",
            title: "Overdue Return",
            body: `"${listing?.title || "Item"}" is overdue. Please return it as soon as possible.`,
            data: { rental_booking_id: booking.id, overdue: true },
          });
          await createNotification({
            user_id: booking.lender_id,
            type: "rental_return_due",
            title: "Overdue Return",
            body: `"${listing?.title || "Item"}" has not been returned yet.`,
            data: { rental_booking_id: booking.id, overdue: true },
          });
        } catch (notifErr) {
          console.error(`[cron] Overdue notification failed for booking ${booking.id}:`, notifErr);
        }
      }

      const totalTransitions = (toInUse?.length || 0) + (toReturnDue?.length || 0);
      const overdueCount = overdue?.length || 0;
      if (totalTransitions > 0 || overdueCount > 0) {
        console.log(`[cron] Rental transitions: ${toInUse?.length || 0} to in_use, ${toReturnDue?.length || 0} to return_due, ${overdueCount} overdue notifications`);
      }
    } catch (err) {
      console.error("[cron] Rental lifecycle transitions failed:", err);
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
