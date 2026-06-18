// ============================================================
// Users importer — batched
//
// Per client (Q4): import EVERY user as a full profile, even those
// with no apparent engagement. Email is the join key for Clerk-match
// at signup; we MUST dedupe on lower(email) before insertion because
// of the UNIQUE constraint.
//
// Sharetribe data has lots of accounts sharing an email (same person
// re-registering). We pick the highest-engagement account as winner
// and map the losers' Sharetribe UUIDs to the winner's profile ID so
// their listings/wishlists/transactions still attach correctly.
//
// All inserts batched. Profile inserts use ON CONFLICT
// (legacy_sharetribe_id) DO NOTHING for idempotency; we then SELECT
// the actual IDs (handles both newly inserted and pre-existing rows)
// to fill userIdMap. Referral codes batched separately.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import { mapIsoPrefs, mapUserCountry, normalisePhone } from "./mappings.js";
import type {
  SharetribeListing,
  SharetribeTransaction,
  SharetribeUser,
} from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

function randomSuffix(): string {
  return (
    "K" +
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4)
      .padEnd(4, "0")
  );
}

function buildReferralBase(displayName: string | null): string {
  const fromName = (displayName ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 20);
  // If display name yields nothing usable, fall back to a random base.
  return fromName || "K" + Math.random().toString(36).toUpperCase().slice(2, 8);
}

function pickDisplayName(u: SharetribeUser): string | null {
  const p = u.attributes.profile;
  if (p.displayName) return p.displayName.trim() || null;
  const parts = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return parts || null;
}

/**
 * Rough engagement score — used only to pick a "winner" when two
 * Sharetribe accounts share an email. Higher = more useful to keep.
 */
function engagementScore(u: SharetribeUser): number {
  const a = u.attributes;
  const p = a.profile ?? {};
  const meta = p.metadata ?? {};
  const priv = p.privateData ?? {};
  const pub = p.publicData ?? {};
  let score = 0;
  if (a.stripeAccountId) score += 100;
  if (a.stripeCustomerId) score += 50;
  if (meta.wishlist) score += Object.keys(meta.wishlist).length;
  if (meta.wishlistArray) score += meta.wishlistArray.length;
  if (meta.userShare) score += Object.keys(meta.userShare).length;
  if (priv.notificationTokens) score += priv.notificationTokens.length;
  if (priv.phonenumber !== undefined && priv.phonenumber !== null) score += 5;
  if (pub.user_type?.length) score += 5;
  if (meta.extId !== undefined && meta.extId !== null) score += 10;
  return score;
}

export async function importUsers(
  ctx: MigrationContext,
  users: SharetribeUser[],
  _listings: SharetribeListing[],
  _transactions: SharetribeTransaction[]
): Promise<void> {
  console.log(`[users] importing ${users.length} records`);

  // ---- Pre-pass: dedupe by email ----
  const byEmail = new Map<string, { winner: SharetribeUser; losers: string[] }>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const u of users) {
    if (!u.attributes.email) {
      invalidCount += 1;
      continue;
    }
    const email = u.attributes.email.toLowerCase().trim();
    const existing = byEmail.get(email);
    if (!existing) {
      byEmail.set(email, { winner: u, losers: [] });
      continue;
    }
    duplicateCount += 1;
    if (engagementScore(u) > engagementScore(existing.winner)) {
      existing.losers.push(existing.winner.id);
      existing.winner = u;
    } else {
      existing.losers.push(u.id);
    }
  }

  ctx.stats.users.skipped_invalid = invalidCount;
  ctx.stats.users.skipped_duplicate_email = duplicateCount;

  console.log(
    `[users] after dedupe — ${byEmail.size} unique emails ` +
      `(${duplicateCount} duplicates collapsed, ${invalidCount} email-less skipped)`
  );

  // ---- Build rows (winners only) ----
  type ProfileRow = {
    clerk_id: string | null;
    email: string;
    legacy_sharetribe_id: string;
    legacy_numeric_id: string | null;
    display_name: string | null;
    bio: string | null;
    location: string | null;
    phone: string | null;
    is_admin: boolean;
    banned_at: string | null;
    ban_reason: string | null;
    stripe_account_id: string | null;
    stripe_customer_id: string | null;
    stripe_onboarding_complete: boolean;
    profile_complete: boolean;
    looking_for_categories: string[] | null;
    usual_sizes: string[] | null;
    buy_preferences: string[] | null;
    budget_ceiling: number | null;
    search_notes: string | null;
    user_intents: string[];
    terms_accepted_at: string | null;
    created_at: string;
  };

  // Track winner + losers in order so we can populate userIdMap for all
  // their Sharetribe UUIDs after the bulk SELECT lands.
  const winnersInOrder: Array<{ user: SharetribeUser; losers: string[] }> = [];
  const profileRows: ProfileRow[] = [];

  for (const entry of byEmail.values()) {
    const u = entry.winner;
    const a = u.attributes;
    const p = a.profile;
    const meta = p.metadata ?? {};
    const priv = p.privateData ?? {};
    const pub = p.publicData ?? {};

    const displayName = pickDisplayName(u);
    const bannedAt = a.banned === true ? a.createdAt : null;
    const banReason =
      a.banned === true ? "Carried over from Sharetribe" : null;
    const legacyNumericId =
      meta.extId !== undefined && meta.extId !== null
        ? String(meta.extId)
        : null;
    const iso = mapIsoPrefs(pub);

    // Sharetribe's `publicData.user_type` is the old "what kind of user
    // are you?" picker. Values: ["seller"] / ["buyer"] / ["seller", "buyer"].
    // Our app's column expects ["sell", "buy"]. Pre-fills the new app's
    // onboarding seller/buyer toggle so returning users don't re-pick.
    const sharetribeUserType = (pub.user_type as string[] | undefined) ?? [];
    const userIntents: string[] = [];
    if (sharetribeUserType.includes("buyer")) userIntents.push("buy");
    if (sharetribeUserType.includes("seller")) userIntents.push("sell");

    // Sharetribe stored terms acceptance under protectedData.terms.
    // Format varies (boolean / object with version+timestamp / null).
    // For our purposes any truthy value means they accepted; we stamp
    // the acceptance with their createdAt as a best-effort timestamp
    // since the original acceptance time isn't reliably exposed.
    const protectedData = p.protectedData ?? {};
    const terms = (protectedData as Record<string, unknown>).terms;
    const termsAcceptedAt = terms ? a.createdAt : null;

    profileRows.push({
      clerk_id: null,
      email: a.email.toLowerCase().trim(),
      legacy_sharetribe_id: u.id,
      legacy_numeric_id: legacyNumericId,
      display_name: displayName,
      bio: p.bio ?? null,
      location: mapUserCountry(pub.user_country),
      phone: normalisePhone(priv.phonenumber),
      is_admin: meta.isAdmin === true,
      banned_at: bannedAt,
      ban_reason: banReason,
      stripe_account_id: a.stripeAccountId ?? null,
      stripe_customer_id: a.stripeCustomerId ?? null,
      stripe_onboarding_complete:
        meta.stripeConnectVerified === true || !!a.stripeAccountId,
      profile_complete: false,
      looking_for_categories: iso.looking_for_categories,
      usual_sizes: iso.usual_sizes,
      buy_preferences: iso.buy_preferences,
      budget_ceiling: iso.budget_ceiling,
      search_notes: iso.search_notes,
      user_intents: userIntents,
      terms_accepted_at: termsAcceptedAt,
      created_at: a.createdAt,
    });

    winnersInOrder.push({ user: u, losers: entry.losers });
  }

  // ---- Dry-run shortcut: fake the remap, skip DB ----
  if (ctx.dryRun) {
    for (const { user, losers } of winnersInOrder) {
      ctx.userIdMap.set(user.id, `dry-${user.id}`);
      for (const l of losers) ctx.userIdMap.set(l, `dry-${user.id}`);
    }
    ctx.stats.users.inserted = profileRows.length;
    console.log(`[users] dry-run — would have inserted ${profileRows.length} profiles`);
    return;
  }

  // ---- Batched INSERTs ----
  const batches = chunk(profileRows, DEFAULT_BATCH_SIZE);
  let inserted = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      // postgres-js multi-row VALUES via sql(rows, ...cols)
      await ctx.sql`
        INSERT INTO profiles ${ctx.sql(
          batch,
          "clerk_id",
          "email",
          "legacy_sharetribe_id",
          "legacy_numeric_id",
          "display_name",
          "bio",
          "location",
          "phone",
          "is_admin",
          "banned_at",
          "ban_reason",
          "stripe_account_id",
          "stripe_customer_id",
          "stripe_onboarding_complete",
          "profile_complete",
          "looking_for_categories",
          "usual_sizes",
          "buy_preferences",
          "budget_ceiling",
          "search_notes",
          "user_intents",
          "terms_accepted_at",
          "created_at"
        )}
        ON CONFLICT (legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL
        DO NOTHING
      `;
      inserted += batch.length;
      if ((i + 1) % 5 === 0 || i === batches.length - 1) {
        console.log(`[users] inserted ${inserted}/${profileRows.length}`);
      }
    } catch (err) {
      logError(ctx, "users", `batch[${i}]`, err);
    }
  }

  // ---- Bulk SELECT to fill userIdMap ----
  // We pull all the IDs (newly inserted OR previously existing) in one
  // round-trip and use that to populate the remap. This also handles
  // re-runs cleanly — if a row already existed before this run, we get
  // its real ID, not a stale one.
  console.log(`[users] fetching IDs for ${profileRows.length} profiles...`);
  const sharetribeIds = profileRows.map((r) => r.legacy_sharetribe_id);
  const idChunks = chunk(sharetribeIds, 2000);
  type IdRow = { id: string; legacy_sharetribe_id: string };
  const lookup = new Map<string, string>();
  for (let ci = 0; ci < idChunks.length; ci++) {
    const rows = (await ctx.sql`
      SELECT id, legacy_sharetribe_id FROM profiles
      WHERE legacy_sharetribe_id = ANY(${idChunks[ci]})
    `) as unknown as IdRow[];
    for (const r of rows) {
      lookup.set(r.legacy_sharetribe_id, r.id);
    }
    console.log(`[users] id-lookup chunk ${ci + 1}/${idChunks.length} → ${lookup.size} mapped`);
  }

  // Map winner Sharetribe IDs → profile IDs, AND map each loser's
  // Sharetribe ID to the winner's profile ID (so their child entities
  // attach to the right person).
  let mappedCount = 0;
  for (const { user, losers } of winnersInOrder) {
    const pid = lookup.get(user.id);
    if (!pid) continue;
    ctx.userIdMap.set(user.id, pid);
    mappedCount += 1;
    for (const l of losers) {
      ctx.userIdMap.set(l, pid);
    }
  }
  ctx.stats.users.inserted = mappedCount;

  // ---- Referral codes (batched) ----
  console.log(`[users] inserting referral codes...`);
  await batchInsertReferralCodes(ctx, winnersInOrder, lookup);

  console.log(
    `[users] done — inserted/mapped=${mappedCount}, ` +
      `duplicate_emails=${duplicateCount}, ` +
      `invalid=${invalidCount}`
  );
}

/**
 * Insert one referral code per profile in batches. Pre-generates
 * the code text client-side so all rows can go in one statement;
 * relies on ON CONFLICT (code) DO NOTHING for the (extremely rare)
 * collision case. A second pass after handles profiles that ended
 * up without a code due to collision.
 */
async function batchInsertReferralCodes(
  ctx: MigrationContext,
  winnersInOrder: Array<{ user: SharetribeUser; losers: string[] }>,
  lookup: Map<string, string>
): Promise<void> {
  type CodeRow = { user_id: string; code: string };
  const rows: CodeRow[] = [];

  for (const { user } of winnersInOrder) {
    const profileId = lookup.get(user.id);
    if (!profileId) continue;
    const base = buildReferralBase(pickDisplayName(user));
    rows.push({ user_id: profileId, code: `${base}-${randomSuffix()}` });
  }

  const batches = chunk(rows, DEFAULT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO referral_codes ${ctx.sql(batches[i], "user_id", "code")}
        ON CONFLICT (code) DO NOTHING
      `;
      if ((i + 1) % 5 === 0 || i === batches.length - 1) {
        console.log(`[referral_codes] inserted batch ${i + 1}/${batches.length}`);
      }
    } catch (err) {
      logError(ctx, "referral_codes", `batch[${i}]`, err);
    }
  }

  // Pick up any profile that didn't get a code (silent ON CONFLICT skip
  // because of code collision). Retry those one-by-one with a fresh code.
  const profileIds = rows.map((r) => r.user_id);
  const idChunks = chunk(profileIds, 2000);
  const haveCode = new Set<string>();
  type Row = { user_id: string };
  for (const idChunk of idChunks) {
    const have = (await ctx.sql`
      SELECT user_id FROM referral_codes
      WHERE user_id = ANY(${idChunk})
    `) as unknown as Row[];
    for (const r of have) haveCode.add(r.user_id);
  }

  const missing = rows.filter((r) => !haveCode.has(r.user_id));
  if (missing.length === 0) return;

  console.log(`[referral_codes] retrying ${missing.length} missing (batched)`);
  // Generate a fresh code for each missing row and batch the retry —
  // sequential retries against a remote DB were taking ~5 minutes for
  // a few hundred rows.
  const retryRows = missing.map((r) => {
    const base = r.code.split("-")[0];
    return { user_id: r.user_id, code: `${base}-${randomSuffix()}` };
  });

  const retryBatches = chunk(retryRows, DEFAULT_BATCH_SIZE);
  for (let i = 0; i < retryBatches.length; i++) {
    try {
      await ctx.sql`
        INSERT INTO referral_codes ${ctx.sql(retryBatches[i], "user_id", "code")}
        ON CONFLICT (code) DO NOTHING
      `;
    } catch (err) {
      logError(ctx, "referral_codes", `retry_batch[${i}]`, err);
    }
  }
  // A handful (<1%) may still collide twice; that's fine — accept the
  // gap rather than loop forever. Users still have a profile and can
  // be granted a code later by the runtime auto-gen path.
}
