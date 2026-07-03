// ============================================================
// Seed the `designers` table from the cleanup CSV
//
// Loads the distinct canonical designer names (Column C) + origin from
// "designer clean up - designer-brand.csv" into the `designers` table so
// GET /api/designers?q=… can typeahead against the full ~5.5k list.
//
// SAFE: idempotent (upsert on name), --dry-run reports only. Requires
// schema-24 (designers table).
//
// Usage:
//   DATABASE_URL=postgres://… \
//   tsx scripts/seed-designers.ts [--dry-run] [--csv "designer clean up - designer-brand.csv"]
// ============================================================

import "dotenv/config";
import fs from "node:fs";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const csvPath = argValue("--csv") ?? "designer clean up - designer-brand.csv";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !dryRun) {
  console.error("DATABASE_URL is required (omit only for --dry-run).");
  process.exit(1);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log(`Seed designers ${dryRun ? "(DRY RUN)" : ""}\n`);

  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  lines.shift(); // header

  // Distinct canonical name → origin (prefer a known Indian/Pakistani over null).
  const byName = new Map<string, string | null>();
  for (const line of lines) {
    const cols = parseCsvLine(line);
    const canonical = cols[2]?.trim();
    const originRaw = cols[3]?.trim();
    if (!canonical) continue;
    const origin = originRaw === "Indian" || originRaw === "Pakistani" ? originRaw : null;
    if (!byName.has(canonical) || (origin && !byName.get(canonical))) {
      byName.set(canonical, origin);
    }
  }

  const rows = [...byName.entries()].map(([name, origin]) => ({ name, origin }));
  const withOrigin = rows.filter((r) => r.origin).length;
  console.log(`Distinct canonical designers: ${rows.length} (origin-tagged: ${withOrigin})`);

  if (dryRun) {
    console.log("sample:", rows.slice(0, 8).map((r) => `${r.name}${r.origin ? " [" + r.origin + "]" : ""}`).join(" | "));
    console.log("\n(dry run — no DB writes)");
    return;
  }

  const sql = postgres(databaseUrl!, { prepare: false });
  try {
    let inserted = 0;
    for (const batch of chunk(rows, 1000)) {
      const res = await sql`
        INSERT INTO designers ${sql(batch, "name", "origin")}
        ON CONFLICT (name) DO UPDATE
          SET origin = COALESCE(EXCLUDED.origin, designers.origin)
      `;
      inserted += res.count;
    }
    console.log(`\nUpserted ${inserted} designers.`);
  } finally {
    await sql.end();
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
