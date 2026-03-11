import { Hono } from "hono";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { clerkMiddleware } from "../middleware/clerk.js";
import { removeBackground } from "../lib/background-removal.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  OCCASION_TAGS,
} from "../types/listings.js";
import type {
  AIAnalysisResponse,
  AIField,
  AIErrorResponse,
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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-pro-preview",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

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

For each field, also provide a confidence score (0-100).
Return valid JSON only, no markdown formatting.`;

  // Attempt with one retry on failure
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.generateContent([prompt, ...imageParts]);
      const responseText = result.response.text();
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

export default ai;
