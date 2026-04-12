// ============================================================
// Structured JSON logger (Phase 6.1)
//
// Emits a single JSON line per log statement to stdout/stderr.
// Railway's log viewer parses JSON natively, so every field
// becomes a searchable dimension. In development we additionally
// pretty-print a human-readable line so local work stays
// readable.
//
// Fields:
//   level  -- "info" | "warn" | "error" | "debug"
//   msg    -- short event name (e.g. "request", "jobs.start")
//   ts     -- ISO timestamp (Railway understands ISO natively)
//   ...meta -- arbitrary structured context provided by the caller
//
// NOTE: never throw from a logger call. The logger is infra;
// failures there must not take down the request path.
// ============================================================

type LogMeta = Record<string, unknown>;

type LogLevel = "info" | "warn" | "error" | "debug";

const isProd = process.env.NODE_ENV === "production";

function formatLine(level: LogLevel, msg: string, meta?: LogMeta): string {
  // Build a stable key order for easier visual scanning.
  const payload: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(meta ?? {}),
  };
  try {
    return JSON.stringify(payload);
  } catch {
    // Fallback when meta contains circular refs.
    return JSON.stringify({
      level,
      msg,
      ts: payload.ts,
      meta_error: "failed_to_serialize_meta",
    });
  }
}

function prettyLine(level: LogLevel, msg: string, meta?: LogMeta): string {
  const time = new Date().toISOString().slice(11, 19); // HH:MM:SS
  const tag = level.toUpperCase().padEnd(5, " ");
  const extra = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[${time}] ${tag} ${msg}${extra}`;
}

function writeInfo(line: string) {
  // eslint-disable-next-line no-console
  console.log(line);
}

function writeErr(line: string) {
  // eslint-disable-next-line no-console
  console.error(line);
}

export const logger = {
  info(msg: string, meta?: LogMeta): void {
    writeInfo(formatLine("info", msg, meta));
    if (!isProd) writeInfo(prettyLine("info", msg, meta));
  },
  warn(msg: string, meta?: LogMeta): void {
    writeErr(formatLine("warn", msg, meta));
    if (!isProd) writeErr(prettyLine("warn", msg, meta));
  },
  error(msg: string, meta?: LogMeta): void {
    writeErr(formatLine("error", msg, meta));
    if (!isProd) writeErr(prettyLine("error", msg, meta));
  },
  debug(msg: string, meta?: LogMeta): void {
    // Skip debug entirely in production to avoid log noise/cost.
    if (isProd) return;
    writeInfo(formatLine("debug", msg, meta));
    writeInfo(prettyLine("debug", msg, meta));
  },
};

export type Logger = typeof logger;
