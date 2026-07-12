import { createSupabaseAdmin } from "./supabase.js";
import { moderate, type ModReason } from "./moderation.js";

interface FlagInsert {
  entity_type: string;
  entity_id: string;
  flag_type: string;
  details: Record<string, unknown>;
  status: string;
}

/**
 * Human-readable one-liner summarising why the moderation engine fired.
 * e.g. "off_platform, phone, profanity".
 */
export function summarizeReasons(reasons: ModReason[]): string {
  return [...new Set(reasons.map((r) => r.category))].sort().join(", ");
}

/**
 * Scan message content with the shared moderation engine and record a
 * system fraud_flag when it fires. Fire-and-forget.
 *
 * BLOCK and REVIEW verdicts are both queued for moderators (BLOCK first).
 * The flag carries the full verdict + reasons; `matched_content` is kept for
 * backwards-compat with the /moderation/redact action (first offending span).
 */
export async function scanMessageContent(
  messageId: string,
  content: string,
  senderId: string
): Promise<void> {
  if (!content || !content.trim()) return;

  const { verdict, reasons } = moderate(content);
  if (verdict === "ALLOW" || reasons.length === 0) return;

  // First offending span for redaction; skip synthetic matches (spelled_number).
  const firstReal = reasons.find(
    (r) => r.category !== "spelled_number" && !/consecutive number words/.test(r.match)
  );

  const flag: FlagInsert = {
    entity_type: "message",
    entity_id: messageId,
    flag_type: "system",
    details: {
      source: "system",
      verdict,
      reasons,
      summary: summarizeReasons(reasons),
      matched_content: firstReal ? firstReal.match : reasons[0].match,
      sender_id: senderId,
    },
    status: "pending",
  };

  const supabase = createSupabaseAdmin();
  const { error } = await supabase.from("fraud_flags").insert(flag);

  if (error) {
    console.error("Content scanner: Failed to insert fraud flag:", error);
  } else {
    console.log(
      `Content scanner: [${verdict}] flagged message ${messageId} (${flag.details.summary})`
    );
  }
}
