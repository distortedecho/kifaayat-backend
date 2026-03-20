import { createSupabaseAdmin } from "./supabase.js";

// Phone regex patterns
const PHONE_PATTERNS = [
  // Australian mobile: 04XX XXX XXX
  /\b04\d{2}[-.\s]?\d{3}[-.\s]?\d{3}\b/g,
  // Australian landline: 0X XXXX XXXX
  /\b0[2-9]\d{2}[-.\s]?\d{3}[-.\s]?\d{3}\b/g,
  // General international format (7+ digits to reduce false positives)
  /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,6}/g,
];

// Email regex
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// External URL regex (excludes kifaayat domains)
const EXTERNAL_URL_PATTERN =
  /https?:\/\/(?!(?:www\.)?kifaayat\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*/g;

/**
 * Count total digits in a matched phone string.
 * Returns true if there are 7+ digits (reduces false positives).
 */
function hasEnoughDigits(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  return digits.length >= 7;
}

interface FlagInsert {
  entity_type: string;
  entity_id: string;
  flag_type: string;
  details: Record<string, unknown>;
  status: string;
}

/**
 * Scan message content for phone numbers, emails, and external URLs.
 * Inserts fraud_flags for each match found. Fire-and-forget.
 */
export async function scanMessageContent(
  messageId: string,
  content: string,
  senderId: string
): Promise<void> {
  const flags: FlagInsert[] = [];

  // Check phone patterns
  for (const pattern of PHONE_PATTERNS) {
    // Reset regex state for each pattern
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (hasEnoughDigits(match[0])) {
        flags.push({
          entity_type: "message",
          entity_id: messageId,
          flag_type: "phone_number",
          details: { matched_content: match[0], sender_id: senderId },
          status: "pending",
        });
      }
    }
  }

  // Check email pattern
  EMAIL_PATTERN.lastIndex = 0;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = EMAIL_PATTERN.exec(content)) !== null) {
    flags.push({
      entity_type: "message",
      entity_id: messageId,
      flag_type: "email",
      details: { matched_content: emailMatch[0], sender_id: senderId },
      status: "pending",
    });
  }

  // Check external URL pattern
  EXTERNAL_URL_PATTERN.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = EXTERNAL_URL_PATTERN.exec(content)) !== null) {
    flags.push({
      entity_type: "message",
      entity_id: messageId,
      flag_type: "external_link",
      details: { matched_content: urlMatch[0], sender_id: senderId },
      status: "pending",
    });
  }

  if (flags.length === 0) return;

  // Deduplicate by flag_type (keep first match per type)
  const seen = new Set<string>();
  const uniqueFlags = flags.filter((f) => {
    const key = `${f.flag_type}:${(f.details.matched_content as string)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const supabase = createSupabaseAdmin();
  const { error } = await supabase
    .from("fraud_flags")
    .insert(uniqueFlags);

  if (error) {
    console.error("Content scanner: Failed to insert fraud flags:", error);
  } else {
    console.log(`Content scanner: Flagged ${uniqueFlags.length} item(s) in message ${messageId}`);
  }
}
