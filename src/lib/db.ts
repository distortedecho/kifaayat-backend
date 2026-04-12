// ============================================================
// Direct Postgres client via Supavisor (Phase 2.9)
//
// For atomic transactions and heavy aggregation queries where going
// through Supabase JS (PostgREST over HTTPS) is too slow or can't
// express the operation (e.g. multi-row CTEs). We keep using Supabase
// JS for the vast majority of CRUD; this client is reserved for hot
// paths that benefit from direct SQL.
//
// Uses Supabase's Supavisor pooler (session or transaction mode) --
// the DATABASE_URL env var should be the pooled connection string.
// `prepare: false` is required because Supavisor does not support
// prepared statements in transaction pooling mode.
//
// If DATABASE_URL is not configured (dev without Supavisor), we
// export a proxy that throws on first use so existing code paths
// that don't need direct SQL continue to work.
// ============================================================

import postgres, { type Sql } from "postgres";
import { logger } from "./logger.js";

type DbClient = Sql;

let _sql: DbClient | null = null;
let _initAttempted = false;

function initSql(): DbClient | null {
  if (_initAttempted) return _sql;
  _initAttempted = true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    logger.warn("db.disabled", {
      reason: "DATABASE_URL not set — direct Postgres client disabled",
    });
    return null;
  }

  _sql = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Supavisor transaction pooling does not support prepared statements
  });
  return _sql;
}

/**
 * Check whether the direct Postgres client is available.
 * Callers that can fall back to Supabase JS should use this.
 */
export function hasDirectDb(): boolean {
  return initSql() !== null;
}

/**
 * Get the underlying `postgres` client. Throws if DATABASE_URL is
 * not configured -- use `hasDirectDb()` first if you need to fall
 * back to Supabase JS.
 */
export function getSql(): DbClient {
  const client = initSql();
  if (!client) {
    throw new Error(
      "DATABASE_URL is not configured — direct Postgres client is unavailable"
    );
  }
  return client;
}

/**
 * Convenience export: a proxy that lazily forwards to the underlying
 * client. Use this for tagged-template queries where you want the
 * ergonomic `sql\`SELECT ...\`` syntax.
 */
export const sql: DbClient = new Proxy(function () {} as unknown as DbClient, {
  apply(_target, _thisArg, args) {
    return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    const client = getSql() as unknown as Record<string | symbol, unknown>;
    return client[prop];
  },
}) as DbClient;

/**
 * Gracefully close the Postgres pool. Call on SIGTERM/SIGINT.
 */
export async function closeDb(): Promise<void> {
  if (_sql) {
    try {
      await _sql.end({ timeout: 5 });
    } catch (err) {
      logger.error("db.close_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    _sql = null;
    _initAttempted = false;
  }
}
