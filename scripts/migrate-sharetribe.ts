// ============================================================
// Sharetribe → Supabase migration entry point
//
// Usage (from repo root):
//   tsx scripts/migrate-sharetribe.ts \
//     --file rawdata_synthetic_new.json \
//     --dry-run                              # default — no DB writes
//
//   tsx scripts/migrate-sharetribe.ts \
//     --file rawdata_synthetic_new.json \
//     --commit                               # actually write
//
// Reads DATABASE_URL from environment (.env). On dry-run mode, no
// writes happen but the importer still builds the remap caches so
// downstream phases can report what they WOULD insert.
//
// Designed to be safely re-runnable: every insert is idempotent on
// legacy_sharetribe_id. Crashing partway and re-running just picks
// up where it left off.
//
// See MIGRATION.md for the full plan and the per-entity mapping
// decisions encoded in scripts/migration/mappings.ts.
// ============================================================

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createContext, type MigrationContext } from "./migration/context.js";
import { importUsers } from "./migration/importUsers.js";
import { importListings } from "./migration/importListings.js";
import { aggregateUserShareCounts } from "./migration/importShareCounts.js";
import { importWishlists } from "./migration/importWishlists.js";
import { importOrders } from "./migration/importOrders.js";
import { importOrderConversations } from "./migration/importOrderConversations.js";
import { importInquiries } from "./migration/importInquiries.js";
import { importReviews } from "./migration/importReviews.js";
import type {
  SharetribeListing,
  SharetribeRecord,
  SharetribeReview,
  SharetribeTransaction,
  SharetribeUser,
} from "./migration/types.js";

interface CliArgs {
  file: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let file = "rawdata_synthetic_new.json";
  let dryRun = true; // safe default

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file" || a === "-f") {
      file = args[++i];
    } else if (a === "--commit") {
      dryRun = false;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return { file: resolve(process.cwd(), file), dryRun };
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/migrate-sharetribe.ts [options]

Options:
  -f, --file <path>   Path to the Sharetribe JSON export
                      (default: rawdata_synthetic_new.json)
  --dry-run           Read-only — no DB writes (default)
  --commit            Actually write to the database
  -h, --help          Show this help

Environment:
  DATABASE_URL        PostgreSQL connection string (required for --commit)
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(`Loading ${args.file}...`);
  const raw = readFileSync(args.file, "utf8");
  const records = JSON.parse(raw) as SharetribeRecord[];
  console.log(`Loaded ${records.length} records`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl && !args.dryRun) {
    console.error("DATABASE_URL is required when --commit is set");
    process.exit(1);
  }

  // Partition records by type — every importer wants its own slice.
  const users: SharetribeUser[] = [];
  const listings: SharetribeListing[] = [];
  const transactions: SharetribeTransaction[] = [];
  const reviews: SharetribeReview[] = [];
  for (const r of records) {
    switch (r.type) {
      case "user":
        users.push(r as SharetribeUser);
        break;
      case "listing":
        listings.push(r as SharetribeListing);
        break;
      case "transaction":
        transactions.push(r as SharetribeTransaction);
        break;
      case "review":
        reviews.push(r as SharetribeReview);
        break;
      // stockReservation / availabilityException / booking are rental
      // artefacts — ignored entirely per MIGRATION.md.
      default:
        break;
    }
  }

  console.log(
    `Partitioned: users=${users.length}, listings=${listings.length}, ` +
      `transactions=${transactions.length}, reviews=${reviews.length}`
  );

  const ctx = createContext({
    databaseUrl: databaseUrl ?? "postgres://dryrun",
    dryRun: args.dryRun,
  });

  console.log(args.dryRun ? "DRY RUN — no writes" : "COMMIT MODE — writing to DB");

  try {
    // Strict insertion order — children resolve refs through caches built
    // by their parents. Users first (populates userIdMap), then listings
    // (populates listingIdMap), then everything that links those two.
    await importUsers(ctx, users, listings, transactions);
    await importListings(ctx, listings, transactions);
    // Sum each user's per-listing share counts into the listings'
    // share_count column. Has to run AFTER listings exist.
    await aggregateUserShareCounts(ctx, users);
    await importWishlists(ctx, users);
    await importOrders(ctx, transactions);
    // Reconstruct buyer↔seller chats for the paid orders so the new
    // app's order detail screen shows the historic conversation.
    await importOrderConversations(ctx, transactions);
    await importInquiries(ctx, transactions, users);
    await importReviews(ctx, reviews, transactions);

    printSummary(ctx);
  } finally {
    if (!args.dryRun) {
      await ctx.sql.end();
    }
  }
}

function printSummary(ctx: MigrationContext): void {
  console.log("\n========== MIGRATION SUMMARY ==========");
  console.log(JSON.stringify(ctx.stats, null, 2));
  console.log("=======================================");
  if (ctx.stats.errors.length > 0) {
    console.log(`\n⚠️  ${ctx.stats.errors.length} errors logged (see above for stream output)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
