// AI analysis types for Gemini multimodal photo analysis

/**
 * AI analysis request — base64 encoded photos
 */
export interface AIAnalysisRequest {
  photos: string[];
}

/**
 * A field value with an AI confidence score (0-100)
 */
export interface AIField<T> {
  value: T;
  confidence: number;
}

/**
 * Per-photo quality assessment from AI analysis
 */
export interface PhotoQualityAssessment {
  index: number;
  is_blurry: boolean;
  is_dark: boolean;
  quality_score: number; // 0-100
  issues: string[];
}

/**
 * AI analysis response — structured fields with confidence scores
 */
export interface AIAnalysisResponse {
  // Existing fields
  category: AIField<string>;
  title: AIField<string>;
  description: AIField<string>;
  suggested_price: AIField<number>;
  condition: AIField<string>;
  colors: AIField<string[]>;
  // Optional — currently not surfaced by the analyze endpoint because
  // no seller-side UI exists to accept the suggestion. Re-enable in
  // routes/ai.ts when the form gets an occasion picker.
  occasion_tags?: AIField<string[]>;

  // v2 fields — additive, all optional for backward compatibility
  photo_quality?: AIField<PhotoQualityAssessment[]>;
  designer_name?: AIField<string | null>;
  fabric_types?: AIField<string[]>;
  work_types?: AIField<string[]>;

  // sub_category null when Gemini was not sure or category has no
  // sub-categories. Frontend treats null as "blank, seller picks".
  sub_category?: AIField<string | null>;
}

/**
 * Background removal request — single base64 photo
 */
export interface BackgroundRemovalRequest {
  photo: string;
}

/**
 * Background removal response — processed + original as base64
 */
export interface BackgroundRemovalResponse {
  processed_photo: string;
  original_photo: string;
}

/**
 * Structured error response for AI failures — enables client manual fallback
 */
export interface AIErrorResponse {
  error: string;
  fallback: true;
}
