import type { ZodError } from "zod";

/**
 * Turn a ZodError into a single-line human-readable message
 * suitable for the top-level `error` field of a 400 response.
 *
 * Most of our handlers return `{ error: "Validation failed", details: {...} }`
 * and trust the frontend to inspect `details.fieldErrors`. When the FE
 * just renders `error` (as several screens do), the user sees
 * "Validation failed" with no hint what to fix. This helper produces
 * something like:
 *   "title is required; sub_category is not valid for this category"
 * — concrete enough that even a bare-bones error toast tells the user
 * exactly what went wrong.
 */
export function summarizeZodError(error: ZodError): string {
  const fieldErrors = error.flatten().fieldErrors as Record<string, string[]>;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (!messages || messages.length === 0) continue;
    parts.push(`${field}: ${messages[0]}`);
  }
  if (parts.length === 0) {
    const formErrors = error.flatten().formErrors;
    if (formErrors.length > 0) return formErrors[0];
    return "Validation failed";
  }
  return parts.join("; ");
}
