// ============================================================
// Backfill: category + sub_category for migrated listings
//
// The original migration collapsed Sharetribe's granular categoryLevel2
// (necklace, earrings, bags, mensfootwear…) into a parent category and
// DROPPED the detail, so migrated Jewellery/Footwear/Accessories listings
// have sub_category = NULL and some sit in the wrong parent.
//
// Per the client's data-mapping review (Megha, 1 Jul 2026) this re-derives
// category + sub_category from the raw Sharetribe export
// (rawdata_synthetic_new.json), keyed by legacy_sharetribe_id, and also:
//   - moves bags/belts/accessories → new "Accessories" category
//   - moves otherjewellery/jewelleryother/otherfootwear → "Other"
//   - nulls dry_cleaning_status on Jewellery + Accessories (not applicable)
//   - reports listings with no price for manual investigation
//
// SAFE: idempotent, --dry-run reports only. Requires schema-22 (Accessories
// in the category CHECK) to be applied first.
//
// Usage:
//   DATABASE_URL=postgres://… \
//   tsx scripts/backfill-subcategories.ts [--dry-run] [--file rawdata_synthetic_new.json]
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl && !dryRun) {
  console.error("DATABASE_URL is required (omit only for --dry-run reporting).");
  process.exit(1);
}

// Sharetribe categoryLevel2 → target (category, sub_category).
// Values not listed here are left untouched.
const MAP: Record<string, { category: string; sub_category: string | null }> = {
  salwarsuits: { category: "Suit/Salwar", sub_category: null },
  lehengas: { category: "Lehenga", sub_category: null },
  sarees: { category: "Saree", sub_category: null },
  indowestern: { category: "Indowestern", sub_category: null },
  menswear: { category: "Menswear", sub_category: null },
  blouses: { category: "Blouse", sub_category: null },
  kids: { category: "Kidswear", sub_category: null },
  otherclothing: { category: "Other", sub_category: null },
  // Jewellery — granular sub-categories
  necklace: { category: "Jewellery", sub_category: "Necklace/Necklace sets" },
  earrings: { category: "Jewellery", sub_category: "Earrings" },
  bangles: { category: "Jewellery", sub_category: "Bangles" },
  earringtika: { category: "Jewellery", sub_category: "Earring & Tika Sets" },
  // Footwear — granular sub-categories
  womensfootwear: { category: "Footwear", sub_category: "Women's Footwear" },
  mensfootwear: { category: "Footwear", sub_category: "Men's Footwear" },
  // Accessories — new category
  bags: { category: "Accessories", sub_category: "Bags/Clutches" },
  belts: { category: "Accessories", sub_category: "Belts" },
  otheraccessories: { category: "Accessories", sub_category: "Other accessories" },
  // "Other" catch-alls
  otherjewellery: { category: "Other", sub_category: null },
  jewelleryother: { category: "Other", sub_category: null },
  otherfootwear: { category: "Other", sub_category: null },
};

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  console.log(`Sub-category backfill ${dryRun ? "(DRY RUN)" : ""}\n`);

  if (!fs.existsSync(file)) {
    console.error(`Raw export not found: ${file}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{
    id: string;
    type: string;
    attributes: {
      publicData?: { categoryLevel2?: string };
      price?: { amount?: number | null } | null;
    };
  }>;
  const listings = raw.filter((r) => r.type === "listing");
  console.log(`${listings.length} listings in export\n`);

  // Group legacy IDs by their target (category, sub_category).
  const groups = new Map<string, { category: string; sub_category: string | null; ids: string[] }>();
  const missingPrice: string[] = [];
  let unmapped = 0;

  for (const l of listings) {
    const cat = l.attributes.publicData?.categoryLevel2;
    if (l.attributes.price?.amount == null) missingPrice.push(l.id);
    if (!cat || !MAP[cat]) {
      unmapped++;
      continue;
    }
    const target = MAP[cat];
    const key = `${target.category}||${target.sub_category ?? ""}`;
    if (!groups.has(key)) {
      groups.set(key, { category: target.category, sub_category: target.sub_category, ids: [] });
    }
    groups.get(key)!.ids.push(l.id);
  }

  console.log("Planned category/sub_category groups:");
  for (const g of groups.values()) {
    console.log(`  ${g.category} / ${g.sub_category ?? "(none)"} → ${g.ids.length} listings`);
  }
  console.log(`  (unmapped/no-category, left as-is): ${unmapped}`);
  console.log(`\nListings with NO price (investigate): ${missingPrice.length}`);
  if (missingPrice.length > 0) {
    console.log(`  sample legacy ids: ${missingPrice.slice(0, 10).join(", ")}`);
  }

  if (dryRun) {
    console.log("\n(dry run — no DB writes)");
    return;
  }

  const sql = postgres(databaseUrl!, { prepare: false });
  try {
    let updated = 0;
    for (const g of groups.values()) {
      for (const ids of chunk(g.ids, 2000)) {
        const res = await sql`
          UPDATE listings
          SET category = ${g.category},
              sub_category = ${g.sub_category},
              updated_at = NOW()
          WHERE legacy_sharetribe_id = ANY(${ids})
        `;
        updated += res.count;
      }
    }
    console.log(`\nUpdated ${updated} listing rows (category + sub_category).`);

    // Dry cleaning doesn't apply to Jewellery / Accessories — null it.
    const dc = await sql`
      UPDATE listings SET dry_cleaning_status = NULL, updated_at = NOW()
      WHERE category IN ('Jewellery', 'Accessories')
        AND dry_cleaning_status IS NOT NULL
        AND legacy_sharetribe_id IS NOT NULL
    `;
    console.log(`Nulled dry_cleaning_status on ${dc.count} Jewellery/Accessories listings.`);
  } finally {
    await sql.end();
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
