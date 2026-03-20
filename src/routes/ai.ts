import { Hono } from "hono";
import { GoogleGenAI } from "@google/genai";
import { clerkMiddleware } from "../middleware/clerk.js";
import { removeBackground } from "../lib/background-removal.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  OCCASION_TAGS,
  FABRIC_TYPES,
  WORK_TYPES,
} from "../types/listings.js";
import type {
  AIAnalysisResponse,
  AIField,
  AIErrorResponse,
  PhotoQualityAssessment,
} from "../types/ai.js";

const ai = new Hono();

// Maximum base64 photo size: 4MB
const MAX_PHOTO_SIZE = 4 * 1024 * 1024;

/**
 * POST /api/ai/analyze
 *
 * Accepts base64-encoded photos, sends them to Gemini for multimodal analysis,
 * and returns structured listing data with per-field confidence scores.
 *
 * Requires authentication (clerkMiddleware).
 * Retries once on Gemini failure. Returns fallback error on double failure.
 */
ai.post("/analyze", clerkMiddleware, async (c) => {
  // Parse request body
  let body: { photos?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate photos array
  if (!body.photos || !Array.isArray(body.photos) || body.photos.length === 0) {
    return c.json({ error: "At least one photo is required" }, 400);
  }

  // Validate individual photo sizes (4MB max each)
  for (const photo of body.photos) {
    if (typeof photo !== "string") {
      return c.json({ error: "Photos must be base64 strings" }, 400);
    }
    if (photo.length > MAX_PHOTO_SIZE) {
      return c.json({ error: "Photo exceeds 4MB size limit" }, 413);
    }
  }

  // Limit to first 3 photos to keep token count reasonable
  const photos = body.photos.slice(0, 3);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return c.json({ error: "AI service not configured", fallback: true } satisfies AIErrorResponse, 503);
  }

  const genAI = new GoogleGenAI({ apiKey });

  // Build multimodal prompt with inline image data
  const imageParts = photos.map((photo) => ({
    inlineData: {
      mimeType: "image/jpeg" as const,
      data: photo,
    },
  }));

  const prompt = `Analyze these photos of a South Asian fashion item for a preloved marketplace listing.
Return a JSON object with these fields:
- category: one of [Lehenga, Saree, Suit/Salwar, Anarkali, Indowestern, Sharara, Jewellery, Dupatta, Blouse, Menswear, Kidswear, Other]
- category_confidence: confidence score 0-100
- title: a descriptive marketplace title (max 200 chars)
- title_confidence: confidence score 0-100
- description: detailed description mentioning fabric, embroidery, color details, occasion suitability (max 500 chars)
- description_confidence: confidence score 0-100
- suggested_price: price in AUD cents (integer), based on typical preloved prices for this category and apparent condition
- suggested_price_confidence: confidence score 0-100
- condition: one of [New, Like New, Good, Fair]
- condition_confidence: confidence score 0-100
- colors: array of 1-4 dominant colors (lowercase)
- colors_confidence: confidence score 0-100
- occasion_tags: array from [Wedding, Mehendi, Sangeet, Festive, Party, Formal, Casual]
- occasion_tags_confidence: confidence score 0-100
- photo_quality: array of objects for each photo, each with:
  - index: photo index (0-based)
  - is_blurry: boolean (true if image appears out of focus or motion-blurred)
  - is_dark: boolean (true if image is underexposed or poorly lit)
  - quality_score: 0-100 (100 = excellent, crisp, well-lit)
  - issues: array of strings describing quality problems (e.g., "image is too dark", "image appears blurry/out of focus", "image has poor lighting")
- designer_name: detected or suggested designer name (string or null if not recognizable). Look for labels, tags, distinctive styles.
- designer_name_confidence: confidence score 0-100
- fabric_types: array of detected fabric types from this list: [${FABRIC_TYPES.join(", ")}]
- fabric_types_confidence: confidence score 0-100
- work_types: array of detected embroidery/work types from this list: [${WORK_TYPES.join(", ")}]
- work_types_confidence: confidence score 0-100

For each field, also provide a confidence score (0-100).
Return valid JSON only, no markdown formatting.`;

  // Attempt with one retry on failure
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [prompt, ...imageParts],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });
      const responseText = result.text ?? "";
      const parsed = JSON.parse(responseText);

      // Map and validate response
      const response = mapGeminiResponse(parsed);
      return c.json(response, 200);
    } catch (error) {
      lastError = error;
      // Continue to retry
    }
  }

  // Both attempts failed
  console.error("AI analysis failed after retry:", lastError);
  return c.json(
    { error: "AI analysis failed", fallback: true } satisfies AIErrorResponse,
    503
  );
});

/**
 * POST /api/ai/remove-background
 *
 * Accepts a base64-encoded photo, removes the background using
 * @imgly/background-removal-node, and composites onto a soft gradient.
 *
 * Requires authentication (clerkMiddleware).
 */
ai.post("/remove-background", clerkMiddleware, async (c) => {
  // Parse request body
  let body: { photo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate photo
  if (!body.photo || typeof body.photo !== "string") {
    return c.json({ error: "Photo is required" }, 400);
  }

  if (body.photo.length > MAX_PHOTO_SIZE) {
    return c.json({ error: "Photo exceeds 4MB size limit" }, 413);
  }

  try {
    const processedPhoto = await removeBackground(body.photo);
    return c.json(
      {
        processed_photo: processedPhoto,
        original_photo: body.photo,
      },
      200
    );
  } catch (error) {
    console.error("Background removal failed:", error);
    return c.json(
      { error: "Background removal failed", fallback: true } satisfies AIErrorResponse,
      503
    );
  }
});

/**
 * Map Gemini's raw JSON response to the AIAnalysisResponse format.
 * Validates enum fields against known values, setting confidence to 0 for invalid values.
 */
function mapGeminiResponse(raw: Record<string, unknown>): AIAnalysisResponse {
  const categoryValid = LISTING_CATEGORIES.includes(raw.category as any);
  const conditionValid = LISTING_CONDITIONS.includes(raw.condition as any);

  // Validate occasion tags
  const rawTags = Array.isArray(raw.occasion_tags) ? raw.occasion_tags : [];
  const validTags = rawTags.filter((tag: unknown) =>
    OCCASION_TAGS.includes(tag as any)
  );

  // Parse photo quality assessments
  const rawPhotoQuality = Array.isArray(raw.photo_quality) ? raw.photo_quality : [];
  const photoQuality: PhotoQualityAssessment[] = rawPhotoQuality.map((pq: any, i: number) => ({
    index: typeof pq?.index === "number" ? pq.index : i,
    is_blurry: pq?.is_blurry === true,
    is_dark: pq?.is_dark === true,
    quality_score: toConfidence(pq?.quality_score),
    issues: Array.isArray(pq?.issues) ? pq.issues.map(String) : [],
  }));

  // Validate fabric types
  const rawFabricTypes = Array.isArray(raw.fabric_types) ? raw.fabric_types : [];
  const validFabricTypes = rawFabricTypes
    .map(String)
    .filter((ft: string) => (FABRIC_TYPES as readonly string[]).includes(ft));

  // Validate work types
  const rawWorkTypes = Array.isArray(raw.work_types) ? raw.work_types : [];
  const validWorkTypes = rawWorkTypes
    .map(String)
    .filter((wt: string) => (WORK_TYPES as readonly string[]).includes(wt));

  return {
    category: {
      value: String(raw.category || "Other"),
      confidence: categoryValid ? toConfidence(raw.category_confidence) : 0,
    },
    title: {
      value: String(raw.title || "").slice(0, 200),
      confidence: toConfidence(raw.title_confidence),
    },
    description: {
      value: String(raw.description || "").slice(0, 500),
      confidence: toConfidence(raw.description_confidence),
    },
    suggested_price: {
      value: toInt(raw.suggested_price),
      confidence: toConfidence(raw.suggested_price_confidence),
    },
    condition: {
      value: String(raw.condition || "Good"),
      confidence: conditionValid ? toConfidence(raw.condition_confidence) : 0,
    },
    colors: {
      value: Array.isArray(raw.colors)
        ? raw.colors.map(String).slice(0, 4)
        : [],
      confidence: toConfidence(raw.colors_confidence),
    },
    occasion_tags: {
      value: validTags.map(String),
      confidence: toConfidence(raw.occasion_tags_confidence),
    },

    // v2 fields
    photo_quality: {
      value: photoQuality,
      confidence: photoQuality.length > 0 ? toConfidence(raw.photo_quality_confidence ?? 80) : 0,
    },
    designer_name: {
      value: raw.designer_name != null ? String(raw.designer_name) : null,
      confidence: toConfidence(raw.designer_name_confidence),
    },
    fabric_types: {
      value: validFabricTypes,
      confidence: toConfidence(raw.fabric_types_confidence),
    },
    work_types: {
      value: validWorkTypes,
      confidence: toConfidence(raw.work_types_confidence),
    },
  };
}

/** Clamp a value to a valid confidence score (0-100) */
function toConfidence(val: unknown): number {
  const num = Number(val);
  if (isNaN(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

/** Convert a value to a positive integer (for price in cents) */
function toInt(val: unknown): number {
  const num = Number(val);
  if (isNaN(num) || num < 0) return 0;
  return Math.round(num);
}

// ============================================================
// Conversation AI Summary
// ============================================================

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/ai/conversations/:id/summary
 *
 * Generate a 2-3 sentence AI summary of a conversation with 15+ messages.
 * Requires authentication. User must be a participant (buyer or seller).
 */
ai.post("/conversations/:id/summary", clerkMiddleware, async (c) => {
  const conversationId = c.req.param("id");

  if (!UUID_REGEX.test(conversationId)) {
    return c.json({ error: "Invalid conversation ID format" }, 400);
  }

  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Look up profile from Clerk ID
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("clerk_id", clerkUserId)
    .single();

  if (profileError || !profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const profileId = profile.id;

  // Verify the user is a participant
  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("id, buyer_id, seller_id")
    .eq("id", conversationId)
    .single();

  if (convError || !conversation) {
    return c.json({ error: "Conversation not found" }, 404);
  }

  if (conversation.buyer_id !== profileId && conversation.seller_id !== profileId) {
    return c.json({ error: "Not authorized to view this conversation" }, 403);
  }

  // Fetch all messages ordered by created_at ascending
  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("sender_id, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (messagesError || !messages) {
    return c.json({ error: "Failed to fetch messages" }, 500);
  }

  if (messages.length < 15) {
    return c.json({ error: "Conversation too short for summary" }, 400);
  }

  // Build text representation with buyer/seller roles
  const messagesText = messages
    .map((msg) => {
      const role = msg.sender_id === conversation.buyer_id ? "Buyer" : "Seller";
      return `${role}: ${msg.content || "[non-text message]"}`;
    })
    .join("\n");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return c.json({ error: "AI service not configured" }, 503);
  }

  const genAI = new GoogleGenAI({ apiKey });

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        `Summarize this conversation between a buyer and seller about a fashion listing in 2-3 concise sentences. Focus on what was discussed, any agreements, and pending items:\n\n${messagesText}`,
      ],
      config: {
        temperature: 0.3,
      },
    });

    const summary = result.text ?? "";
    return c.json({ summary });
  } catch (error) {
    console.error("AI conversation summary failed:", error);
    return c.json({ error: "Failed to generate summary" }, 500);
  }
});

// ============================================================
// ISO AI Matching
// ============================================================

/**
 * Convert a size label to a bust measurement range in inches.
 * Used to filter listing candidates by measurements when an ISO post specifies a size.
 */
function sizeToBustRange(size: string): { min: number; max: number } | null {
  const map: Record<string, { min: number; max: number }> = {
    XS: { min: 0, max: 32 },
    S: { min: 32, max: 34 },
    M: { min: 34, max: 36 },
    L: { min: 36, max: 38 },
    XL: { min: 38, max: 40 },
    XXL: { min: 40, max: 100 },
  };
  return map[size.toUpperCase()] || null;
}

/**
 * AI-powered listing matching for an ISO post.
 *
 * Two-step approach:
 *  1. SQL pre-filter by category/size/budget/market to get candidates
 *  2. Gemini ranking of candidates for relevance
 *
 * Stores top 3 matches via upsert into iso_matches.
 * Returns the number of matches stored (0 on failure or no candidates).
 */
export async function matchISOPost(isoPostId: string): Promise<number> {
  const supabase = createSupabaseAdmin();

  // Fetch the ISO post
  const { data: isoPost, error: postError } = await supabase
    .from("iso_posts")
    .select("id, description, category, size, budget_min, budget_max, market, status")
    .eq("id", isoPostId)
    .single();

  if (postError || !isoPost) {
    console.error("[ISO Match] Post not found:", isoPostId);
    return 0;
  }

  if (isoPost.status !== "active") {
    return 0;
  }

  // Step 1: SQL pre-filter
  let query = supabase
    .from("listings")
    .select(
      "id, title, description, category, price_amount, price_currency, measurements, seller_id, profiles!listings_seller_id_fkey(location)"
    )
    .eq("status", "active");

  if (isoPost.category) {
    query = query.eq("category", isoPost.category);
  }
  if (isoPost.budget_min != null) {
    query = query.gte("price_amount", isoPost.budget_min);
  }
  if (isoPost.budget_max != null) {
    query = query.lte("price_amount", isoPost.budget_max);
  }

  query = query.limit(20);

  const { data: rawCandidates, error: candidateError } = await query;

  if (candidateError || !rawCandidates) {
    console.error("[ISO Match] Candidate query failed:", candidateError);
    return 0;
  }

  // Post-filter by market (seller location) and bust size
  const bustRange = isoPost.size ? sizeToBustRange(isoPost.size) : null;

  const candidates = (rawCandidates as Record<string, unknown>[]).filter((listing) => {
    // Filter by market via seller profile location
    const profiles = listing.profiles as Record<string, unknown> | null;
    if (isoPost.market && profiles) {
      if (profiles.location !== isoPost.market) return false;
    }

    // Filter by bust range if ISO post specifies a size
    if (bustRange) {
      const measurements = listing.measurements as Record<string, unknown> | null;
      if (measurements && measurements.bust != null) {
        const bust = Number(measurements.bust);
        if (!isNaN(bust)) {
          if (bust < bustRange.min || bust > bustRange.max) return false;
        }
      }
      // If no bust measurement, still include -- don't exclude items missing data
    }

    return true;
  });

  if (candidates.length === 0) {
    return 0;
  }

  // Step 2: Gemini ranking
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("[ISO Match] GEMINI_API_KEY not set, skipping AI ranking");
    return 0;
  }

  const genAI = new GoogleGenAI({ apiKey });

  const candidateList = candidates.map((c) => ({
    id: c.id,
    title: c.title,
    description: (c.description as string || "").slice(0, 200),
    price: c.price_amount,
    category: c.category,
  }));

  const prompt = `You are a matching engine for a South Asian fashion marketplace.

A buyer posted an "In Search Of" (ISO) request:
- Description: "${isoPost.description}"
${isoPost.category ? `- Category: ${isoPost.category}` : ""}
${isoPost.size ? `- Size: ${isoPost.size}` : ""}
${isoPost.budget_min != null ? `- Budget min: $${(isoPost.budget_min / 100).toFixed(2)}` : ""}
${isoPost.budget_max != null ? `- Budget max: $${(isoPost.budget_max / 100).toFixed(2)}` : ""}

Here are candidate listings:
${JSON.stringify(candidateList, null, 2)}

Rank the top 3 most relevant listings. For each, provide:
- listing_id: the id of the listing
- score: relevance score 0-100
- reasons: array of matching reasons from ONLY these values: "category", "size", "in_budget", "style_match", "color_match", "fabric_match", "occasion_match"

Return a JSON array: [{ "listing_id": "...", "score": 0, "reasons": [...] }]
Return valid JSON only, no markdown formatting. If fewer than 3 match well, return fewer.`;

  let ranked: Array<{ listing_id: string; score: number; reasons: string[] }> = [];

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [prompt],
      config: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });
    const responseText = result.text ?? "";
    const parsed = JSON.parse(responseText);

    if (Array.isArray(parsed)) {
      ranked = parsed;
    } else if (Array.isArray(parsed.matches)) {
      ranked = parsed.matches;
    }
  } catch (err) {
    console.error("[ISO Match] Gemini ranking failed:", err);
    return 0;
  }

  // Validate listing_ids are in the candidate set
  const candidateIds = new Set(candidates.map((c) => c.id as string));
  const validReasons = new Set([
    "category",
    "size",
    "in_budget",
    "style_match",
    "color_match",
    "fabric_match",
    "occasion_match",
  ]);

  ranked = ranked
    .filter((r) => candidateIds.has(r.listing_id))
    .slice(0, 3)
    .map((r) => ({
      ...r,
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reasons: Array.isArray(r.reasons)
        ? r.reasons.filter((reason) => validReasons.has(reason))
        : [],
    }));

  if (ranked.length === 0) {
    return 0;
  }

  // Step 3: Store matches via upsert
  const upsertRows = ranked.map((r) => ({
    iso_post_id: isoPostId,
    listing_id: r.listing_id,
    match_score: r.score,
    match_reasons: r.reasons,
    updated_at: new Date().toISOString(),
  }));

  const { error: upsertError } = await supabase
    .from("iso_matches")
    .upsert(upsertRows, {
      onConflict: "iso_post_id,listing_id",
    });

  if (upsertError) {
    console.error("[ISO Match] Upsert failed:", upsertError);
    return 0;
  }

  console.log(`[ISO Match] Stored ${ranked.length} matches for ISO post ${isoPostId}`);
  return ranked.length;
}

export default ai;
