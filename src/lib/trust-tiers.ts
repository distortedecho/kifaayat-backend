import type { TrustTier, TierThreshold } from "../types/trust.js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Calculate a seller's trust tier based on their metrics.
 *
 * Checks from Tier 3 down to Tier 1, returns 0 if none match.
 * Rating check: Tier 1 allows null rating (no reviews yet = pass);
 * Tier 2+ requires non-null rating meeting threshold.
 */
export function calculateTrustTier(
  completedSales: number,
  avgRating: number | null,
  accountAgeDays: number,
  stripeVerified: boolean,
  thresholds: Record<string, TierThreshold>
): TrustTier {
  // Check from highest tier down
  for (const tier of [3, 2, 1] as const) {
    const threshold = thresholds[String(tier)];
    if (!threshold) continue;

    // Check Stripe requirement
    if (threshold.require_stripe && !stripeVerified) continue;

    // Check minimum sales
    if (completedSales < threshold.min_sales) continue;

    // Check account age
    if (accountAgeDays < threshold.min_days) continue;

    // Check rating: Tier 1 allows null rating; Tier 2+ requires non-null
    if (tier >= 2) {
      if (avgRating === null || avgRating < threshold.min_rating) continue;
    } else {
      // Tier 1: null rating passes, non-null must meet threshold
      if (avgRating !== null && avgRating < threshold.min_rating) continue;
    }

    return tier;
  }

  return 0;
}

/**
 * Compute median prices per category from active listings.
 * Falls back to application-level median if PERCENTILE_CONT is unavailable.
 */
export async function computeCategoryMedians(
  supabase: SupabaseClient
): Promise<Record<string, number>> {
  // Try fetching active listing prices grouped by category
  const { data, error } = await supabase
    .from("listings")
    .select("category, price_amount")
    .eq("status", "active");

  if (error || !data || data.length === 0) {
    return {};
  }

  // Group prices by category
  const pricesByCategory: Record<string, number[]> = {};
  for (const row of data) {
    if (!row.category || row.price_amount == null) continue;
    if (!pricesByCategory[row.category]) {
      pricesByCategory[row.category] = [];
    }
    pricesByCategory[row.category].push(row.price_amount);
  }

  // Compute median for each category
  const medians: Record<string, number> = {};
  for (const [category, prices] of Object.entries(pricesByCategory)) {
    prices.sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    medians[category] =
      prices.length % 2 === 0
        ? Math.round((prices[mid - 1] + prices[mid]) / 2)
        : prices[mid];
  }

  return medians;
}
