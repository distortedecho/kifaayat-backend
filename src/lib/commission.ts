import { createSupabaseAdmin } from "./supabase.js";
import { COMMISSION_RATE } from "../types/transactions.js";

export async function getCommissionRate(): Promise<number> {
  try {
    const supabase = createSupabaseAdmin();
    const { data, error } = await supabase
      .from("admin_settings")
      .select("commission_rate")
      .limit(1)
      .single();
    if (error || !data) return COMMISSION_RATE;
    return Number(data.commission_rate);
  } catch {
    return COMMISSION_RATE;
  }
}

/**
 * Get the commission rate for a specific seller based on their trust tier.
 * Falls back to the global commission rate if tier config is not found.
 */
export async function getSellerCommissionRate(sellerId: string): Promise<number> {
  try {
    const supabase = createSupabaseAdmin();

    // Fetch seller's trust tier
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("trust_tier")
      .eq("id", sellerId)
      .single();

    if (profileError || !profile) {
      return getCommissionRate();
    }

    const tier = profile.trust_tier ?? 0;

    // Fetch tier commission rates from admin_settings
    const { data: settings, error: settingsError } = await supabase
      .from("admin_settings")
      .select("tier_commission_rates")
      .limit(1)
      .single();

    if (settingsError || !settings?.tier_commission_rates) {
      return getCommissionRate();
    }

    const rates = settings.tier_commission_rates as Record<string, number>;
    const tierRate = rates[String(tier)];

    if (tierRate !== undefined) {
      return tierRate;
    }

    // Fall back to global commission rate
    return getCommissionRate();
  } catch {
    return getCommissionRate();
  }
}
