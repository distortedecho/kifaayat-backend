// ============================================================
// Clean migrated (Sharetribe) data — before a fresh re-seed
//
// Deletes everything imported from Sharetribe so the migration can be
// re-run with a new export. NON-migrated data (real app signups, i.e.
// profiles with legacy_sharetribe_id IS NULL, and their listings/orders)
// is PRESERVED.
//
// Strategy: almost every table references profiles(id) ON DELETE CASCADE,
// so deleting migrated profiles cascades their listings → photos/offers/
// wishlists, orders, reviews, conversations → messages, referral_codes,
// notifications. Only seller_payouts has a restrictive FK, so we clear the
// rows tied to migrated data first. legacy_inquiries + designers are
// standalone and cleared explicitly (designers gets re-seeded).
//
// SAFE: wrapped in a transaction; --dry-run reports counts and writes
// nothing. Re-runnable.
//
// Usage:
//   DATABASE_URL=postgres://… tsx scripts/clean-migrated-data.ts [--dry-run]
// ============================================================

import "dotenv/config";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false });

async function main() {
  console.log(`Clean migrated data ${dryRun ? "(DRY RUN)" : ""}\n`);

  // ---- Report what's there ----
  const [mp] = await sql`SELECT COUNT(*)::int n FROM profiles WHERE legacy_sharetribe_id IS NOT NULL`;
  const [ml] = await sql`SELECT COUNT(*)::int n FROM listings WHERE legacy_sharetribe_id IS NOT NULL`;
  const [mo] = await sql`SELECT COUNT(*)::int n FROM orders WHERE legacy_sharetribe_id IS NOT NULL`;
  const [claimed] = await sql`SELECT COUNT(*)::int n FROM profiles WHERE legacy_sharetribe_id IS NOT NULL AND clerk_id IS NOT NULL`;
  const [realProfiles] = await sql`SELECT COUNT(*)::int n FROM profiles WHERE legacy_sharetribe_id IS NULL`;
  const [inq] = await sql`SELECT COUNT(*)::int n FROM legacy_inquiries`;
  const [des] = await sql`SELECT COUNT(*)::int n FROM designers`;

  console.log("Migrated data to DELETE:");
  console.log(`  profiles:        ${mp.n}  (of which claimed/clerk-linked: ${claimed.n})`);
  console.log(`  listings:        ${ml.n}`);
  console.log(`  orders:          ${mo.n}`);
  console.log(`  legacy_inquiries:${inq.n}`);
  console.log(`  designers:       ${des.n} (will be re-seeded)`);
  console.log(`\nPRESERVED (non-migrated real signups): ${realProfiles.n} profiles\n`);

  if (dryRun) {
    console.log("(dry run — nothing deleted)");
    await sql.end();
    return;
  }

  await sql.begin(async (tx) => {
    // 1. legacy_inquiries FIRST. Its listing_id/buyer_id/seller_id are
    //    ON DELETE SET NULL, and some rows already hold orphaned listing_ids
    //    from the original import — so letting the profiles-delete cascade
    //    SET-NULL-update them re-validates the row and fails on the stale
    //    listing_id. Deleting these outright first sidesteps that entirely.
    const delInq = await tx`DELETE FROM legacy_inquiries`;

    // 2. Restrictive FK: clear seller_payouts tied to migrated sellers/orders.
    await tx`
      DELETE FROM seller_payouts
      WHERE seller_id IN (SELECT id FROM profiles WHERE legacy_sharetribe_id IS NOT NULL)
    `;
    await tx`
      DELETE FROM seller_payouts sp USING orders o
      WHERE sp.order_id = o.id
        AND (o.seller_id IN (SELECT id FROM profiles WHERE legacy_sharetribe_id IS NOT NULL)
             OR o.listing_id IN (SELECT id FROM listings WHERE legacy_sharetribe_id IS NOT NULL))
    `;

    // 3. Delete migrated profiles → cascades listings/orders/reviews/
    //    conversations/messages/wishlists/referral_codes/notifications.
    const delProfiles = await tx`
      DELETE FROM profiles WHERE legacy_sharetribe_id IS NOT NULL
    `;

    // 4. Designers (re-seeded after).
    const delDes = await tx`DELETE FROM designers`;

    console.log(`Deleted: legacy_inquiries=${delInq.count}, profiles=${delProfiles.count}, designers=${delDes.count}`);
    console.log("(listings/orders/reviews/conversations/messages/wishlists/referral_codes/notifications cascaded)");
  });

  console.log("\nDone. Ready for a fresh migrate:sharetribe run.");
  await sql.end();
}

main().catch(async (err) => {
  console.error("Script error:", err);
  await sql.end().catch(() => {});
  process.exit(1);
});
