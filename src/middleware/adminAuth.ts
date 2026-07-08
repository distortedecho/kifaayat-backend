import { MiddlewareHandler } from "hono";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  hasPermission,
  type AdminRole,
  type AdminPermission,
} from "../lib/adminRoles.js";

declare module "hono" {
  interface ContextVariableMap {
    adminProfileId: string;
    adminEmail: string;
    adminRole: string;
    adminPermissionsOverride: { grant?: string[]; deny?: string[] } | null;
    // The admin_users.id row (distinct from adminProfileId which is profiles.id).
    adminUserId: string | null;
  }
}

/**
 * Admin auth middleware using Supabase Auth.
 * Verifies the JWT, checks ADMIN_EMAILS, resolves the profile id, and
 * resolves the admin role (Phase 0.2). Members of ADMIN_EMAILS are
 * auto-provisioned as `owner` in admin_users on first contact so nobody
 * is locked out; ADMIN_EMAILS stays a fallback until the table is
 * authoritative. Optional 2FA enforcement via ADMIN_ENFORCE_2FA.
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authorization token required" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const supabase = createSupabaseAdmin();
    const claims = getJwtClaims(token);

    const { data: { user }, error } = await supabase.auth.admin.getUserById(
      claims.sub
    );

    if (error || !user) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const emailAllowed =
      adminEmails.length === 0 || adminEmails.includes(user.email?.toLowerCase() || "");

    // Resolve the admin_users row (role / override / status). Bootstrap an
    // owner row for an allowlisted email that isn't in the table yet.
    let adminRow: AdminRow | null = null;
    const nowIso = new Date().toISOString();

    const { data: existingAdmin } = await supabase
      .from("admin_users")
      .select("id, role, permissions_override, status")
      .eq("supabase_user_id", user.id)
      .maybeSingle();

    if (existingAdmin) {
      adminRow = existingAdmin as unknown as AdminRow;
      // First login after an invite → activate the row.
      if (adminRow.status === "invited") {
        await supabase
          .from("admin_users")
          .update({ status: "active", last_login_at: nowIso })
          .eq("id", adminRow.id);
        adminRow.status = "active";
      }
    } else if (user.email) {
      // Claim an invited row created before this Supabase id was known
      // (safety net if the auth id ever differs from what was stored).
      const { data: byEmail } = await supabase
        .from("admin_users")
        .select("id, role, permissions_override, status")
        .ilike("email", user.email)
        .maybeSingle();
      if (byEmail) {
        await supabase
          .from("admin_users")
          .update({ supabase_user_id: user.id, status: "active", last_login_at: nowIso })
          .eq("id", (byEmail as { id: string }).id);
        adminRow = { ...(byEmail as unknown as AdminRow), status: "active" };
      } else if (emailAllowed) {
        // Bootstrap an owner row for an ADMIN_EMAILS member.
        const { data: created } = await supabase
          .from("admin_users")
          .insert({
            supabase_user_id: user.id,
            email: user.email.toLowerCase(),
            role: "owner",
            status: "active",
            last_login_at: nowIso,
          })
          .select("id, role, permissions_override, status")
          .single();
        adminRow = (created as unknown as AdminRow) ?? null;
      }
    }

    // Access gate: must be allowlisted OR an active admin_users row.
    if (!emailAllowed && !adminRow) {
      return c.json({ error: "Forbidden: admin access required" }, 403);
    }
    if (adminRow && adminRow.status === "disabled") {
      return c.json({ error: "Admin access disabled" }, 403);
    }

    // Optional 2FA enforcement — blocks until the member has an AAL2 session.
    if (process.env.ADMIN_ENFORCE_2FA === "true" && claims.aal !== "aal2") {
      return c.json({ error: "Two-factor authentication required", code: "2fa_required" }, 403);
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("supabase_user_id", user.id)
      .single();

    c.set("adminProfileId", profile?.id || user.id);
    if (user.email) c.set("adminEmail", user.email);
    c.set("adminRole", adminRow?.role || (emailAllowed ? "owner" : "support"));
    c.set("adminPermissionsOverride", adminRow?.permissions_override ?? null);
    c.set("adminUserId", adminRow?.id ?? null);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
};

/**
 * Route guard factory: 403s unless the caller's role (+ override) grants
 * `permission`. Use AFTER adminAuthMiddleware.
 *   admin.post("/transactions/:id/refund", requireAdminPermission("transactions.refund"), …)
 */
export function requireAdminPermission(
  permission: AdminPermission
): MiddlewareHandler {
  return async (c, next) => {
    const role = c.get("adminRole") as AdminRole | undefined;
    const override = c.get("adminPermissionsOverride") as
      | { grant?: string[]; deny?: string[] }
      | null
      | undefined;
    if (!hasPermission(role, permission, override)) {
      return c.json({ error: `Forbidden: '${permission}' required` }, 403);
    }
    await next();
  };
}

interface AdminRow {
  id: string;
  role: string;
  permissions_override: { grant?: string[]; deny?: string[] } | null;
  status: string;
}

interface JwtClaims {
  sub: string;
  aal?: string;
  [k: string]: unknown;
}

function getJwtClaims(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (!payload.sub) throw new Error("Missing sub claim");
  return payload as JwtClaims;
}
