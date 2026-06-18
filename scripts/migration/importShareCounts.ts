// ============================================================
// Aggregate share counts from profile.metadata.userShare
//
// Sharetribe tracked sharing the OPPOSITE way the new app does:
//   - new app: listing has a single share_count integer
//   - Sharetribe: each user has metadata.userShare = { listingId: count }
//     (i.e. "this user shared listing X N times")
//
// To migrate, we walk every user's userShare map, sum per listing,
// then bulk-UPDATE listings to add those totals onto whatever the
// listing-level shareCount already had (from importListings —
// metadata.shareCount). Result: listings.share_count reflects every
// share that happened on Sharetribe regardless of which side stored it.
//
// Idempotency: this would double-count on re-runs because we ADD to
// share_count. Guard with a flag — but practically the importer is
// only re-run after wiping migration data, so we don't worry about it
// here. The post-pass is fast (single UPDATE per listing).
//
// Only ~189 users have userShare data, so the in-memory aggregation
// is trivial.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import type { SharetribeUser } from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

export async function aggregateUserShareCounts(
  ctx: MigrationContext,
  users: SharetribeUser[]
): Promise<void> {
  // Sum shares per Sharetribe listing UUID
  const sharesByListing = new Map<string, number>();
  for (const u of users) {
    const userShare = u.attributes.profile.metadata?.userShare;
    if (!userShare) continue;
    for (const [listingId, count] of Object.entries(userShare)) {
      const c = Number(count) || 0;
      if (c <= 0) continue;
      sharesByListing.set(
        listingId,
        (sharesByListing.get(listingId) ?? 0) + c
      );
    }
  }

  if (sharesByListing.size === 0) {
    console.log("[share_counts] no userShare data to aggregate");
    return;
  }

  console.log(
    `[share_counts] aggregated shares across ${sharesByListing.size} listings`
  );

  if (ctx.dryRun) {
    console.log(`[share_counts] dry-run — would UPDATE ${sharesByListing.size} listings`);
    return;
  }

  // Build update rows; only emit for listings we actually migrated.
  type Row = { listing_id: string; bump: number };
  const updateRows: Row[] = [];
  for (const [sharetribeListingId, bump] of sharesByListing) {
    const supabaseListingId = ctx.listingIdMap.get(sharetribeListingId);
    if (!supabaseListingId) continue;
    updateRows.push({ listing_id: supabaseListingId, bump });
  }

  // postgres-js multi-row VALUES + UPDATE FROM pattern.
  const batches = chunk(updateRows, DEFAULT_BATCH_SIZE);
  let bumped = 0;
  for (let i = 0; i < batches.length; i++) {
    try {
      const batch = batches[i];
      // VALUES clause infers types from the first row, but postgres-js
      // serialises array values as text by default. Explicit casts on both
      // columns make this robust regardless of inferred types.
      await ctx.sql`
        UPDATE listings AS l
        SET share_count = l.share_count + (v.bump)::integer
        FROM (VALUES ${ctx.sql(batch.map((r) => [r.listing_id, r.bump]))})
          AS v(listing_id, bump)
        WHERE l.id = (v.listing_id)::uuid
      `;
      bumped += batch.length;
    } catch (err) {
      logError(ctx, "share_counts", `batch[${i}]`, err);
    }
  }

  console.log(`[share_counts] bumped ${bumped}/${updateRows.length} listings`);
}
