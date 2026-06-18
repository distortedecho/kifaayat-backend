// ============================================================
// Shared migration context — DB client, remap caches, counters
//
// The importer makes two passes over the JSON:
//   Pass 1: build the user/listing/transaction ID remap caches.
//           Sharetribe UUIDs are the keys; on first insert we mint
//           a new Supabase UUID (or look up an existing one by
//           legacy_sharetribe_id) and cache the mapping.
//   Pass 2: insert children using the remap to translate references.
//
// All writes are idempotent on legacy_sharetribe_id, so re-running
// the importer is safe — duplicates are skipped.
// ============================================================

import postgres from "postgres";

export interface MigrationStats {
  users: { inserted: number; skipped_existing: number; skipped_invalid: number; skipped_duplicate_email: number };
  listings: { inserted: number; skipped_rental: number; skipped_orphan: number };
  wishlists: { inserted: number; skipped_orphan_listing: number };
  orders: { inserted: number; skipped_orphan: number };
  legacy_inquiries: { inserted: number; skipped_orphan: number };
  reviews: { inserted: number; skipped_orphan: number; resolved_via_transaction: number };
  order_conversations: { inserted: number; messages_inserted: number; skipped_orphan: number };
  errors: Array<{ phase: string; legacy_id: string; error: string }>;
}

export function emptyStats(): MigrationStats {
  return {
    users: { inserted: 0, skipped_existing: 0, skipped_invalid: 0, skipped_duplicate_email: 0 },
    listings: { inserted: 0, skipped_rental: 0, skipped_orphan: 0 },
    wishlists: { inserted: 0, skipped_orphan_listing: 0 },
    orders: { inserted: 0, skipped_orphan: 0 },
    legacy_inquiries: { inserted: 0, skipped_orphan: 0 },
    reviews: { inserted: 0, skipped_orphan: 0, resolved_via_transaction: 0 },
    order_conversations: { inserted: 0, messages_inserted: 0, skipped_orphan: 0 },
    errors: [],
  };
}

export interface MigrationContext {
  sql: ReturnType<typeof postgres>;
  dryRun: boolean;
  // sharetribe_user_id -> supabase_profile_id
  userIdMap: Map<string, string>;
  // sharetribe_listing_id -> supabase_listing_id
  listingIdMap: Map<string, string>;
  // sharetribe_transaction_id -> supabase_order_id
  // Populated by importOrders; consumed by importReviews so reviews can
  // be linked back to the order they're about (UI shows reviews on the
  // order detail screen via this FK).
  orderIdMap: Map<string, string>;
  // sharetribe_transaction_id -> sharetribe_listing_id
  // Used for the review.listingId fallback (when the direct review→listing
  // ref is broken, we go through the transaction).
  transactionListingMap: Map<string, string>;
  stats: MigrationStats;
}

export function createContext(opts: {
  databaseUrl: string;
  dryRun: boolean;
}): MigrationContext {
  const sql = postgres(opts.databaseUrl, {
    max: 3, // small pool — single-process script
    prepare: false, // Supabase session-mode quirk
  });
  return {
    sql,
    dryRun: opts.dryRun,
    userIdMap: new Map(),
    listingIdMap: new Map(),
    orderIdMap: new Map(),
    transactionListingMap: new Map(),
    stats: emptyStats(),
  };
}

export function logError(
  ctx: MigrationContext,
  phase: string,
  legacyId: string,
  err: unknown
): void {
  const msg = err instanceof Error ? err.message : String(err);
  ctx.stats.errors.push({ phase, legacy_id: legacyId, error: msg });
  // Also print so we see it streaming during the run.
  console.error(`[${phase}] ${legacyId}: ${msg}`);
}
