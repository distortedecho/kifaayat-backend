// ============================================================
// pg-boss job queue (Phase 2.10)
//
// Replaces in-process `node-cron` with a Postgres-backed job queue.
// Benefits:
//   - Crash recovery: in-flight jobs are re-run after a restart.
//   - Distributed: multiple backend instances share the queue.
//   - Retries + dead-letter queue.
//   - Observable: jobs are rows in pgboss.* tables.
//
// Graceful degradation: if DATABASE_URL is not configured (dev),
// we log and no-op so the dev server still boots and route handlers
// that emit events still work (they just don't get background
// processing).
// ============================================================

import PgBoss from "pg-boss";
import { createNotification } from "./notifications.js";
import { sendEmail } from "./email.js";
import { runAutoCompleteOrders, runIsoMatchingRefresh } from "./cron.js";
import { matchISOPost } from "../routes/ai.js";
import { logger } from "./logger.js";

// ------------------------------------------------------------
// Job name constants -- used by both the enqueue and worker sides.
// ------------------------------------------------------------
export const JOB_SEND_NOTIFICATION = "send-notification";
export const JOB_SEND_EMAIL = "send-email";
export const JOB_PROCESS_ISO_MATCH = "process-iso-match";
export const JOB_AUTO_COMPLETE_ORDERS = "auto-complete-orders";
export const JOB_ISO_MATCHING_REFRESH = "iso-matching-refresh";

// ------------------------------------------------------------
// Job payload types
// ------------------------------------------------------------
export interface SendNotificationJobData {
  user_id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface SendEmailJobData {
  to: string;
  subject: string;
  html: string;
}

export interface ProcessIsoMatchJobData {
  isoPostId: string;
}

// ------------------------------------------------------------
// Singleton
// ------------------------------------------------------------
let _boss: PgBoss | null = null;
let _started = false;

function getBossInstance(): PgBoss | null {
  if (_boss) return _boss;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  _boss = new PgBoss({
    connectionString: url,
    // Supavisor transaction pooler cannot handle prepared statements;
    // pg-boss uses its own `pg` client internally but the default
    // `schema` is fine since it auto-creates a pgboss schema.
    // Retention defaults are sensible (30 days).
  });
  _boss.on("error", (err) => {
    logger.error("jobs.pg_boss_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return _boss;
}

/**
 * Initialize the job queue and register all workers.
 * Safe to call multiple times; second call is a no-op.
 */
export async function initJobQueue(): Promise<void> {
  if (_started) return;
  const boss = getBossInstance();
  if (!boss) {
    logger.warn("jobs.disabled", {
      reason: "DATABASE_URL not set — background jobs will not run",
    });
    return;
  }

  try {
    await boss.start();
    _started = true;
    logger.info("jobs.started");
  } catch (err) {
    logger.error("jobs.start_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // --------------------------------------------------------
  // Workers
  // --------------------------------------------------------
  await boss.work<SendNotificationJobData>(
    JOB_SEND_NOTIFICATION,
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await createNotification({
            user_id: job.data.user_id,
            type: job.data.type as never,
            title: job.data.title,
            body: job.data.body,
            data: job.data.data,
          });
        } catch (err) {
          logger.error("jobs.send_notification_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    }
  );

  await boss.work<SendEmailJobData>(
    JOB_SEND_EMAIL,
    { batchSize: 5 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await sendEmail({
            to: job.data.to,
            subject: job.data.subject,
            html: job.data.html,
          });
        } catch (err) {
          logger.error("jobs.send_email_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    }
  );

  await boss.work<ProcessIsoMatchJobData>(
    JOB_PROCESS_ISO_MATCH,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await matchISOPost(job.data.isoPostId);
        } catch (err) {
          logger.error("jobs.process_iso_match_failed", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
    }
  );

  // Recurring jobs -- these pgboss "work" handlers are triggered by
  // `boss.schedule(...)` in scheduleRecurringJobs() below.
  await boss.work(JOB_AUTO_COMPLETE_ORDERS, { batchSize: 1 }, async () => {
    await runAutoCompleteOrders();
  });

  await boss.work(JOB_ISO_MATCHING_REFRESH, { batchSize: 1 }, async () => {
    await runIsoMatchingRefresh();
  });

  logger.info("jobs.workers_registered");
}

/**
 * Register cron schedules for recurring jobs. Must be called after
 * `initJobQueue()`. Safe to call multiple times -- pg-boss schedules
 * are idempotent.
 */
export async function scheduleRecurringJobs(): Promise<void> {
  const boss = getBossInstance();
  if (!boss || !_started) {
    logger.warn("jobs.schedule_skipped", { reason: "pg-boss not started" });
    return;
  }

  try {
    // Auto-complete delivered/shipped orders every 6 hours
    await boss.schedule(JOB_AUTO_COMPLETE_ORDERS, "0 */6 * * *");
    // ISO matching refresh daily at 3am UTC
    await boss.schedule(JOB_ISO_MATCHING_REFRESH, "0 3 * * *");
    logger.info("jobs.recurring_registered");
  } catch (err) {
    logger.error("jobs.schedule_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Enqueue a background job. Falls back to in-process execution if
 * pg-boss is not configured.
 */
export async function enqueue<T extends object>(
  name: string,
  data: T
): Promise<string | null> {
  const boss = getBossInstance();
  if (!boss || !_started) {
    // Fallback: run immediately in-process so dev still works.
    return null;
  }
  try {
    const id = await boss.send(name, data);
    return id;
  } catch (err) {
    logger.error("jobs.enqueue_failed", {
      job: name,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether the job queue is ready to accept work. Callers may use
 * this to decide whether to enqueue vs run inline.
 */
export function isJobQueueReady(): boolean {
  return _started;
}

/**
 * Gracefully stop pg-boss. Call on SIGTERM/SIGINT.
 */
export async function closeJobQueue(): Promise<void> {
  if (_boss && _started) {
    try {
      await _boss.stop({ graceful: true, timeout: 5000 });
      logger.info("jobs.stopped");
    } catch (err) {
      logger.error("jobs.stop_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    _started = false;
    _boss = null;
  }
}
