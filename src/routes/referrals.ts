import { Hono } from "hono";
import { clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { getAvailableCreditBalance } from "../lib/referrals.js";

const referrals = new Hono();

// ============================================================
// GET /api/referrals/code
// Returns the current user's referral code.
// ============================================================

referrals.get("/code", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const { data: codeRow, error } = await supabase
    .from("referral_codes")
    .select("code, disabled")
    .eq("user_id", profile.id)
    .single();

  if (error && error.code === "PGRST116") {
    // No code exists -- generate one (edge case)
    const code = profile.id.slice(0, 8).toUpperCase();

    const { data: newCode, error: insertError } = await supabase
      .from("referral_codes")
      .insert({ user_id: profile.id, code })
      .select("code, disabled")
      .single();

    if (insertError) {
      // Handle unique collision
      const fallback = `${code}${Math.floor(Math.random() * 999)}`;
      const { data: fallbackCode, error: fallbackError } = await supabase
        .from("referral_codes")
        .insert({ user_id: profile.id, code: fallback })
        .select("code, disabled")
        .single();

      if (fallbackError) {
        console.error("Error generating referral code:", fallbackError);
        return c.json({ error: "Failed to generate referral code" }, 500);
      }
      return c.json({ code: fallbackCode!.code, disabled: fallbackCode!.disabled });
    }

    return c.json({ code: newCode!.code, disabled: newCode!.disabled });
  }

  if (error) {
    console.error("Error fetching referral code:", error);
    return c.json({ error: "Failed to fetch referral code" }, 500);
  }

  return c.json({ code: codeRow.code, disabled: codeRow.disabled });
});

// ============================================================
// POST /api/referrals/validate
// Validate a referral code (no auth required).
// ============================================================

referrals.post("/validate", async (c) => {
  const body = await c.req.json();
  const code = body.code;

  if (!code || typeof code !== "string") {
    return c.json({ valid: false, reason: "Code is required" }, 400);
  }

  const supabase = createSupabaseAdmin();
  const normalizedCode = code.toUpperCase().trim();

  const { data: codeRow, error } = await supabase
    .from("referral_codes")
    .select("id, code, disabled, user_id")
    .eq("code", normalizedCode)
    .single();

  if (error || !codeRow) {
    return c.json({ valid: false, reason: "Invalid referral code" });
  }

  if (codeRow.disabled) {
    return c.json({ valid: false, reason: "This referral code has been disabled" });
  }

  return c.json({ valid: true, code: codeRow.code });
});

// ============================================================
// POST /api/referrals/record
// Record that the current user was referred by a code.
// ============================================================

referrals.post("/record", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const body = await c.req.json();
  const code = body.code;

  if (!code || typeof code !== "string") {
    return c.json({ error: "Referral code is required" }, 400);
  }

  const supabase = createSupabaseAdmin();
  const normalizedCode = code.toUpperCase().trim();

  // Validate code exists and is not disabled
  const { data: codeRow, error: codeError } = await supabase
    .from("referral_codes")
    .select("id, user_id, disabled")
    .eq("code", normalizedCode)
    .single();

  if (codeError || !codeRow) {
    return c.json({ error: "Invalid referral code" }, 400);
  }

  if (codeRow.disabled) {
    return c.json({ error: "This referral code has been disabled" }, 400);
  }

  // Block self-referral
  if (codeRow.user_id === profile.id) {
    return c.json({ error: "You cannot use your own referral code" }, 400);
  }

  // Check for existing referral for this user
  const { data: existingReferral } = await supabase
    .from("referrals")
    .select("id")
    .eq("referred_id", profile.id)
    .single();

  if (existingReferral) {
    return c.json({ error: "You have already used a referral code" }, 400);
  }

  // Insert referral record
  const { data: referral, error: insertError } = await supabase
    .from("referrals")
    .insert({
      referrer_id: codeRow.user_id,
      referred_id: profile.id,
      referral_code_id: codeRow.id,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Error recording referral:", insertError);
    return c.json({ error: "Failed to record referral" }, 500);
  }

  return c.json({ referral_id: referral!.id });
});

// ============================================================
// GET /api/referrals/stats
// Return referral stats for the current user.
// ============================================================

referrals.get("/stats", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Query referrals where user is the referrer
  const { data: referralRows, error: refError } = await supabase
    .from("referrals")
    .select("id, status")
    .eq("referrer_id", profile.id);

  if (refError) {
    console.error("Error fetching referral stats:", refError);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }

  const totalReferrals = (referralRows || []).length;
  const creditedReferrals = (referralRows || []).filter((r) => r.status === "credited").length;

  // Query credits for this user
  const { data: creditRows, error: creditError } = await supabase
    .from("referral_credits")
    .select("amount, status")
    .eq("user_id", profile.id);

  if (creditError) {
    console.error("Error fetching referral credits:", creditError);
    return c.json({ error: "Failed to fetch credit stats" }, 500);
  }

  const totalCreditsEarned = (creditRows || [])
    .filter((cr) => cr.status === "active" || cr.status === "redeemed")
    .reduce((sum, cr) => sum + (cr.amount || 0), 0);

  const pendingCredits = (creditRows || [])
    .filter((cr) => cr.status === "pending")
    .reduce((sum, cr) => sum + (cr.amount || 0), 0);

  return c.json({
    total_referrals: totalReferrals,
    credited_referrals: creditedReferrals,
    total_credits_earned: totalCreditsEarned,
    pending_credits: pendingCredits,
  });
});

// ============================================================
// GET /api/referrals/balance
// Return available credit balance and active credits.
// ============================================================

referrals.get("/balance", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const balance = await getAvailableCreditBalance(profile.id);

  // Fetch active credit records
  const { data: credits, error } = await supabase
    .from("referral_credits")
    .select("id, amount, expires_at, type")
    .eq("user_id", profile.id)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .order("expires_at", { ascending: true });

  if (error) {
    console.error("Error fetching active credits:", error);
    return c.json({ error: "Failed to fetch credits" }, 500);
  }

  return c.json({
    balance,
    credits: (credits || []).map((cr) => ({
      id: cr.id,
      amount: cr.amount,
      expires_at: cr.expires_at,
      type: cr.type,
    })),
  });
});

export default referrals;
