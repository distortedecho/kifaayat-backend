import type { MiddlewareHandler } from "hono";
import { getProfileByClerkId, type ProfileBase } from "../lib/profiles.js";
import { ensureProfile } from "../lib/profileProvisioning.js";
import { logger } from "../lib/logger.js";

// Extend Hono's context variables to include the resolved profile
declare module "hono" {
  interface ContextVariableMap {
    profile: ProfileBase;
  }
}

/**
 * Middleware: resolves Clerk user to profile and sets it on context.
 * Must be used AFTER clerkMiddleware (requires clerkUserId in context).
 *
 * Provisions on demand: if no profile exists yet (e.g. the app hit a
 * write endpoint before GET /me had a chance to run right after signup),
 * we create/claim it here via the shared ensureProfile path instead of
 * 403-ing. This closes the signup race that surfaced as "could not save".
 */
export const requireProfile: MiddlewareHandler = async (c, next) => {
  const clerkUserId = c.get("clerkUserId");
  let profile = await getProfileByClerkId(clerkUserId);

  if (!profile) {
    // No row yet — provision (find → claim legacy → create fresh), then
    // re-read the narrow ProfileBase shape this middleware exposes.
    const provisioned = await ensureProfile(clerkUserId);
    if (provisioned) {
      profile = await getProfileByClerkId(clerkUserId);
    }
  }

  if (!profile) {
    logger.warn("requireProfile.missing", { clerk_id: clerkUserId });
    return c.json({ error: "Profile not found. Please complete your profile setup first." }, 403);
  }
  c.set("profile", profile);
  await next();
};
