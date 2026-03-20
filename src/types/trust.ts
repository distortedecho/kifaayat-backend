// ============================================================
// Phase 12: Trust Tiers & Badges — Types
// ============================================================

/** Seller trust tier level (0=New, 1=Verified, 2=Active, 3=Trusted) */
export type TrustTier = 0 | 1 | 2 | 3;

/** Human-readable labels for each trust tier */
export const TIER_LABELS = {
  0: "New",
  1: "Verified",
  2: "Active",
  3: "Trusted",
} as const;

/** Threshold criteria for advancing to a trust tier */
export interface TierThreshold {
  min_sales: number;
  min_rating: number;
  min_days: number;
  require_stripe: boolean;
}

/** Commission rates keyed by tier string (e.g. "0" -> 12%) */
export type TierCommissionRates = Record<string, number>;

/** Default tier thresholds (Tier 1/2/3; Tier 0 is the baseline) */
export const DEFAULT_TIER_THRESHOLDS: Record<string, TierThreshold> = {
  "1": { min_sales: 1, min_rating: 4.0, min_days: 0, require_stripe: true },
  "2": { min_sales: 5, min_rating: 4.2, min_days: 30, require_stripe: true },
  "3": { min_sales: 15, min_rating: 4.5, min_days: 90, require_stripe: true },
};

/** Default commission rates per trust tier */
export const DEFAULT_TIER_COMMISSION_RATES: TierCommissionRates = {
  "0": 12,
  "1": 11,
  "2": 10,
  "3": 8,
};

/** Listing badge types */
export type ListingBadge = "Top Seller" | "Sale" | "Best Value" | "New" | "Verified";

/** Badge display priority (max 2 shown per listing) */
export const BADGE_PRIORITY: ListingBadge[] = [
  "Top Seller",
  "Sale",
  "Best Value",
  "New",
  "Verified",
];
