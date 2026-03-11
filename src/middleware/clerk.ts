import { Context, MiddlewareHandler } from "hono";
import { verifyToken } from "@clerk/backend";

// Extend Hono's context variables to include clerkUserId
declare module "hono" {
  interface ContextVariableMap {
    clerkUserId: string;
  }
}

/**
 * Extracts the Bearer token from the Authorization header.
 */
function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Required Clerk auth middleware.
 * Verifies the JWT and sets clerkUserId on the context.
 * Returns 401 if token is missing or invalid.
 */
export const clerkMiddleware: MiddlewareHandler = async (c, next) => {
  const token = extractBearerToken(c);

  if (!token) {
    return c.json({ error: "Authorization token required" }, 401);
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error("CLERK_SECRET_KEY is not set");
    return c.json({ error: "Server configuration error" }, 500);
  }

  try {
    const payload = await verifyToken(token, {
      secretKey,
    });

    if (!payload.sub) {
      return c.json({ error: "Invalid token: missing subject" }, 401);
    }

    c.set("clerkUserId", payload.sub);
    await next();
  } catch (error) {
    console.error("Clerk token verification failed:", error);
    return c.json({ error: "Invalid or expired token" }, 401);
  }
};

/**
 * Optional Clerk auth middleware.
 * Verifies the JWT if present but does NOT return 401 on missing token.
 * Useful for guest-accessible routes where auth is optional.
 */
export const optionalClerkMiddleware: MiddlewareHandler = async (c, next) => {
  const token = extractBearerToken(c);

  if (!token) {
    // No token is fine for optional auth
    await next();
    return;
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    // If no secret key configured, just continue without auth
    await next();
    return;
  }

  try {
    const payload = await verifyToken(token, {
      secretKey,
    });

    if (payload.sub) {
      c.set("clerkUserId", payload.sub);
    }
  } catch {
    // Invalid token on optional routes is fine — treat as guest
  }

  await next();
};
