// ============================================================
// Admin audit log (Phase 0.1)
//
// Append-only trail of consequential admin actions. Writes go to the
// write-once `admin_audit_log` table (schema-26). Every write is
// fire-and-forget: a failure to log must NEVER block or fail the action
// it was recording — we log the failure and move on.
//
// Prefer `auditFromContext(c, …)` inside admin route handlers: it pulls the
// actor (id/email/role) and request IP off the Hono context so call sites
// only pass what the action was.
// ============================================================

import type { Context } from "hono";
import { createSupabaseAdmin } from "./supabase.js";
import { logger } from "./logger.js";

export type AuditTargetType =
  | "listing"
  | "user"
  | "order"
  | "payout"
  | "review"
  | "message"
  | "settings"
  | "taxonomy"
  | "content"
  | "export"
  | "team"
  | "referral";

export interface WriteAuditParams {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string; // e.g. "payout.mark_sent", "user.ban", "listing.reject"
  targetType: AuditTargetType;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Insert one audit row. Fire-and-forget: never throws, never blocks the
 * caller's action. Awaiting it is optional (handlers may `void` it).
 */
export async function writeAudit(params: WriteAuditParams): Promise<void> {
  try {
    const supabase = createSupabaseAdmin();
    const { error } = await supabase.from("admin_audit_log").insert({
      actor_id: params.actorId ?? null,
      actor_email: params.actorEmail ?? null,
      actor_role: params.actorRole ?? null,
      action: params.action,
      target_type: params.targetType,
      target_id: params.targetId ?? null,
      reason: params.reason ?? null,
      metadata: params.metadata ?? {},
      ip: params.ip ?? null,
    });
    if (error) {
      logger.error("audit.write_failed", { action: params.action, error: error.message });
    }
  } catch (err) {
    logger.error("audit.write_failed", {
      action: params.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Convenience wrapper for admin route handlers — resolves the actor and IP
 * from the request context so callers only describe the action.
 */
export function auditFromContext(
  c: Context,
  params: Pick<WriteAuditParams, "action" | "targetType" | "targetId" | "reason" | "metadata">
): Promise<void> {
  return writeAudit({
    ...params,
    actorId: (c.get("adminProfileId") as string | undefined) ?? null,
    actorEmail: (c.get("adminEmail") as string | undefined) ?? null,
    actorRole: (c.get("adminRole") as string | undefined) ?? null,
    ip:
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      null,
  });
}
