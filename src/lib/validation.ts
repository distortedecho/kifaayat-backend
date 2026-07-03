import type { ZodError } from "zod";

/**
 * Detect contact details buried in free-text (offer messages, etc).
 *
 * The marketplace keeps buyer↔seller comms in-app so orders, disputes and
 * payments stay traceable. Sellers occasionally try to route deals off
 * platform by dropping a phone number / email / "@handle" / "whatsapp me"
 * into an offer message. The app has a client-side deterrent, but that's
 * trivially bypassed — this is the authoritative server-side check.
 *
 * Returns a short human reason if contact info is found, else null.
 * Deliberately conservative: matches obvious phone/email/URL/social
 * patterns rather than trying to catch every evasion (which would produce
 * false positives on legitimate messages).
 */
export function findContactInfo(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  if (!t) return null;

  // Email address.
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t)) {
    return "email address";
  }

  // URLs / social platforms / messaging apps.
  if (
    /(https?:\/\/|www\.|wa\.me|t\.me|\b(instagram|insta|whatsapp|telegram|snapchat|snap|facebook|messenger)\b)/i.test(
      t
    )
  ) {
    return "a link or social/messaging handle";
  }

  // @handle (3+ chars) — common Instagram/Telegram hand-off.
  if (/(^|\s)@[a-z0-9._]{3,}/i.test(t)) {
    return "a social handle";
  }

  // Phone number: 7-15 digits, allowing spaces / dashes / dots / parens and
  // an optional leading +. Strip formatting then count digits so
  // "0412 345 678" and "+1 (415) 555-1234" both trip it.
  const digitRuns = t.match(/\+?[\d][\d\s().-]{6,}\d/g) || [];
  for (const run of digitRuns) {
    const digits = run.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return "a phone number";
    }
  }

  return null;
}

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
