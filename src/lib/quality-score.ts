// ============================================================
// Auto quality-score (Phase 0.3)
//
// Explainable, deterministic-first quality checks for a listing — the
// review-queue / listing-detail "automated checks" panel (Screens 03/04).
// Kept SEPARATE from risk-scoring.ts: risk_score still drives auto-approve
// untouched; this adds a parallel, human-readable quality breakdown stored
// in `listings.quality_checks`.
//
// Six checks (Megha's named inputs). Five are deterministic (no AI, so the
// score degrades gracefully); `sharpness` needs image analysis and is
// currently reported as `unknown` and excluded from the roll-up until a
// vision signal is wired in (TODO).
// ============================================================

import { GoogleGenAI } from "@google/genai";
import { createSupabaseAdmin } from "./supabase.js";
import { findContactInfo } from "./validation.js";
import { logger } from "./logger.js";

/**
 * Rate a photo's sharpness 0–100 (100 = crisp) via Gemini vision.
 * Best-effort: returns null when the key is missing or the call fails, so
 * the check reports `unknown` and is excluded from the roll-up.
 */
async function computeSharpness(photoUrl: string): Promise<number | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !photoUrl) return null;
  try {
    // Fetch the actual image bytes so Gemini analyses the pixels (passing a
    // URL as text would make it guess without seeing the photo).
    const imgRes = await fetch(photoUrl);
    if (!imgRes.ok) return null;
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: b64 } },
            {
              text:
                "Rate the sharpness/focus of this product photo from 0 to 100 " +
                "(0 = very blurry/out of focus, 100 = tack sharp). Return JSON " +
                'only: {"sharpness": <number>}.',
            },
          ],
        },
      ],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    });
    const text = result.text?.trim();
    if (!text) return null;
    const parsed = JSON.parse(text) as { sharpness?: number };
    const s = parsed.sharpness;
    return typeof s === "number" && s >= 0 && s <= 100 ? Math.round(s) : null;
  } catch (err) {
    logger.error("quality.sharpness_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

type Verdict = "pass" | "near" | "fail" | "unknown";

interface QualityCheck {
  key: string;
  label: string;
  score: number; // 0–100
  verdict: Verdict;
  weight: number; // % contribution to the roll-up
  detail: string;
}

// Weights sum to 100 (Megha's spec). sharpness is unassessed for now, so the
// roll-up renormalizes over the checks that produced a real verdict.
const WEIGHTS = {
  image_count: 15,
  sharpness: 20,
  value_for_money: 15,
  banned_words: 20,
  seller_activity: 15,
  recency: 15,
} as const;

const verdictFor = (score: number): Verdict =>
  score >= 70 ? "pass" : score >= 40 ? "near" : "fail";

/**
 * Lightweight, synchronous quality score for LIST endpoints (review queue,
 * all-listings). Same deterministic checks as computeQualityScore but with NO
 * Gemini vision call and NO extra DB queries — every input is already on the
 * listing/seller row, so it's safe to run per-row in a list map.
 *
 * Returns a 0–100 roll-up + the per-check breakdown the review queue renders.
 */
export function deterministicQuality(input: {
  productCount: number;
  price: number | null;
  originalPrice: number | null;
  title?: string | null;
  description?: string | null;
  sellerCreatedAt?: string | null;
  sellerQuality?: number | null;
  updatedAt?: string | null;
}): { score: number | null; checks: QualityCheck[] } {
  // Display rows mirror Megha's Screen-03 breakdown exactly:
  //   3+ clear images · Sharpness · Value for money · Seller activity · Last edited
  const checks: QualityCheck[] = [];

  // 1. 3+ clear images
  const imgScore = input.productCount >= 3 ? 100 : input.productCount >= 2 ? 60 : 20;
  checks.push({
    key: "images",
    label: "3+ clear images",
    score: imgScore,
    verdict: verdictFor(imgScore),
    weight: 30,
    detail: input.productCount >= 3 ? `${input.productCount}/${input.productCount}` : `${input.productCount}/3`,
  });

  // 2. Sharpness — needs Gemini vision, not assessed in the lightweight score.
  checks.push({
    key: "sharpness",
    label: "Sharpness",
    score: 0,
    verdict: "unknown",
    weight: 0,
    detail: "not assessed",
  });

  // 3. Value for money
  let vfmScore = 100;
  let vfmDetail = "fair price";
  if (input.originalPrice && input.price && input.originalPrice > 0 && input.price <= input.originalPrice) {
    const depth = (input.originalPrice - input.price) / input.originalPrice;
    vfmDetail = `${Math.round(depth * 100)}% off`;
    vfmScore = depth <= 0.5 ? 100 : depth <= 0.8 ? 60 : 25;
  }
  checks.push({
    key: "value_for_money",
    label: "Value for money",
    score: vfmScore,
    verdict: verdictFor(vfmScore),
    weight: 25,
    detail: vfmDetail,
  });

  // 4. Seller activity
  let days: number | null = null;
  if (input.sellerCreatedAt) {
    days = (Date.now() - new Date(input.sellerCreatedAt).getTime()) / (1000 * 60 * 60 * 24);
  }
  const sq = input.sellerQuality ?? null;
  let actScore = 40;
  let actDetail = "new";
  if ((sq ?? 0) >= 3.5 || (days ?? 0) > 180) {
    actScore = 100;
    actDetail = "established";
  } else if ((sq ?? 0) >= 2 || (days ?? 0) >= 30) {
    actScore = 70;
    actDetail = "active";
  }
  checks.push({
    key: "seller_activity",
    label: "Seller activity",
    score: actScore,
    verdict: verdictFor(actScore),
    weight: 25,
    detail: actDetail,
  });

  // 5. Last edited (display only — from the listing's updated_at)
  let editedDetail = "—";
  if (input.updatedAt) {
    const hrs = (Date.now() - new Date(input.updatedAt).getTime()) / (1000 * 60 * 60);
    editedDetail = hrs < 1 ? "just now" : hrs < 24 ? `${Math.floor(hrs)}h` : `${Math.floor(hrs / 24)}d`;
  }
  checks.push({
    key: "last_edited",
    label: "Last edited",
    score: 100,
    verdict: "pass",
    weight: 0,
    detail: editedDetail,
  });

  // Contact info in title/description is a hard penalty (not shown as a row).
  const banned = findContactInfo(input.title || "") || findContactInfo(input.description || "");

  const scored = checks.filter((ch) => ch.weight > 0 && ch.verdict !== "unknown");
  const totalW = scored.reduce((s, ch) => s + ch.weight, 0);
  let score =
    totalW > 0 ? Math.round(scored.reduce((s, ch) => s + ch.score * ch.weight, 0) / totalW) : null;
  if (banned && score != null) score = Math.min(score, 25);
  return { score, checks };
}

/**
 * Compute + persist the quality-check breakdown for a listing.
 * Fire-and-forget: logs on failure, never throws to the caller.
 */
export async function computeQualityScore(listingId: string): Promise<void> {
  try {
    const supabase = createSupabaseAdmin();

    const { data: listing, error } = await supabase
      .from("listings")
      .select(
        "id, title, description, price_amount, original_price_amount, seller_id, " +
          "listing_photos(url, position, photo_type), " +
          "profiles!listings_seller_id_fkey(id, created_at, seller_quality)"
      )
      .eq("id", listingId)
      .single();

    if (error || !listing) {
      logger.error("quality.fetch_failed", { listingId, error: error?.message });
      return;
    }
    const row = listing as unknown as Record<string, unknown>;

    const photos =
      (row.listing_photos as Array<Record<string, unknown>> | null) || [];
    const productCount = photos.filter(
      (p) => ((p.photo_type as string | null) ?? "product") === "product"
    ).length;
    const seller = row.profiles as Record<string, unknown> | null;
    const sellerId = row.seller_id as string;

    const checks: QualityCheck[] = [];

    // 1. image_count — more product photos = more trustworthy.
    const imgScore = productCount >= 4 ? 100 : productCount >= 2 ? 60 : 20;
    checks.push({
      key: "image_count",
      label: "Photo count",
      score: imgScore,
      verdict: verdictFor(imgScore),
      weight: WEIGHTS.image_count,
      detail: `${productCount} product photo${productCount === 1 ? "" : "s"}`,
    });

    // 2. value_for_money — a too-good-to-be-true discount is a red flag.
    const price = row.price_amount as number | null;
    const orig = row.original_price_amount as number | null;
    let vfmScore = 100;
    let vfmDetail = "no original price set";
    if (orig && price && orig > 0 && price <= orig) {
      const depth = (orig - price) / orig;
      vfmDetail = `${Math.round(depth * 100)}% below original`;
      vfmScore = depth <= 0.5 ? 100 : depth <= 0.8 ? 60 : 25;
    }
    checks.push({
      key: "value_for_money",
      label: "Value for money",
      score: vfmScore,
      verdict: verdictFor(vfmScore),
      weight: WEIGHTS.value_for_money,
      detail: vfmDetail,
    });

    // 3. banned_words — contact info / off-platform routing in title/desc.
    const banned =
      findContactInfo(row.title as string) ||
      findContactInfo(row.description as string);
    checks.push({
      key: "banned_words",
      label: "Banned words / contact info",
      score: banned ? 15 : 100,
      verdict: banned ? "fail" : "pass",
      weight: WEIGHTS.banned_words,
      detail: banned ? `found ${banned}` : "clean",
    });

    // 4. seller_activity — completed sales, active inventory, admin quality.
    const [{ count: activeListings }, { count: completedSales }] =
      await Promise.all([
        supabase
          .from("listings")
          .select("id", { count: "exact", head: true })
          .eq("seller_id", sellerId)
          .eq("status", "active"),
        supabase
          .from("orders")
          .select("id", { count: "exact", head: true })
          .eq("seller_id", sellerId)
          .eq("status", "complete"),
      ]);
    const sales = completedSales ?? 0;
    const active = activeListings ?? 0;
    const sq = (seller?.seller_quality as number | null) ?? null;
    let actScore: number;
    if (sales >= 3 || (sq ?? 0) >= 3.5) actScore = 100;
    else if (sales >= 1 || active >= 3 || (sq ?? 0) >= 2) actScore = 70;
    else actScore = 40;
    checks.push({
      key: "seller_activity",
      label: "Seller activity",
      score: actScore,
      verdict: verdictFor(actScore),
      weight: WEIGHTS.seller_activity,
      detail: `${sales} sale${sales === 1 ? "" : "s"}, ${active} active${
        sq != null ? `, quality ${sq}` : ""
      }`,
    });

    // 5. recency — brand-new accounts warrant a closer look.
    let recScore = 60;
    let recDetail = "unknown account age";
    if (seller?.created_at) {
      const days =
        (Date.now() - new Date(seller.created_at as string).getTime()) /
        (1000 * 60 * 60 * 24);
      recScore = days > 90 ? 100 : days >= 30 ? 70 : days >= 7 ? 50 : 30;
      recDetail = `account ${Math.floor(days)} day${
        Math.floor(days) === 1 ? "" : "s"
      } old`;
    }
    checks.push({
      key: "recency",
      label: "Account age",
      score: recScore,
      verdict: verdictFor(recScore),
      weight: WEIGHTS.recency,
      detail: recDetail,
    });

    // 6. sharpness — Gemini vision on the cover product photo (best-effort;
    // `unknown` + excluded from the roll-up when unavailable).
    const coverPhoto = photos
      .filter((p) => ((p.photo_type as string | null) ?? "product") === "product")
      .sort(
        (a, b) => ((a.position as number) ?? 0) - ((b.position as number) ?? 0)
      )[0];
    const sharpness = coverPhoto
      ? await computeSharpness(coverPhoto.url as string)
      : null;
    checks.push({
      key: "sharpness",
      label: "Photo sharpness",
      score: sharpness ?? 0,
      verdict: sharpness == null ? "unknown" : verdictFor(sharpness),
      weight: WEIGHTS.sharpness,
      detail: sharpness == null ? "not assessed" : `sharpness ${sharpness}/100`,
    });

    // Roll-up: weighted mean over checks with a real verdict; renormalize so
    // an `unknown` check doesn't drag the score toward zero.
    const scored = checks.filter((ch) => ch.verdict !== "unknown");
    const totalW = scored.reduce((s, ch) => s + ch.weight, 0);
    const rollup =
      totalW > 0
        ? Math.round(
            scored.reduce((s, ch) => s + ch.score * ch.weight, 0) / totalW
          )
        : null;

    const { error: updateError } = await supabase
      .from("listings")
      .update({
        quality_checks: {
          checks,
          score: rollup,
          scored_at: new Date().toISOString(),
        },
      })
      .eq("id", listingId);

    if (updateError) {
      logger.error("quality.update_failed", { listingId, error: updateError.message });
    }
  } catch (err) {
    logger.error("quality.compute_failed", {
      listingId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
