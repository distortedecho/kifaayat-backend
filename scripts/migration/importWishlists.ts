// ============================================================
// Wishlists importer — batched
//
// Sharetribe has TWO wishlist formats coexisting on older accounts:
//   profile.metadata.wishlist       { listingId: true, ... }
//   profile.metadata.wishlistArray  [ listingId, ... ]
//
// 340 users have both, 63 have only the old map, 0 have only the
// array. Importer reads both per user, dedupes listing IDs, and
// emits one (user_id, listing_id) pair to the new app's wishlists
// table. UNIQUE(user_id, listing_id) gives us idempotency for free.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import type { SharetribeUser } from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

export async function importWishlists(
  ctx: MigrationContext,
  users: SharetribeUser[]
): Promise<void> {
  console.log(`[wishlists] scanning ${users.length} users for wishlist entries`);

  type WishlistRow = {
    user_id: string;
    listing_id: string;
    created_at: string;
  };
  const rows: WishlistRow[] = [];
  let scanned = 0;

  for (const u of users) {
    const profileId = ctx.userIdMap.get(u.id);
    if (!profileId) continue;

    const meta = u.attributes.profile.metadata ?? {};
    const listingIds = new Set<string>();
    if (meta.wishlist) {
      for (const id of Object.keys(meta.wishlist)) listingIds.add(id);
    }
    if (meta.wishlistArray) {
      for (const id of meta.wishlistArray) listingIds.add(id);
    }
    if (listingIds.size === 0) continue;

    for (const sharetribeListingId of listingIds) {
      scanned += 1;
      const supabaseListingId = ctx.listingIdMap.get(sharetribeListingId);
      if (!supabaseListingId) {
        ctx.stats.wishlists.skipped_orphan_listing += 1;
        continue;
      }
      rows.push({
        user_id: profileId,
        listing_id: supabaseListingId,
        created_at: u.attributes.createdAt,
      });
    }
  }

  // De-dup inside the batch in case the same user has the same listing
  // appearing in both wishlist formats AND we've also collapsed several
  // Sharetribe accounts into one profile (so duplicate pairs sneak in).
  // Without this, the UNIQUE(user_id, listing_id) trip inside a batch
  // would fail the whole batch.
  const seen = new Set<string>();
  const deduped: WishlistRow[] = [];
  for (const r of rows) {
    const key = `${r.user_id}|${r.listing_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  if (ctx.dryRun) {
    ctx.stats.wishlists.inserted = deduped.length;
    console.log(
      `[wishlists] dry-run — scanned ${scanned} pairs, would insert ${deduped.length}, ` +
        `orphan_listings=${ctx.stats.wishlists.skipped_orphan_listing}`
    );
    return;
  }

  const batches = chunk(deduped, DEFAULT_BATCH_SIZE);
  let inserted = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO wishlists ${ctx.sql(batches[i], "user_id", "listing_id", "created_at")}
        ON CONFLICT (user_id, listing_id) DO NOTHING
      `;
      inserted += batches[i].length;
    } catch (err) {
      logError(ctx, "wishlists", `batch[${i}]`, err);
    }
  }
  ctx.stats.wishlists.inserted = inserted;

  console.log(
    `[wishlists] done — scanned ${scanned} pairs, ` +
      `inserted=${inserted}, ` +
      `orphan_listings=${ctx.stats.wishlists.skipped_orphan_listing}`
  );
}
