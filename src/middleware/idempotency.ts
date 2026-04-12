import type { MiddlewareHandler } from "hono";
import { logger } from "../lib/logger.js";

/**
 * In-memory idempotency cache.
 *
 * Clients opt in by sending an `Idempotency-Key` header on non-GET
 * mutations. The first response body/status is cached for 24 hours;
 * subsequent requests with the same key short-circuit and return the
 * cached payload so network retries or double-taps don't create
 * duplicate orders, offers, or messages.
 *
 * Single-instance Railway deployment — in-memory is sufficient. If the
 * service ever scales horizontally this must move to Redis.
 */

type CacheEntry = {
  status: number;
  body: unknown;
  contentType: string | null;
  rawBody: string | null;
  expiry: number;
};

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ENTRIES = 10_000;

const idempotencyCache = new Map<string, CacheEntry>();

/**
 * Opportunistic sweep: whenever the map grows past the soft cap we
 * evict expired entries in a single pass. If everything is still live
 * we fall back to evicting the oldest insertion-order entries so the
 * map can't grow unbounded.
 */
function sweep(): void {
  if (idempotencyCache.size < MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiry <= now) {
      idempotencyCache.delete(key);
    }
  }
  if (idempotencyCache.size < MAX_ENTRIES) return;
  // Still over the cap: drop the oldest entries (Map iterates in
  // insertion order).
  const overflow = idempotencyCache.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of idempotencyCache.keys()) {
    if (removed >= overflow) break;
    idempotencyCache.delete(key);
    removed++;
  }
}

export const idempotencyMiddleware: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const key = c.req.header("Idempotency-Key");
  if (!key) return next();

  const now = Date.now();
  const cached = idempotencyCache.get(key);
  if (cached && cached.expiry > now) {
    // Replay the original body verbatim so the client sees a
    // byte-identical response on retry. Return a raw Response to
    // sidestep Hono's strict status-code literal typing.
    const headers = new Headers();
    if (cached.contentType) {
      headers.set("Content-Type", cached.contentType);
    }
    headers.set("Idempotent-Replay", "true");
    return new Response(cached.rawBody ?? JSON.stringify(cached.body ?? null), {
      status: cached.status,
      headers,
    });
  }
  if (cached && cached.expiry <= now) {
    idempotencyCache.delete(key);
  }

  await next();

  // Capture the response so we can replay it on the next retry.
  const response = c.res;
  if (!response) return;

  const status = response.status;
  // Only cache successful-ish responses; don't memoise transient
  // failures the client might legitimately want to retry.
  if (status < 200 || status >= 300) return;

  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get("Content-Type");
    const rawBody = await cloned.text();
    let parsedBody: unknown = null;
    if (contentType && contentType.includes("application/json")) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = null;
      }
    }
    idempotencyCache.set(key, {
      status,
      body: parsedBody,
      contentType,
      rawBody,
      expiry: Date.now() + TTL_MS,
    });
    sweep();
  } catch (err) {
    // Never fail the request because caching failed.
    logger.error("idempotency.cache_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
