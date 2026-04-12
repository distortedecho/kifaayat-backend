// ============================================================
// Request logging + correlation IDs (Phase 6.1)
//
// Generates a short correlation ID per request, stores it on the
// Hono context (`c.get("requestId")`) and on the response header
// `X-Request-Id`, then logs a single structured line per request
// including method/path/status/duration/userId.
//
// Skips the /health endpoint so uptime probes don't flood the
// log stream.
//
// This middleware is wired after rate limiters and compression in
// backend/src/index.ts so rate-limited requests don't carry a
// request id (their rejection is logged at the limiter level).
// ============================================================

import type { MiddlewareHandler } from "hono";
import crypto from "crypto";
import { logger } from "../lib/logger.js";

// Extend Hono's context variables to include the per-request id so
// downstream handlers can include it in their own log lines.
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);

  const path = c.req.path;
  const method = c.req.method;
  const start = Date.now();

  // Skip log emission for health probes regardless of outcome.
  const skip = path === "/health" || path === "/health/";

  try {
    await next();
  } finally {
    if (!skip) {
      const duration_ms = Date.now() - start;
      const userId = c.get("clerkUserId") || "anonymous";
      const status = c.res.status;

      // Route 5xx through logger.error so alerting can key off level.
      const meta = {
        requestId,
        method,
        path,
        status,
        duration_ms,
        userId,
      };

      if (status >= 500) {
        logger.error("request", meta);
      } else if (status >= 400) {
        logger.warn("request", meta);
      } else {
        logger.info("request", meta);
      }
    }
  }
};
