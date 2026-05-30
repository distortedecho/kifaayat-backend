import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import health from "./routes/health.js";
import listings from "./routes/listings.js";
import profiles from "./routes/profiles.js";
import feed from "./routes/feed.js";
import search from "./routes/search.js";
import wishlists from "./routes/wishlists.js";
import ai from "./routes/ai.js";
import stripe from "./routes/stripe.js";
import offers from "./routes/offers.js";
import orders from "./routes/orders.js";
import notifications from "./routes/notifications.js";
import conversations from "./routes/conversations.js";
import exchangeRates from "./routes/exchange-rates.js";
import sellers from "./routes/sellers.js";
import reports from "./routes/reports.js";
import emailHooks from "./routes/email-hooks.js";
import reviews from "./routes/reviews.js";
import admin from "./routes/admin.js";
import cart from "./routes/cart.js";
import referrals from "./routes/referrals.js";
import iso from "./routes/iso.js";
import sitemap from "./routes/sitemap.js";
import {
  initJobQueue,
  scheduleRecurringJobs,
  closeJobQueue,
} from "./lib/jobs.js";
import { closeDb } from "./lib/db.js";
// Side-effect import: registers all domain event listeners at boot.
import "./listeners/index.js";
import {
  globalLimiter,
  authLimiter,
  aiLimiter,
  writeLimiter,
  publicReadLimiter,
} from "./middleware/rateLimiter.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { logger } from "./lib/logger.js";

// ----------------------------------------------------------
// Startup env validation (Phase 2.5)
// Fail fast if critical secrets are missing so we never boot
// into a partially-configured state that silently misbehaves.
// ----------------------------------------------------------
const requiredEnvVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "CLERK_SECRET_KEY",
] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

if (
  process.env.NODE_ENV === "production" &&
  !process.env.INTERNAL_API_SECRET
) {
  throw new Error("INTERNAL_API_SECRET must be set in production");
}

const app = new Hono();

// Default allowlist — extended at runtime via CORS_ORIGINS (comma-separated).
// The wildcard *.vercel.app match was removed because it let any
// attacker-controlled Vercel preview through CORS.
const defaultAllowedOrigins = [
  "http://localhost:19006",
  "http://localhost:8081",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "https://kifaayat-admin.vercel.app",
  "https://kifaayat-admin-liart.vercel.app",
];

const allowedOrigins = Array.from(
  new Set([
    ...defaultAllowedOrigins,
    ...(process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
  ])
);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-guest-token", "Idempotency-Key", "X-Internal-Secret"],
    exposeHeaders: ["Content-Length", "Idempotent-Replay", "X-Request-Id"],
    maxAge: 600,
    credentials: true,
  })
);

// Global rate limit — 100 req/min per IP — applies to every request
// as a safety net before any route-specific limiter kicks in.
app.use("*", globalLimiter);

// Response compression (Phase 2.4). Placed after the global rate
// limiter so we don't waste CPU gzipping requests we're about to
// reject anyway, but before all route handlers so every response
// benefits. Hono's built-in middleware handles gzip/deflate and
// respects Accept-Encoding.
app.use("*", compress());

// ----------------------------------------------------------
// Structured request logging + correlation IDs (Phase 6.1)
// Placed AFTER rate limiters and compression so rate-limited
// responses are observed by the limiter itself (and don't burn
// a request id) but BEFORE route mounting so every handled
// request emits exactly one JSON log line on completion.
// Skips /health internally to avoid log spam from uptime probes.
// ----------------------------------------------------------
app.use("*", requestLogger);

// Sitemap (root-level, before /api routes)
app.route("/sitemap.xml", sitemap);

// ----------------------------------------------------------
// Route-specific rate limiters (Phase 6.4)
// Order matters: specific limiters must be registered before
// app.route() mounts so they run for the sub-routes.
//
// Each limiter is registered at BOTH /api/... and /api/v1/...
// so the canonical versioned path and the transitional alias
// enforce identical limits. Registering the same middleware
// twice on the parent app is cheap -- each `app.use(path, mw)`
// call creates a single path-scoped route entry.
// ----------------------------------------------------------

// Admin auth — 5 req/min per IP to blunt brute-force attacks
app.use("/api/admin/auth/*", authLimiter);
app.use("/api/v1/admin/auth/*", authLimiter);

// AI endpoints — 10 req/min per user to cap LLM/vision spend
app.use("/api/ai/*", aiLimiter);
app.use("/api/v1/ai/*", aiLimiter);

// Public reads — 60 req/min per IP for the feed + search
app.use("/api/feed/*", publicReadLimiter);
app.use("/api/search/*", publicReadLimiter);
app.use("/api/v1/feed/*", publicReadLimiter);
app.use("/api/v1/search/*", publicReadLimiter);

// Mutation-heavy route groups — 30 req/min per user for
// writes only (the limiter skips reads internally).
const writeRouteGroups = [
  "orders",
  "offers",
  "conversations",
  "listings",
  "reviews",
  "reports",
  "iso",
  "cart",
  "wishlists",
] as const;
for (const group of writeRouteGroups) {
  app.use(`/api/${group}/*`, writeLimiter);
  app.use(`/api/v1/${group}/*`, writeLimiter);
}

// ----------------------------------------------------------
// API versioning (Phase 6.4)
//
// All /api/* routes are now mounted on a `v1` Hono sub-app,
// which is then mounted at both `/api/v1` (canonical) and
// `/api` (alias during the transition window). Middleware
// registered on `app` above targets both prefixes explicitly.
//
// To introduce a breaking change later, create a `v2` sub-app
// with only the diverging routes, mount it at `/api/v2`, and
// point the latest mobile builds at that base URL. Old app
// builds continue to hit the `v1` / `/api` alias and keep
// working through the App Store update cycle.
// ----------------------------------------------------------
const v1 = new Hono();
v1.route("/listings", listings);
v1.route("/profiles", profiles);
v1.route("/feed", feed);
v1.route("/search", search);
v1.route("/wishlists", wishlists);
v1.route("/ai", ai);
v1.route("/stripe", stripe);
v1.route("/offers", offers);
v1.route("/orders", orders);
v1.route("/notifications", notifications);
v1.route("/conversations", conversations);
v1.route("/exchange-rates", exchangeRates);
v1.route("/sellers", sellers);
v1.route("/reviews", reviews);
v1.route("/reports", reports);
v1.route("/email-hooks", emailHooks);
v1.route("/admin", admin);
v1.route("/cart", cart);
v1.route("/referrals", referrals);
v1.route("/iso", iso);

// Canonical versioned mount
app.route("/api/v1", v1);
// Backward-compatible alias for existing mobile clients
app.route("/api", v1);

// Health check stays at its current path (non-versioned).
app.route("/health", health);

// Root route
app.get("/", (c) => {
  return c.json({ name: "Kifaayat API", version: "1.0.0" });
});

// ----------------------------------------------------------
// Global error handler (Phase 2.5 + 6.1)
// Any thrown error or rejected promise inside a handler funnels
// here. We log method+path+requestId via the structured logger,
// preserve HTTPException status codes, and mask everything else
// as a generic 500 to avoid leaking internals to clients.
// ----------------------------------------------------------
app.onError((err, c) => {
  const requestId = c.get("requestId");
  logger.error("unhandled_error", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    name: err.name,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request failed" }, err.status);
  }
  return c.json({ error: "Internal server error" }, 500);
});

const port = parseInt(process.env.PORT || "3001", 10);

logger.info("server.starting", { port });

const server = serve({
  fetch: app.fetch,
  port,
});

// ----------------------------------------------------------
// Background job queue (Phase 2.10)
// Replaces the old in-process `node-cron` scheduler with pg-boss.
// If DATABASE_URL is not set (dev), both calls log a warning and
// no-op so local development continues to work.
// ----------------------------------------------------------
(async () => {
  try {
    await initJobQueue();
    await scheduleRecurringJobs();
  } catch (err) {
    logger.error("startup.job_queue_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
})();

// ----------------------------------------------------------
// Graceful shutdown (Phase 2.10)
// Stops accepting new HTTP requests, drains in-flight jobs, and
// closes the direct Postgres pool before exiting.
// ----------------------------------------------------------
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown.start", { signal });

  try {
    // Stop accepting new connections
    if (typeof (server as unknown as { close?: (cb?: (err?: Error) => void) => void }).close === "function") {
      await new Promise<void>((resolve) => {
        (server as unknown as { close: (cb?: (err?: Error) => void) => void }).close(
          () => resolve()
        );
      });
    }
  } catch (err) {
    logger.error("shutdown.http_close_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await closeJobQueue();
  await closeDb();

  logger.info("shutdown.done");
  process.exit(0);
}

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

export default app;
