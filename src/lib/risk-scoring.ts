import { GoogleGenAI } from "@google/genai";
import { createSupabaseAdmin } from "./supabase.js";

interface AIFraudAnalysis {
  stock_image_score: number;
  watermark_detected: boolean;
  photo_inconsistency_score: number;
  description_red_flags: string[];
  price_anomaly_score: number;
  overall_ai_risk: number;
}

interface AutoApproveConfig {
  [tier: string]: {
    enabled: boolean;
    max_risk: number;
  };
}

/**
 * Compute AI fraud score using Gemini 2.5 Flash.
 * Sends up to 3 photo URLs + listing details for analysis.
 * Returns overall_ai_risk (0-100). On failure returns 50 (neutral).
 */
async function computeAIFraudScore(
  listing: Record<string, unknown>,
  photoUrls: string[]
): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("Risk scoring: GEMINI_API_KEY not set, returning neutral score");
    return 50;
  }

  try {
    const genAI = new GoogleGenAI({ apiKey });

    const photoParts = photoUrls.slice(0, 3).map((url) => ({
      text: `Photo URL: ${url}`,
    }));

    const prompt = `You are a fraud detection system for a preloved South Asian fashion marketplace called Kifaayat.
Analyze this listing for potential fraud indicators.

Listing details:
- Title: ${listing.title || "N/A"}
- Description: ${listing.description || "N/A"}
- Category: ${listing.category || "N/A"}
- Price: ${listing.price_amount ? `${(listing.price_amount as number) / 100} ${listing.price_currency || "AUD"}` : "N/A"}
- Condition: ${listing.condition || "N/A"}
- Number of photos: ${photoUrls.length}

Return a JSON object with these fields:
- stock_image_score: 0-100 (likelihood photos are stock/stolen images, 0=original, 100=definitely stock)
- watermark_detected: boolean (true if any photo appears to have watermarks)
- photo_inconsistency_score: 0-100 (0=photos consistent, 100=photos show different items)
- description_red_flags: string[] (list of suspicious phrases or patterns found)
- price_anomaly_score: 0-100 (0=reasonable price, 100=suspiciously low/high for category)
- overall_ai_risk: 0-100 (combined risk score, 0=safe, 100=very suspicious)

Return valid JSON only, no markdown formatting.`;

    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [...photoParts, { text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });

    const text = result.text?.trim();
    if (!text) return 50;

    const parsed: AIFraudAnalysis = JSON.parse(text);
    const score = parsed.overall_ai_risk;
    if (typeof score === "number" && score >= 0 && score <= 100) {
      return Math.round(score);
    }
    return 50;
  } catch (err) {
    console.error("Risk scoring: Gemini analysis failed, returning neutral score:", err);
    return 50;
  }
}

/**
 * Compute seller history risk score based on account age, trust tier,
 * rejection history, and report count.
 * Returns 0-100 (0=trustworthy, 100=high risk).
 */
async function computeSellerHistoryScore(
  sellerId: string
): Promise<number> {
  const supabase = createSupabaseAdmin();
  let score = 0;

  // Fetch seller profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("created_at, trust_tier, stripe_onboarding_complete")
    .eq("id", sellerId)
    .single();

  if (!profile) return 50; // Unknown seller, neutral score

  // Account age scoring
  const accountAge = Date.now() - new Date(profile.created_at).getTime();
  const daysSinceCreation = accountAge / (1000 * 60 * 60 * 24);
  if (daysSinceCreation < 7) score += 20;
  else if (daysSinceCreation < 30) score += 10;
  else if (daysSinceCreation < 90) score += 5;

  // Trust tier scoring: lower tier = higher risk
  const tier = (profile.trust_tier as number) ?? 0;
  score += (3 - tier) * 10; // tier 0 = +30, tier 1 = +20, tier 2 = +10, tier 3 = +0

  // Rejection count: listings with status=draft AND rejection_reason IS NOT NULL
  const { count: rejectionCount } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("seller_id", sellerId)
    .eq("status", "draft")
    .not("rejection_reason", "is", null);

  score += Math.min(25, (rejectionCount ?? 0) * 8);

  // Report count: reports where target_type=user AND target_id=sellerId
  const { count: reportCount } = await supabase
    .from("reports")
    .select("id", { count: "exact", head: true })
    .eq("target_type", "user")
    .eq("target_id", sellerId);

  score += Math.min(25, (reportCount ?? 0) * 12);

  return Math.min(100, score);
}

/**
 * Compute risk score for a listing (fire-and-forget).
 * Combines AI analysis (60% weight) and seller history (40% weight).
 * After scoring, checks auto-approve config for the seller's tier.
 */
export async function computeRiskScore(listingId: string): Promise<void> {
  const supabase = createSupabaseAdmin();

  // Fetch listing with photos and seller profile
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("*, listing_photos(url, position), profiles!listings_seller_id_fkey(id, trust_tier)")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    console.error("Risk scoring: Failed to fetch listing:", listingError);
    return;
  }

  const photos = (listing.listing_photos as Array<{ url: string; position: number }>) || [];
  const photoUrls = photos
    .sort((a, b) => a.position - b.position)
    .map((p) => p.url);

  const sellerId = listing.seller_id as string;

  // Compute both scores in parallel
  const [aiScore, sellerScore] = await Promise.all([
    computeAIFraudScore(listing, photoUrls),
    computeSellerHistoryScore(sellerId),
  ]);

  // Combined weighted score: 60% AI + 40% seller history
  const riskScore = Math.round(aiScore * 0.6 + sellerScore * 0.4);

  // Update listing with risk score
  const { error: updateError } = await supabase
    .from("listings")
    .update({
      risk_score: riskScore,
      risk_scored_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  if (updateError) {
    console.error("Risk scoring: Failed to update listing:", updateError);
    return;
  }

  console.log(`Risk score computed for listing ${listingId}: ${riskScore} (AI: ${aiScore}, Seller: ${sellerScore})`);

  // Check auto-approve config
  const profiles = listing.profiles as { id: string; trust_tier: number } | null;
  const sellerTier = profiles?.trust_tier ?? 0;

  // Only auto-approve if listing is currently in pending_review status
  if (listing.status !== "pending_review") return;

  const { data: settings } = await supabase
    .from("admin_settings")
    .select("auto_approve_config")
    .single();

  const autoApproveConfig = (settings?.auto_approve_config as AutoApproveConfig) ?? {};
  const tierConfig = autoApproveConfig[String(sellerTier)];

  if (tierConfig?.enabled && riskScore < tierConfig.max_risk) {
    const { error: approveError } = await supabase
      .from("listings")
      .update({ status: "active" })
      .eq("id", listingId)
      .eq("status", "pending_review"); // Ensure still in pending_review

    if (approveError) {
      console.error("Risk scoring: Auto-approve failed:", approveError);
    } else {
      console.log(`Auto-approved listing ${listingId} (tier ${sellerTier}, risk ${riskScore} < ${tierConfig.max_risk})`);
    }
  }
}
