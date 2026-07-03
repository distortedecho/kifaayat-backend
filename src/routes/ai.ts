import { Hono } from "hono";
import { GoogleGenAI } from "@google/genai";
import PQueue from "p-queue";
import crypto from "crypto";
import { clerkMiddleware } from "../middleware/clerk.js";
import { removeBackground } from "../lib/background-removal.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  FABRIC_TYPES,
  WORK_TYPES,
  PRIMARY_COLOURS,
  SUB_CATEGORIES_BY_CATEGORY,
  isValidSubCategoryPair,
} from "../types/listings.js";
import type {
  AIAnalysisResponse,
  AIField,
  AIErrorResponse,
} from "../types/ai.js";

const ai = new Hono();

// Maximum base64 photo size: 4MB
const MAX_PHOTO_SIZE = 4 * 1024 * 1024;

// ============================================================
// Gemini Request Queues (Phase 2.3)
//
// We have a single Gemini API key that must serve up to 20k
// users plus a background cron worker. Two separate queues
// keep user-facing traffic from being starved by cron bursts.
// ============================================================

/**
 * User-facing queue: moderate throughput, higher priority.
 * Allows 5 parallel requests, up to 25 per minute.
 */
export const userGeminiQueue = new PQueue({
  concurrency: 5,
  intervalCap: 25,
  interval: 60_000,
});

/**
 * Cron/background queue: strictly throttled so a bulk refresh
 * cannot saturate the Gemini key and block real users.
 * Allows 1 in-flight request, up to 5 per minute.
 */
export const cronGeminiQueue = new PQueue({
  concurrency: 1,
  intervalCap: 5,
  interval: 60_000,
});

/**
 * Fires one tiny Gemini call at server boot so the SDK, HTTP client,
 * and Google's edge connection are warm by the time the first real
 * user request hits /analyze. Without this the first call after a
 * deploy/restart adds ~3-5s of cold-start latency on top of the
 * normal Gemini inference time, which combined with photo upload
 * over cellular pushes some Android clients past their fetch timeout.
 *
 * Non-blocking: never throws back to startup, never blocks the port
 * binding. Skipped silently if GEMINI_API_KEY is unset (dev/CI).
 */
export async function prewarmGemini(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;
  try {
    const genAI = new GoogleGenAI({ apiKey });
    await userGeminiQueue.add(async () => {
      await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: ["ping"],
        config: { temperature: 0, maxOutputTokens: 1 },
      });
    });
    console.log("[AI Prewarm] Gemini SDK warmed up");
  } catch (err) {
    console.warn(
      "[AI Prewarm] Failed (non-fatal):",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ============================================================
// Per-user AI rate limit (Phase 2.3)
//
// In-memory sliding-window limit: max 5 Gemini-backed calls
// per Clerk user per hour. This sits on top of the existing
// IP-based aiLimiter in middleware/rateLimiter.ts.
// ============================================================

const USER_AI_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const USER_AI_LIMIT_MAX = 10;
const userAICalls = new Map<string, number[]>();

/**
 * Returns true if the user is within their hourly AI call budget
 * and records the call. Returns false if they are over budget.
 */
function checkUserAILimit(userId: string): boolean {
  const now = Date.now();
  const existing = userAICalls.get(userId) || [];
  const calls = existing.filter((t) => now - t < USER_AI_LIMIT_WINDOW_MS);
  if (calls.length >= USER_AI_LIMIT_MAX) {
    userAICalls.set(userId, calls);
    return false;
  }
  calls.push(now);
  userAICalls.set(userId, calls);
  return true;
}

// ============================================================
// AI analysis result cache (Phase 2.3)
//
// Keyed by SHA256 of the first 1000 chars of each photo joined.
// Prevents duplicate Gemini spend when users re-enter the listing
// flow with the same photos. TTL 1 hour.
// ============================================================

const AI_CACHE_TTL_MS = 60 * 60 * 1000;
const aiCache = new Map<string, { result: AIAnalysisResponse; expiry: number }>();

function getCacheKey(photos: string[]): string {
  // Hash the entire base64 payload. The previous "first 1000 chars only"
  // approach silently collided whenever two photos went through the same
  // encoding pipeline (e.g. both downloaded from the Kifaayat image CDN)
  // because the leading bytes of a JPEG are quant tables / Huffman
  // tables / SOF0 dimensions — all identical for any two images at the
  // same resolution + quality. Different outfits, same cache key, same
  // returned AI result. SHA-256 over the full payload is fast (<10ms for
  // a 500KB string) and eliminates the collision class entirely.
  const hash = crypto.createHash("sha256");
  for (const p of photos) {
    hash.update(p);
    hash.update("|");
  }
  return hash.digest("hex");
}

function getCachedAnalysis(key: string): AIAnalysisResponse | null {
  const entry = aiCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    aiCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCachedAnalysis(key: string, result: AIAnalysisResponse): void {
  aiCache.set(key, { result, expiry: Date.now() + AI_CACHE_TTL_MS });
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated;
}

function truncateAtSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSentenceEnd = Math.max(
    truncated.lastIndexOf(". "),
    truncated.lastIndexOf(".\n"),
    truncated.lastIndexOf(". ")
  );
  if (lastSentenceEnd > maxLen * 0.5) return truncated.slice(0, lastSentenceEnd + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxLen * 0.6 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Detect MIME type from base64-encoded image data by inspecting magic bytes.
 * Falls back to "image/jpeg" if the format is unrecognized.
 */
function detectMimeType(base64Data: string): string {
  // Check magic bytes at the start of the base64 string
  // PNG: iVBOR (base64 of \x89PNG)
  if (base64Data.startsWith("iVBOR")) return "image/png";
  // JPEG: /9j/ (base64 of \xFF\xD8\xFF)
  if (base64Data.startsWith("/9j/")) return "image/jpeg";
  // WebP: UklGR (base64 of RIFF)
  if (base64Data.startsWith("UklGR")) return "image/webp";
  // GIF: R0lGOD (base64 of GIF8)
  if (base64Data.startsWith("R0lGOD")) return "image/gif";
  // HEIC/HEIF: starts with various ftyp box signatures
  // Base64 of \x00\x00\x00 ftyp patterns — check for "AAAA" prefix (common ftyp box start)
  if (base64Data.startsWith("AAAAH") || base64Data.startsWith("AAAAI")) return "image/heic";
  // Default fallback
  return "image/jpeg";
}

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
  const requestStart = Date.now();
  const clerkUserId = c.get("clerkUserId") ?? "unknown";
  console.log(`[AI Analyze] Request received from user=${clerkUserId}`);

  // Parse request body
  let body: { photos?: string[] };
  try {
    body = await c.req.json();
  } catch {
    console.warn(`[AI Analyze] Invalid JSON body from user=${clerkUserId}`);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Validate photos array
  if (!body.photos || !Array.isArray(body.photos) || body.photos.length === 0) {
    console.warn(`[AI Analyze] No photos provided by user=${clerkUserId}`);
    return c.json({ error: "At least one photo is required" }, 400);
  }

  // Validate individual photo sizes (4MB max each)
  for (const photo of body.photos) {
    if (typeof photo !== "string") {
      return c.json({ error: "Photos must be base64 strings" }, 400);
    }
    if (photo.length > MAX_PHOTO_SIZE) {
      console.warn(`[AI Analyze] Photo exceeds 4MB limit, size=${photo.length} user=${clerkUserId}`);
      return c.json({ error: "Photo exceeds 4MB size limit" }, 413);
    }
  }

  // Limit to first 3 photos to keep token count reasonable
  const photos = body.photos.slice(0, 3);
  console.log(`[AI Analyze] Processing ${photos.length} photos for user=${clerkUserId}`);

  // Cache lookup — return instantly if we've seen these exact photos recently.
  // We check cache BEFORE the per-user rate limit so cache hits don't burn quota.
  const cacheKey = getCacheKey(photos);
  const cached = getCachedAnalysis(cacheKey);
  if (cached) {
    const elapsed = Date.now() - requestStart;
    console.log(`[AI Analyze] Cache hit for user=${clerkUserId} in ${elapsed}ms`);
    return c.json(cached, 200);
  }

  // Per-user hourly rate limit (max 5 Gemini calls/hour/user).
  if (!checkUserAILimit(clerkUserId)) {
    console.warn(`[AI Analyze] Per-user rate limit exceeded for user=${clerkUserId}`);
    return c.json(
      { error: "AI analysis rate limit reached. Please try again later.", fallback: true } satisfies AIErrorResponse,
      429
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return c.json({ error: "AI service not configured", fallback: true } satisfies AIErrorResponse, 503);
  }

  const genAI = new GoogleGenAI({ apiKey });

  // Build multimodal prompt with inline image data, detecting MIME type per photo
  const imageParts = photos.map((photo, idx) => {
    const mimeType = detectMimeType(photo);
    console.log(`[AI Analyze] Photo ${idx}: mimeType=${mimeType}, size=${photo.length} chars`);
    return {
      inlineData: {
        mimeType,
        data: photo,
      },
    };
  });

  // Categories: strip "Other" so the model has to pick a specific category
  // rather than fall back to the generic bucket. Users can manually choose
  // "Other" on the form if the AI returns a low-confidence guess.
  const aiCategoryOptions = LISTING_CATEGORIES.filter((c) => c !== "Other");
  const prompt = `Analyze these photos of a South Asian fashion item for a preloved marketplace listing.
The photos are all meant to be of ONE item. If they instead clearly show MORE THAN ONE distinct item (e.g. a saree in one photo and shoes or jewellery in another), analyze only the PRIMARY item — the one most prominent, or the one in the first photo — and set "multiple_items_detected" to true. Otherwise set it to false. Always return a single JSON object (never an array).
Return a JSON object with these fields:
- multiple_items_detected: boolean — true only if the photos show multiple distinct items, else false.
- category: one of [${aiCategoryOptions.join(", ")}]. Pick the most specific category that fits — do NOT return any value outside this list.
- category_confidence: confidence score 0-100
- sub_category: ONLY return a value if category is "Jewellery" or "Footwear", and only from the corresponding list below. For Jewellery: [${SUB_CATEGORIES_BY_CATEGORY.Jewellery!.join(", ")}]. For Footwear: [${SUB_CATEGORIES_BY_CATEGORY.Footwear!.join(", ")}]. For any other category (Lehenga, Saree, Suit/Salwar, Indowestern, Blouse, Menswear, Kidswear), set this to null. The "Other" parent has its own sub-categories but we only ask for sub_category when the AI is confident — leave null for "Other" since users will pick manually.
- sub_category_confidence: confidence score 0-100
- title: a descriptive marketplace title (max 200 chars)
- title_confidence: confidence score 0-100
- description: detailed description mentioning fabric, embroidery, color details, occasion suitability (max 500 chars)
- description_confidence: confidence score 0-100
- suggested_price: price in AUD cents (integer), based on typical preloved prices for this category and apparent condition
- suggested_price_confidence: confidence score 0-100
- condition: one of [${LISTING_CONDITIONS.join(", ")}]
- condition_confidence: confidence score 0-100
- colors: array of 1-4 dominant colors from [${PRIMARY_COLOURS.join(", ")}]
- colors_confidence: confidence score 0-100
- designer_name: detected or suggested designer name (string or null if not recognizable). Look for labels, tags, distinctive styles.
- designer_name_confidence: confidence score 0-100
- fabric_types: array of detected fabric types from this list: [${FABRIC_TYPES.join(", ")}]
- fabric_types_confidence: confidence score 0-100
- work_types: array of detected embroidery/work types from this list: [${WORK_TYPES.join(", ")}]
- work_types_confidence: confidence score 0-100

For each field, also provide a confidence score (0-100).
Return valid JSON only, no markdown formatting.`;

  // Attempt with one retry on failure. Every Gemini call is queued
  // through userGeminiQueue so we never exceed the single-key budget.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const responseText = await userGeminiQueue.add(async () => {
        const result = await genAI.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [prompt, ...imageParts],
          config: {
            responseMimeType: "application/json",
            temperature: 0.2,
            // gemini-2.5-flash is a thinking model — by default it runs a
            // dynamic internal reasoning pass before answering, which adds
            // several seconds of latency. This endpoint is pure structured
            // extraction from an image (no multi-step reasoning needed), so
            // we disable thinking entirely. Typically 2-4x faster with no
            // measurable quality loss for this task.
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        return result.text ?? "";
      });
      const parsed = parseAnalysisResponse(responseText ?? "");

      // Map and validate response
      const response = mapGeminiResponse(parsed);
      setCachedAnalysis(cacheKey, response);
      const elapsed = Date.now() - requestStart;
      console.log(`[AI Analyze] Success for user=${clerkUserId} in ${elapsed}ms (attempt ${attempt + 1})`);
      return c.json(response, 200);
    } catch (error) {
      lastError = error;
      console.warn(`[AI Analyze] Attempt ${attempt + 1} failed for user=${clerkUserId}:`, error);
      // Continue to retry
    }
  }

  // Both attempts failed
  const elapsed = Date.now() - requestStart;
  const errMsg = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`[AI Analyze] Failed after 2 attempts for user=${clerkUserId} in ${elapsed}ms: ${errMsg}`);
  return c.json(
    { error: `AI analysis failed: ${errMsg}`, fallback: true } satisfies AIErrorResponse,
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
/**
 * Turn Gemini's raw text into the single object mapGeminiResponse expects.
 * Hardened against the ways the model deviates when it sees multiple items:
 *   - markdown-fenced JSON (```json ... ```)
 *   - a top-level ARRAY of item objects (multiple items) → take the first
 *     and flag multiple_items_detected
 * Throws only if there's genuinely no JSON object to be found.
 */
function parseAnalysisResponse(responseText: string): Record<string, unknown> {
  let text = (responseText ?? "").trim();
  // Strip ```json / ``` fences if the model added them despite JSON mime.
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    // Model returned one object per item — analyze the first, but remember
    // that there were several so the FE can warn the seller.
    const first = parsed.find((el) => el && typeof el === "object") as
      | Record<string, unknown>
      | undefined;
    if (!first) throw new Error("Empty analysis array");
    if (parsed.length > 1) first.multiple_items_detected = true;
    return first;
  }
  if (parsed && typeof parsed === "object") {
    return parsed as Record<string, unknown>;
  }
  throw new Error("Analysis response was not a JSON object");
}

function mapGeminiResponse(raw: Record<string, unknown>): AIAnalysisResponse {
  const categoryValid = LISTING_CATEGORIES.includes(raw.category as any);
  const conditionValid = LISTING_CONDITIONS.includes(raw.condition as any);

  // Validate the sub_category against the same vocabulary the listings
  // API enforces. If category isn't valid we can't pair anything, and
  // if Gemini returned a sub that doesn't match the parent it gets
  // dropped to null + confidence 0 — same hardening as category/condition.
  const rawSub =
    raw.sub_category == null || raw.sub_category === ""
      ? null
      : String(raw.sub_category);
  const subCategoryValid =
    categoryValid && isValidSubCategoryPair(String(raw.category), rawSub);

  // occasion_tags intentionally not surfaced — no UI accepts them, so
  // returning a suggestion would just be dead weight on the wire.
  // Re-enable by restoring the OCCASION_TAGS prompt block and the
  // mapping below if/when the seller form gets an occasion picker.

  // Validate colors against the canonical 20-color palette. Anything Gemini
  // hallucinates (e.g. "Mauve", "Champagne") gets dropped so the frontend
  // never has to render a color it doesn't have a swatch for.
  const rawColors = Array.isArray(raw.colors) ? raw.colors : [];
  const validColors = rawColors
    .map(String)
    .filter((c: string) => (PRIMARY_COLOURS as readonly string[]).includes(c))
    .slice(0, 4);

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
      // Drop invalid/hallucinated values entirely — empty string + confidence 0
      // signals to the frontend that no AI suggestion is available, instead of
      // leaking "Anarkali" or other categories that don't exist on the platform.
      value: categoryValid ? String(raw.category) : "",
      confidence: categoryValid ? toConfidence(raw.category_confidence) : 0,
    },
    sub_category: {
      // null = AI is not sure / category doesn't have sub-categories /
      // parent + sub pair didn't validate. Frontend should treat null
      // the same as "AI not sure": leave the field blank for the seller
      // to pick manually.
      value: subCategoryValid ? rawSub : null,
      confidence: subCategoryValid ? toConfidence(raw.sub_category_confidence) : 0,
    },
    title: {
      value: truncateAtWordBoundary(String(raw.title || ""), 100),
      confidence: toConfidence(raw.title_confidence),
    },
    description: {
      value: truncateAtSentenceBoundary(String(raw.description || ""), 500),
      confidence: toConfidence(raw.description_confidence),
    },
    suggested_price: {
      value: toInt(raw.suggested_price),
      confidence: toConfidence(raw.suggested_price_confidence),
    },
    condition: {
      // Same hardening — never surface a condition that's not in our enum.
      value: conditionValid ? String(raw.condition) : "",
      confidence: conditionValid ? toConfidence(raw.condition_confidence) : 0,
    },
    colors: {
      value: validColors,
      confidence: validColors.length > 0 ? toConfidence(raw.colors_confidence) : 0,
    },
    // occasion_tags removed from response — no FE UI accepts them yet.
    // photo_quality removed — FE doesn't render blur/dark warnings, and
    // the nested per-photo array was the single biggest chunk of output
    // tokens on the latency-critical path. Drop it to speed up analyze.

    // v2 fields
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
    multiple_items_detected: raw.multiple_items_detected === true,
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

  // Per-user rate limit for the summary endpoint.
  if (!checkUserAILimit(clerkUserId!)) {
    return c.json(
      { error: "AI rate limit reached. Please try again later." },
      429
    );
  }

  try {
    const summary = await userGeminiQueue.add(async () => {
      const result = await genAI.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [
          `Summarize this conversation between a buyer and seller about a fashion listing in 2-3 concise sentences. Focus on what was discussed, any agreements, and pending items:\n\n${messagesText}`,
        ],
        config: {
          temperature: 0.3,
        },
      });
      return result.text ?? "";
    });
    return c.json({ summary: summary ?? "" });
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
    // ISO matching runs from the cron path, so route it through
    // the throttled background queue to avoid starving users.
    const responseText = await cronGeminiQueue.add(async () => {
      const result = await genAI.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [prompt],
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });
      return result.text ?? "";
    });
    const parsed = JSON.parse(responseText ?? "");

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
