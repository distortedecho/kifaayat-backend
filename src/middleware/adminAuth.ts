import { MiddlewareHandler } from "hono";
import { createSupabaseAdmin } from "../lib/supabase.js";

declare module "hono" {
  interface ContextVariableMap {
    adminProfileId: string;
  }
}

/**
 * Admin auth middleware using Supabase Auth.
 * Verifies the JWT, checks the user's email against ADMIN_EMAILS,
 * then resolves the admin profile ID from the profiles table.
 */
export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Authorization token required" }, 401);
  }

  const token = authHeader.slice(7);

  try {
    const supabase = createSupabaseAdmin();

    const { data: { user }, error } = await supabase.auth.admin.getUserById(
      extractUserIdFromJwt(token)
    );

    if (error || !user) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (adminEmails.length > 0 && !adminEmails.includes(user.email?.toLowerCase() || "")) {
      return c.json({ error: "Forbidden: admin access required" }, 403);
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_admin", true)
      .limit(1)
      .single();

    c.set("adminProfileId", profile?.id || user.id);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
};

function extractUserIdFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (!payload.sub) throw new Error("Missing sub claim");
  return payload.sub;
}
