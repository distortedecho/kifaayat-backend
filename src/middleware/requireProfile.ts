import type { MiddlewareHandler } from "hono";
import { getProfileByClerkId, type ProfileBase } from "../lib/profiles.js";

// Extend Hono's context variables to include the resolved profile
declare module "hono" {
  interface ContextVariableMap {
    profile: ProfileBase;
  }
}

/**
 * Middleware: resolves Clerk user to profile and sets it on context.
 * Must be used AFTER clerkMiddleware (requires clerkUserId in context).
 * Returns 403 if no profile found.
 */
export const requireProfile: MiddlewareHandler = async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }
  c.set("profile", profile);
  await next();
};
