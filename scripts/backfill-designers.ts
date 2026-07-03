// ============================================================
// Backfill: canonical designer_name + designer_origin
//
// The client provided a designer cleanup CSV
// (designer clean up - designer-brand.csv):
//   Raw Value | Match Key (normalized) | Canonical Name (Column C) | Origin
//
// Per the client:
//   - Map each listing's designer to its Canonical Name (Column C).
//   - If the canonical is blank → leave the designer BLANK (null).
//   - Capture brand Origin (Indian / Pakistani; Unknown → null) so the app
//     can segment Indian vs Pakistani designers.
//
// We match on the raw Sharetribe designer value (free-text `designer`, or
// the `designerID` slug resolved to a name) using the SAME normalization
// the CSV's Match Key uses: lowercase, strip non-alphanumeric.
//
// SAFE: idempotent, --dry-run reports only. Requires schema-23 (designer_origin).
//
// Usage:
//   DATABASE_URL=postgres://… \
//   tsx scripts/backfill-designers.ts [--dry-run] \
//     [--file rawdata_synthetic_new.json] [--csv "designer clean up - designer-brand.csv"]
// ============================================================

import "dotenv/config";
import fs from "node:fs";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = argValue("--file") ?? "rawdata_synthetic_new.json";
const csvPath = argValue("--csv") ?? "designer clean up - designer-brand.csv";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !dryRun) {
  console.error("DATABASE_URL is required (omit only for --dry-run).");
  process.exit(1);
}

// Match-key normalization — mirrors the CSV's "Match Key" column.
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// designerID slug → display name (from the original migration mapping), so
// slug-picked designers resolve to a name we can match against the CSV.
const SLUG_MAP: Record<string, string> = {
  "seema-gujral": "Seema Gujral", maria: "Maria B", sana: "Sana Safinaz",
  "anita-dogre": "Anita Dongre", papadontpreach: "Papa Don't Preach",
  mohsin: "Mohsin Naveed Ranjha", faraz: "Faraz Manan",
  suffuse: "Suffuse by Sana Yasir", "sobia-nazir": "Sobia Nazir",
  sabyasachi: "Sabyasachi", gauravgupta: "Gaurav Gupta", faiza: "Faiza Saqlain",
  aghaoor: "Agha Noor", abhinavmishra: "Abhinav Mishra", vvani: "Vvani",
  tarun: "Tarun Tahiliani", ritukumar: "Ritu Kumar", payalsinghal: "Payal Singhal",
  masaba_gupta: "Masaba Gupta", manishmalhotra: "Manish Malhotra",
  "mahima-mahajan": "Mahima Mahajan", dollyj: "Dolly J", asim: "Asim Jofa",
  anushree: "Anushree Reddy", "hussain-rehar": "Hussain Rehar",
};

/** Quote-aware CSV line parser (handles embedded commas in "..." fields). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
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
  console.log(`Designer backfill ${dryRun ? "(DRY RUN)" : ""}\n`);

  // ---- Load CSV → matchKey → { canonical, origin } ----
  const csvLines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  csvLines.shift(); // header
  const csvMap = new Map<string, { canonical: string | null; origin: string | null }>();
  for (const line of csvLines) {
    const [, matchKey, canonicalRaw, originRaw] = parseCsvLine(line);
    if (!matchKey) continue;
    const canonical = canonicalRaw && canonicalRaw.trim() ? canonicalRaw.trim() : null;
    const origin = originRaw === "Indian" || originRaw === "Pakistani" ? originRaw : null;
    csvMap.set(matchKey, { canonical, origin });
  }
  console.log(`CSV: ${csvMap.size} match keys loaded`);

  // ---- Walk export listings, resolve each designer ----
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
    id: string;
    type: string;
    attributes: { publicData?: { designer?: string; designerID?: string } };
  }>;
  const listings = raw.filter((r) => r.type === "listing");

  // Group updates by (designer_name, origin) so we can batch.
  const groups = new Map<string, { designer_name: string | null; origin: string | null; ids: string[] }>();
  let matched = 0, blanked = 0, unmatched = 0, noDesigner = 0;
  const originCount = { Indian: 0, Pakistani: 0 };
  const unmatchedSamples: string[] = [];

  for (const l of listings) {
    const pd = l.attributes.publicData || {};
    let rawDesigner: string | null = null;
    if (pd.designer && pd.designer.trim()) rawDesigner = pd.designer.trim();
    else if (pd.designerID && SLUG_MAP[pd.designerID.toLowerCase()]) {
      rawDesigner = SLUG_MAP[pd.designerID.toLowerCase()];
    }
    if (!rawDesigner) { noDesigner++; continue; }

    // Unmatched = not in the client's canonical CSV → treat as not-a-real-
    // designer and BLANK it (option B). Values here are junk like "Yes",
    // "3 pieces", "hand embroidery".
    const hit = csvMap.get(norm(rawDesigner)) ?? { canonical: null, origin: null };
    if (!csvMap.has(norm(rawDesigner))) {
      unmatched++;
      if (unmatchedSamples.length < 15) unmatchedSamples.push(rawDesigner);
    }
    if (hit.canonical === null) blanked++; else matched++;
    if (hit.origin) originCount[hit.origin as "Indian" | "Pakistani"]++;

    const key = `${hit.canonical ?? ""}||${hit.origin ?? ""}`;
    if (!groups.has(key)) {
      groups.set(key, { designer_name: hit.canonical, origin: hit.origin, ids: [] });
    }
    groups.get(key)!.ids.push(l.id);
  }

  console.log(`\nListings: ${listings.length} total`);
  console.log(`  matched to canonical:  ${matched}`);
  console.log(`  cleared (blank canonical + unmatched junk): ${blanked} (of which unmatched: ${unmatched})`);
  console.log(`  no designer:           ${noDesigner}`);
  console.log(`  origin tagged: Indian=${originCount.Indian}, Pakistani=${originCount.Pakistani}`);
  if (unmatchedSamples.length) {
    console.log(`  unmatched samples: ${unmatchedSamples.join(" | ")}`);
  }

  if (dryRun) { console.log("\n(dry run — no DB writes)"); return; }

  const sql = postgres(databaseUrl!, { prepare: false });
  try {
    let updated = 0;
    for (const g of groups.values()) {
      for (const ids of chunk(g.ids, 2000)) {
        const res = await sql`
          UPDATE listings
          SET designer_name = ${g.designer_name},
              designer_origin = ${g.origin},
              updated_at = NOW()
          WHERE legacy_sharetribe_id = ANY(${ids})
        `;
        updated += res.count;
      }
    }
    console.log(`\nUpdated ${updated} listing rows (designer_name + designer_origin).`);
  } finally {
    await sql.end();
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
