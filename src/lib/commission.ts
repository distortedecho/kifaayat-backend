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
