// ============================================================
// Batching helpers — keep importers fast on remote Postgres
//
// Sequential inserts over a ~150ms RTT take ~7 inserts/sec — fine
// for a few hundred rows, brutal for 18K. Switching to multi-row
// VALUES (postgres-js `sql(rows)` helper) drops 18K user inserts
// from ~45 min to ~10 sec.
//
// PostgreSQL has a 65,535-parameter cap per statement; with ~25
// columns per profile row, a batch of 500 = 12,500 params. Safe.
// Keep batch size at 500 unless individual rows have many columns.
// ============================================================

export const DEFAULT_BATCH_SIZE = 500;

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
