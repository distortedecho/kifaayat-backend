// ============================================================
// Health check endpoint (Phase 6.2)
//
// Returns 200 `healthy` when every subsystem passes, 503
// `degraded` when anything fails. Each probe is wrapped in a 2s
// timeout so one slow dependency doesn't wedge the health check
// and get the pod killed.
//
// Probes:
//   - Supabase connectivity via a cheap `count(profiles)` query
//   - Direct Postgres (`lib/db.ts`) via `SELECT 1` when configured
//   - Process memory (heapUsed in MB)
//   - Uptime (seconds)
//   - Job queue ready state (pg-boss)
//   - Version hash (GIT_SHA / RAILWAY_GIT_COMMIT_SHA)
//
// The response also echoes `X-Request-Id` so operators can
// correlate the JSON body with the surrounding log stream.
// ============================================================

import { Hono } from "hono";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { hasDirectDb, sql } from "../lib/db.js";
import { isJobQueueReady } from "../lib/jobs.js";
import { logger } from "../lib/logger.js";

const health = new Hono();

const PROBE_TIMEOUT_MS = 2000;

/**
 * Race a promise against a timeout. Resolves to `{ ok: false }` if
 * either the underlying promise rejects or the timeout fires.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timeout after ${ms}ms`)),
          ms
        );
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkSupabase(): Promise<{ ok: boolean; error?: string }> {
  const supabase = createSupabaseAdmin();
  const result = await withTimeout(
    (async () => {
      const { error } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .limit(1);
      if (error) throw new Error(error.message);
      return true;
    })(),
    PROBE_TIMEOUT_MS,
    "supabase"
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function checkDirectDb(): Promise<{
  ok: boolean;
  configured: boolean;
  error?: string;
}> {
  if (!hasDirectDb()) {
    return { ok: true, configured: false };
  }
  const result = await withTimeout(
    (async () => {
      await sql`SELECT 1`;
      return true;
    })(),
    PROBE_TIMEOUT_MS,
    "direct_db"
  );
  return result.ok
    ? { ok: true, configured: true }
    : { ok: false, configured: true, error: result.error };
}

health.get("/", async (c) => {
  const requestId = c.get("requestId");

  // Run probes in parallel so the slowest dominates total latency.
  const [supabaseResult, directDbResult] = await Promise.all([
    checkSupabase(),
    checkDirectDb(),
  ]);

  const mem = process.memoryUsage();
  const memory_mb = Math.round(mem.heapUsed / 1024 / 1024);
  const uptime_s = Math.round(process.uptime());
  const jobQueueReady = isJobQueueReady();
  const version =
    process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";

  const checks: Record<string, unknown> = {
    supabase: supabaseResult.ok
      ? { ok: true }
      : { ok: false, error: supabaseResult.error },
    direct_db: directDbResult.configured
      ? directDbResult.ok
        ? { ok: true }
        : { ok: false, error: directDbResult.error }
      : { ok: true, configured: false },
    job_queue: { ok: true, ready: jobQueueReady },
  };

  const allOk = supabaseResult.ok && directDbResult.ok;
  const status = allOk ? "healthy" : "degraded";

  if (!allOk) {
    logger.warn("health.degraded", {
      requestId,
      supabase: supabaseResult.ok,
      direct_db: directDbResult.ok,
    });
  }

  return c.json(
    {
      status,
      uptime_s,
      memory_mb,
      version,
      job_queue_ready: jobQueueReady,
      checks,
      ...(requestId ? { requestId } : {}),
      timestamp: new Date().toISOString(),
    },
    allOk ? 200 : 503
  );
});

export default health;
