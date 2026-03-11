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
 * AI analysis response — structured fields with confidence scores
 */
export interface AIAnalysisResponse {
  category: AIField<string>;
  title: AIField<string>;
  description: AIField<string>;
  suggested_price: AIField<number>;
  condition: AIField<string>;
  colors: AIField<string[]>;
  occasion_tags: AIField<string[]>;
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
