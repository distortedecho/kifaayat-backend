import type { Context, MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Tiered rate limiters using hono-rate-limiter with in-memory store.
 *
 * Safe for a single Railway instance. If the service ever scales to
 * multiple instances, swap the store for RedisStore from hono-rate-limiter.
 */

const ONE_MINUTE = 60 * 1000;

/**
 * Extract a best-effort client IP from proxy headers, falling back to a
 * constant so misconfigured requests still get bucketed rather than
 * bypassing rate limiting entirely.
 */
function getClientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;
  return "unknown";
}

/**
 * Key generator that prefers the authenticated user id (set by
 * clerkMiddleware) and falls back to the client IP.
 */
function userOrIpKey(c: Context): string {
  const userId = c.get("clerkUserId" as never) as string | undefined;
  if (userId) return `user:${userId}`;
  return `ip:${getClientIp(c)}`;
}

function ipKey(c: Context): string {
  return `ip:${getClientIp(c)}`;
}

/**
 * Global: 100 req/min per IP. Applied to all routes as a safety net.
 */
export const globalLimiter: MiddlewareHandler = rateLimiter({
  windowMs: ONE_MINUTE,
  limit: 100,
  standardHeaders: "draft-6",
  keyGenerator: ipKey,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Auth: 5 req/min per IP. Applied to admin auth endpoints to slow
 * credential stuffing and brute-force attacks.
 */
export const authLimiter: MiddlewareHandler = rateLimiter({
  windowMs: ONE_MINUTE,
  limit: 5,
  standardHeaders: "draft-6",
  keyGenerator: ipKey,
  message: { error: "Too many authentication attempts. Please wait a minute." },
});

/**
 * AI: 10 req/min per authenticated user (IP fallback). Caps the cost
 * of expensive LLM/vision operations.
 */
export const aiLimiter: MiddlewareHandler = rateLimiter({
  windowMs: ONE_MINUTE,
  limit: 10,
  standardHeaders: "draft-6",
  keyGenerator: userOrIpKey,
  message: { error: "AI rate limit exceeded. Please slow down." },
});

/**
 * Write: 30 req/min per user (IP fallback). Applied to mutation-heavy
 * route groups. Skips non-mutating methods so reads aren't double-counted.
 */
export const writeLimiter: MiddlewareHandler = rateLimiter({
  windowMs: ONE_MINUTE,
  limit: 30,
  standardHeaders: "draft-6",
  keyGenerator: userOrIpKey,
  skip: (c) => {
    const method = c.req.method.toUpperCase();
    return method !== "POST" && method !== "PUT" && method !== "PATCH";
  },
  message: { error: "Too many write requests. Please slow down." },
});

/**
 * Public read: 60 req/min per IP. Applied to unauthenticated feed and
 * search endpoints.
 */
export const publicReadLimiter: MiddlewareHandler = rateLimiter({
  windowMs: ONE_MINUTE,
  limit: 60,
  standardHeaders: "draft-6",
  keyGenerator: ipKey,
  message: { error: "Too many requests. Please slow down." },
});
