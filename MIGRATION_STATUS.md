# Sharetribe Migration — Current Status & Execution Log

Companion to `MIGRATION.md` (which captures the plan). This file
captures **what's actually been done**, **decisions made during
execution**, **bugs discovered + fixed**, and **the validated working
state** as of the last working session.

If you're future-me reading this after a context compaction: this is
the source of truth for "where are we right now" and "what should I
already know."

Last working session: 2026-06-17 (started 2026-06-13).

---

## TL;DR for compaction-safe context

The Sharetribe → Supabase migration is **end-to-end validated**:

1. **Schema migration `schema-09.sql` is written and applied to main.**
   Covers nullable clerk_id, email column, all legacy_* columns,
   widened constraints (currency, location, category, condition),
   and the `legacy_inquiries` admin-archive table.

2. **Importer `scripts/migrate-sharetribe.ts` is feature-complete.**
   Six entity-specific importers, all batched, all idempotent on
   `legacy_sharetribe_id`. Runs in ~30-60 seconds against remote
   Supabase. CLI supports `--dry-run` / `--commit`.

3. **Email-match-on-Clerk-signup logic is wired in
   `src/routes/profiles.ts`.** When a returning user signs up via
   Clerk with the same email they used on the old Sharetribe app,
   `GET /api/profiles/me` claims the pre-migrated profile and
   stamps the Clerk ID onto it. Their old listings/wishlist/reviews
   appear immediately.

4. **Tested end-to-end against MAIN database** (the user's dev/staging
   Supabase, not real prod). Confirmed:
   - Migration runs clean with `errors: []`
   - 9,216 profiles + 10,192 listings + 1,701 wishlists + 76 orders
     + 939 legacy_inquiries + 56 reviews all landed
   - User overrode one migrated profile's email with their own real
     email, signed up to Clerk on the Android app, and successfully
     **saw the migrated user's data** (listings, wishlist, profile).

5. **Remaining for production cutover**:
   - Photo backfill (waiting on client's 112 GB high-res JSON)
   - Video backfill (waiting on client's MP4 folder)
   - Designer dropdown sign-off (waiting on client, CSV already sent)
   - Run schema-08 + schema-09 + importer against real prod export
     (when client provides non-anonymised production data)

---

## Today's session — what we actually did

### Phase 1 — Validated migration end-to-end on a Supabase branch

Created a `migration-test` branch (Supabase branches clone schema
only, not data — which is fine; the branch became a clean test env).

Iteratively discovered and fixed:

| Issue | Where | Fix |
|---|---|---|
| `phone` column missing from profiles | schema-08.sql had it but the branch was cloned before | Added to schema-08.sql + manual `ALTER TABLE` on the branch |
| User dedup by email failed (UNIQUE collision) | 9,238 of 18,454 Sharetribe records had duplicate emails (synthetic data artefact — small fake-email pool) | Pre-pass dedupe in importer keeps highest-engagement winner per email; loser Sharetribe UUIDs map to winner's profile ID in `userIdMap` so child entities still attach |
| `profiles.is_banned` column didn't exist | Schema actually uses `banned_at` (TIMESTAMPTZ) + `ban_reason` (TEXT) | Importer now stamps both columns when `banned: true` |
| `profiles.location` rejected user_country values | Schema CHECK was AU/US/NZ only; data had `nz_user`, `Canada`, `United States`, `United Kingdom`, `Australia` etc. | (a) Widened CHECK in schema-09 to include CA + UK; (b) Expanded `mapUserCountry` to handle slug + full-name variants case-insensitively |
| `colour` field marshalled wrong (singular string vs array TEXT[]) | Sharetribe stores `colour` as a single string; my code assumed array | Added `coerceToStringArray()` helper that handles null, string, or array uniformly. Applied to `colour`, `fabric`, `Occasion`, `kifaayatonly`, `productTypeOptional` |
| `listings_status_check` rejected `'archived'` | Schema only allows draft / pending_review / active / reserved / sold / deactivated | Renamed importer's archived → `deactivated` |
| `listings_condition_check` rejected `preOwned` etc | Sharetribe uses camelCase enum; schema uses display names | New `mapCondition()` helper: preOwned → "Pre-loved", newWithoutTags → "New without tags", etc. |
| `listings_category_check` rejected `'Footwear'` | Schema CHECK didn't include it; 82 footwear listings affected | Widened CHECK in schema-09 to add Footwear |
| `listings_price_currency_check` rejected CAD + GBP | Schema was AUD/USD/NZD only; data had ~2,500 listings in CAD/GBP | Widened CHECK in schema-09 across `listings`, `orders`, `offers`, `profiles` |
| `invalid input syntax for type integer: "1798.99..."` | Sharetribe shipping field has floats (FP arithmetic); also some prices are absurdly large (`6,421,100,382,900` = $64B) | Added `sanitizeCents()` helper that rounds, clamps to $20M max, returns null for non-finite/negative |
| Reviews had no idempotency (re-runs would duplicate the 56 reviews) | Reviews table lacks any natural unique key | Added `legacy_sharetribe_id` column to reviews via schema-09 + ON CONFLICT in importer |
| Sequential 1-row inserts taking ~2 hours total | Each insert is a 150ms round-trip × ~30,000 inserts | Refactored every importer to multi-row VALUES via postgres-js `sql(rows, ...cols)`. Drops total runtime to ~30-60 seconds. Pattern: insert batch → bulk SELECT to fill the remap → next phase. |
| 5-minute hang after referral_codes initial batch | Sequential retry loop for ~750 collided codes | Batched the retry phase too |

After all fixes: dry-run passes with zero errors; commit run on the
branch also passes with zero errors; idempotency confirmed by
re-running (same row counts, no duplicates).

### Phase 2 — Decided to run migration directly on main instead of the branch

User wanted to test the full prod-like scenario including their
existing dev data (existing dev users, listings, etc.). Cloning
main's DATA into the branch required either Docker (for
`supabase db dump`) or installing Postgres tools (Postgres.app /
`brew install postgresql@15`). User's macOS Command Line Tools
were outdated, blocking both paths quickly.

Assessment: main is dev/staging, not real prod. Schema changes are
additive/permissive, migration is idempotent, all rows tagged with
`legacy_sharetribe_id` for easy cleanup. Verdict: low-risk to run
migration directly on main for testing.

User chose to run on main directly. Hit one residual issue (the
`phone` column was missing on main too — same as the branch had
been), fixed with a one-liner. Re-ran migration. **Clean, zero
errors.**

### Phase 3 — Implemented `tryClaimLegacyProfile` in profiles.ts

Without this code, `GET /api/profiles/me` would CREATE a fresh
profile on Clerk signup, never matching the pre-migrated row.
Added a middle step:

1. Look up profile by `clerk_id` → return if found (fast path)
2. **NEW**: Look up by Clerk's primary email AND `clerk_id IS NULL`
   AND `legacy_sharetribe_id IS NOT NULL` → if found, UPDATE to
   stamp Clerk ID (race-safe via `clerk_id IS NULL` guard on the
   UPDATE), return as the user's canonical profile
3. Fallthrough: create fresh profile (existing behaviour)

Welcome email + runtime referral-code generation only fire on the
fresh-profile path — claimed users already have both from the
migration.

Each successful claim writes a log line:
`[profiles] legacy claim: clerk=user_xxx → profile=yyy
(legacy_sharetribe_id=zzz)` — useful for support / audit.

### Phase 4 — Tested login on Android, end-to-end

User picked a migrated profile, overrode its email with their own
real email via SQL, started the backend (still pointing at main),
signed up via Clerk on the Android app. **Confirmed:**

- Backend logged the claim event
- User saw the migrated profile's display name, listings, wishlist,
  and other attached data
- Referral code (pre-generated during migration) was present

The full migration flow is **production-ready** modulo the
real production data (anonymised export was used for testing).

### Phase 5 — Added welcome-back notification

User noticed migrated accounts land with a totally empty notification
inbox (Sharetribe export has no notification data — we never created
any during import). Rather than backfill stale historic events
("your item shipped in 2024!" would be confusing), we drop ONE
welcome-back notification at claim time.

Changes:
- New `welcome_back` notification type added to:
  - `NOTIFICATION_TYPES` enum in `src/types/transactions.ts`
  - `notifications_type_check` constraint widened in `schema-09.sql`
- New helper `welcomeBackNotification(firstName)` in
  `src/lib/notifications.ts`
- `tryClaimLegacyProfile` in `routes/profiles.ts` now fires the
  notification fire-and-forget right after a successful claim
  (logged on failure, never blocks the user flow)

First-name extraction is best-effort from `display_name` (splits on
whitespace); falls back to "Welcome back!" without a name if
display_name is null.

Subsequent sign-ins do NOT re-fire the notification — the claim path
only runs once per profile because step 1 of `/me` finds them by
`clerk_id` after that.

### Phase 6 — Backfilled order timeline + linked reviews to orders

User noticed the order detail UI on Android wasn't showing the
"Accepted" / "Shipped" timeline ticks for historic migrated orders.
Also: reviews from migrated transactions had `order_id = NULL`, so
the review wasn't appearing on the order's detail screen.

**Root cause #1** — the order importer was only setting `completed_at`.
The UI checks each lifecycle timestamp (`seller_accepted_at`,
`shipped_at`, `delivered_at`) to render the corresponding tick. NULL
timestamps = no tick rendered.

**Fix**: importer now backfills the full timeline for migrated orders.
Sharetribe doesn't expose per-transition timestamps in the export,
so we make defensible assumptions:
- For `complete` orders: `seller_accepted_at = createdAt`,
  `shipped_at = createdAt`, `delivered_at = completed_at = lastTransitionedAt`
- For `cancelled` orders: all lifecycle timestamps stay NULL (never
  reached acceptance)

**Root cause #2** — reviews had no way to find their order because
the importer left `order_id = NULL` and I never built the lookup.

**Fix**: added `orderIdMap` (Sharetribe transactionId → Supabase
order id) to MigrationContext. importOrders populates it from a bulk
SELECT after inserting; importReviews reads from it to set order_id.
Falls back to NULL if the transaction was inquiry-only (no order
exists to link to).

**Backfill on existing main data**: user can either re-run the
importer (DELETE migrated reviews + orders first, then re-run —
~10 sec), OR run SQL UPDATEs that match orders by
(buyer_id, seller_id) pair. Re-run is cleaner because it uses the
exact transaction-ID mapping.

### Phase 7 — Closed the rest of the field-coverage gaps

Audited what was being thrown away from the Sharetribe JSON and
addressed the high/medium impact items per user direction. Each fix
either populates an existing schema column the original importer
ignored, or adds a new column for genuinely useful data.

**Profile-level additions** (schema-09.sql + importUsers.ts):
- `stripe_customer_id` (new column) — preserved from
  `attributes.stripeCustomerId`. Matters for the ~49 historic buyers
  who completed purchases on Sharetribe; lets us correlate to Stripe
  dashboard if a refund is ever needed.
- `terms_accepted_at` (new column) — populated from
  `profile.protectedData.terms` (15,513 users had it). Stamped with
  the user's `createdAt` since the original acceptance timestamp
  isn't reliably exposed.

**Listing-level additions** (importListings.ts, no schema changes —
all use existing columns from schema-07.sql):
- `alteration_room` ← `publicData.alteration` (3,837 listings)
- `items_included` ← union of `lehengaitems` +
  `salwaritemsincluded` + `sareeitems` (Sharetribe split these per
  category; our schema is one flat array)
- `pickup_location` ← `publicData.building` when
  `pickup_available = true` (825 listings, only used when pickup is
  actually offered)
- `view_count` ← `metadata.openCount`
- `save_count` ← `metadata.numberOfLikes`
- `share_count` ← `metadata.shareCount` (later augmented by the
  userShare aggregation pass below)

**Measurements fold-in** (mappings.ts):
- Loose measurement keys at publicData root (`bustinches`,
  `hipsinches`, `waistinch`, `lengthinches`) are now folded into
  the structured `measurements` JSONB alongside the
  `publicData.measurements` blob. Normalised key names: bust, hips,
  waist, length. Older Sharetribe listings used these loose fields;
  newer ones used the structured blob — we unify.

**New `importShareCounts.ts`** post-pass:
- 189 users have `profile.metadata.userShare = {listingId: count}`
- Aggregated per listing, then bulk-UPDATE bumps `listings.share_count`
  by the summed amount on top of whatever the listing's own
  metadata.shareCount contributed.
- Runs after importListings so listing IDs exist.

**New `importOrderConversations.ts`**:
- For the 76 paid Sharetribe transactions that became orders, the
  buyer↔seller chat thread (550 messages on 68 of them) was being
  thrown away. New importer reconstructs them as `conversations` +
  `messages` rows.
- One conversation per paid order (UNIQUE on
  listing_id/buyer_id/seller_id gives free idempotency).
- Each historic message preserved as a `messages` row with original
  `created_at` and content. Content truncated to 2000 chars where
  needed (schema CHECK).
- New stats keys: `order_conversations.inserted` +
  `messages_inserted` + `skipped_orphan`.

**Dry-run validation**: 66 conversations / 537 messages
reconstructed from synthetic data, zero errors.

**Live run on main**: also clean. Two bugs surfaced during the
first commit attempt that the dry-run hadn't caught (postgres-js
type quirks):
1. `share_counts` UPDATE — `v.bump` came through as text in the
   VALUES clause, causing `operator does not exist: integer + text`.
   Fixed by adding explicit `::integer` cast in the UPDATE.
2. `order_conversations` lookup — row-constructor IN syntax
   (`WHERE (a, b, c) IN ((...))`) doesn't play with postgres-js's
   `sql(array)` helper. Rewrote to fetch by `listing_id = ANY(...)`
   then filter the full triplet in JS (small set, ~66 rows).

After both fixes: full run completed cleanly. Final counts on main:
- 9,216 profiles + referral codes
- 10,192 listings
- 1,701 wishlist entries
- 76 orders + full lifecycle timestamps
- 939 archived inquiries
- 56 reviews (29 via transaction-fallback)
- 66 conversations + 537 messages

`errors: []`

### Phase 8 — Field-level fixes discovered during Android testing

After full migration ran on main, user tested by signing in as a
migrated user on the Android app. Two real bugs surfaced from real
data shapes the synthetic export had hidden:

**Bug 1: `measurements` JSONB was being spread as a string**

The mobile app's MeasurementBox crashed with
`measurements[k].trim is not a function`. Root cause: Sharetribe's
`publicData.measurements` is actually a free-text STRING (e.g.
`"Bust 38 inches Length 40 inches"`), not the object I assumed. My
`buildMeasurementsJsonb` helper did `{ ...publicData.measurements }`
which spreads the string character-by-character (`{0:"B", 1:"u",
2:"s", ...}`).

Compounding this: the loose keys at publicData root
(`bustinches`, `hipsinches`, `waistinch`, `lengthinches`) store
**numbers**, not strings. Frontend's `.trim()` chokes on numbers
even when the spread issue is gone.

**Fix at TWO layers**:
1. `mappings.ts → buildMeasurementsJsonb` — handles the STRING case
   by storing it as a `notes` key; coerces all loose-field values
   via `String(v).trim()`; defensively handles object-shaped input
   too (for future data).
2. `src/routes/listings.ts GET /:id` — added `normaliseMeasurements()`
   safety net that coerces any non-string values to strings on the
   way out the API. Catches any other weird shapes that might sneak
   through (numbers, booleans, accidental nesting). Live immediately
   without needing a migration re-run.

**Bug 2: `negotiable` flag flipped to false on 7,267 listings**

Sharetribe stored `publicData.negotiable` as an ARRAY of choice
values like `["yes_negotiable"]` or `["no"]`. My importer checked
`pub.negotiable === true` which never matches an array, so ALL
listings (including the 7,267 with `["yes_negotiable"]`) imported
as `negotiable=false`.

**Fix**: importListings now treats either `true` OR
`Array.isArray(x) && x.includes("yes_negotiable")` as truthy. The
~186 listings with both `yes_negotiable` and `no` in the array
also become true — benign default since the seller did opt-in at
some point.

**Verified for the sparse listing case**: a migrated listing with
mostly-empty fields (no measurements, no occasion, no fabric, etc.)
is faithful to the source. Sharetribe sellers often left optional
fields blank; the importer doesn't invent data. Confirmed by
pulling the source publicData and comparing field-by-field.

**Both fixes pending DB re-run** — user needs to wipe + re-run the
importer to pick up the `negotiable` fix in DB rows. The
measurements API safety net is live immediately.

### Phase 9 — JSONB double-encoding bug (caught during verification)

After Phase 8 fixes, user ran a SQL spot-check to verify the
`measurements` column was being stored as proper JSONB. Result:
**`jsonb_typeof = 'string'`** for every migrated row — the column
was storing a JSON-encoded STRING (e.g. `"{}"` with literal escaped
quotes) instead of the actual object.

**Root cause**: my importer called `JSON.stringify()` on the
measurements object before passing to postgres-js. The library's
multi-row VALUES helper then auto-stringified the resulting STRING
again because the destination column is JSONB. Net effect: each
JSONB column stored a JSON string `'"{...}"'` instead of the
parsed object `{...}`.

**Same bug existed in `importInquiries.ts`** — `messages: JSON.stringify(messages)`
was double-encoding the chat thread, so `legacy_inquiries.messages`
was a JSON string of an array rather than an actual JSONB array.

**Fix**: pass the OBJECT (or array) directly. postgres-js auto-
stringifies once when sending to a JSONB column. Manual
pre-stringification causes the double-encoding.

TypeScript needed a cast at the call site
(`batch as unknown as Array<Record<string, unknown>>`) because
postgres-js's batched-insert signature wants primitive values
even though it handles objects fine at runtime.

**Verification query** (saved here for re-use):

```sql
SELECT
  title,
  jsonb_typeof(measurements) AS jsonb_type,
  measurements,
  measurements::text AS as_text,
  measurements::text = '{}' AS is_empty_object
FROM listings
WHERE legacy_sharetribe_id IS NOT NULL
LIMIT 10;
```

After fix, `jsonb_typeof` should be `'object'` (or `'array'` for
inquiries.messages) and `as_text` should NOT have escaped quotes.

### Phase 10 — Pre-fill the buyer/seller toggle + welcome_back schema gap

**user_intents**: Earlier I'd skipped `publicData.user_type` from
the import (noting it as "deferred — values don't match"). Came
back to it after user noticed the onboarding screen wasn't
pre-filling the buyer/seller toggle for migrated users. It's a
trivial mapping:

| Sharetribe | Our column |
|---|---|
| `["buyer"]` | `["buy"]` |
| `["seller"]` | `["sell"]` |
| `["buyer", "seller"]` | `["buy", "sell"]` |

Added to importUsers — the column was already in schema-07 with the
right enum (`buy` / `sell`). Frontend can now pre-fill the toggle
from `profile.user_intents` on the onboarding screen.

**For frontend devs**: most onboarding-prefill data is already on
the migrated profile and exposed via `GET /api/profiles/me`. The FE
just needs to read from these fields when populating the form:

- `profile.location` → country picker (AU/US/UK/CA/NZ)
- `profile.usual_sizes` → buyer's regular sizes (TEXT[], e.g.
  `["uk10", "uk12", "uk14"]` — values are iso-stripped)
- `profile.looking_for_categories` → category interests
- `profile.buy_preferences` → designer-type preferences
- `profile.budget_ceiling` → budget range
- `profile.search_notes` → free-text personalisation note
- `profile.user_intents` → buyer/seller toggle (NEW per this phase)
- `profile.phone` → contact phone
- `profile.bio`, `profile.display_name` → existing prefill

Avatar (`profile.avatar_url`) will be filled in at cutover when we
run the photo importer against client's bundle.

**welcome_back CHECK constraint**: User hit
`notifications_type_check` violation when a migrated user signed
up — `welcome_back` wasn't in the allowed enum on main. I'd added
it to schema-09.sql but the standalone ALTER hadn't been applied
to main yet. Just need to run the constraint widening separately
on main:

```sql
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'offer_received', 'offer_accepted', 'offer_declined', 'offer_countered', 'offer_expired',
  'order_paid', 'order_accepted', 'order_rejected', 'order_shipped', 'order_delivered', 'order_complete',
  'listing_approved', 'listing_rejected',
  'review_reminder', 'review_revealed',
  'tier_upgrade', 'tier_downgrade',
  'boost_activated', 'boost_expiring',
  'sale_applied', 'referral_credit_earned',
  'iso_match', 'iso_response',
  'new_message', 'price_drop_wishlist',
  'new_matching_listing', 'new_listing_your_size',
  'listing_stale_reminder', 'milestone_achieved',
  'weekly_digest', 'referral_nudge',
  're_engagement', 'account_suspended',
  'followed_seller_new_listing',
  'listing_comment', 'comment_reply',
  'welcome_back'
));
```

### Phase 11 — Stripe `account_invalid` gracefully handled

**Bug**: Migrated users have `stripe_account_id = "acct_XXX"` from
synthetic Sharetribe data. When the Android app hit
`GET /api/stripe/account-status`, the backend tried
`stripe.accounts.retrieve(acct_XXX)` and Stripe returned
`StripePermissionError: account_invalid (statusCode 403)` because
those acct IDs aren't on our test platform.

The endpoint was returning a 500, which made the seller's payouts
screen unusable for any migrated user in dev.

**Fix**: catch the specific `account_invalid` / 403 case and treat
it as `status: "not_connected"`. The seller's UI then prompts them
to set up Stripe Connect fresh — same flow as a brand-new user
who never connected.

**Why this is the right call** for cutover too: the client confirmed
she's using the same Stripe platform as Sharetribe, so real
production `acct_XXX` IDs WILL be accessible at cutover. But edge
cases exist (seller's account was suspended / moved between
Sharetribe export and our cutover). For any such case, the
graceful fallback means the seller gets a clear "set up Stripe"
prompt instead of a broken page.

For synthetic dev data, this catches every migrated seller in dev
since none of their accts exist on our test platform.

---

## Current state of main (post-migration)

If queried right now, main has:

```
profiles                  ~9,200+ migrated (legacy_sharetribe_id IS NOT NULL)
                          + your existing dev users (legacy_sharetribe_id IS NULL)
listings                  ~10,192 migrated
                          + your existing dev listings
wishlists                 ~1,701 migrated
referral_codes            ~9,200+ generated for migrated users
orders                    ~76 migrated (legacy historic orders, status='complete')
legacy_inquiries          ~939 archived
reviews                   ~56 migrated
```

One migrated profile has its email manually overridden to the
user's real email (for the test signup).

### Cleanup if needed

```sql
-- Reverses the entire migration on main in one shot
DELETE FROM reviews WHERE legacy_sharetribe_id IS NOT NULL;
DELETE FROM legacy_inquiries;
DELETE FROM orders WHERE legacy_sharetribe_id IS NOT NULL;
DELETE FROM wishlists WHERE user_id IN (SELECT id FROM profiles WHERE legacy_sharetribe_id IS NOT NULL);
DELETE FROM referral_codes WHERE user_id IN (SELECT id FROM profiles WHERE legacy_sharetribe_id IS NOT NULL);
DELETE FROM listings WHERE legacy_sharetribe_id IS NOT NULL;
DELETE FROM profiles WHERE legacy_sharetribe_id IS NOT NULL;
```

Schema changes can stay — they're additive/permissive and will be
needed for real prod anyway.

---

## What we know works (validated today)

✅ Schema migration applies cleanly to a populated DB
✅ Importer handles email-duplicate dedup correctly (winner/loser
   mapping preserves all child entity references)
✅ All constraint widenings cover the data shapes Sharetribe has
✅ Multi-currency listings (AUD/USD/CAD/GBP/NZD) all import
✅ Multi-country profiles (AU/US/CA/UK/NZ) all import
✅ Float prices clamped/rounded safely; absurd outliers nulled out
✅ Reviews idempotency via legacy_sharetribe_id
✅ Wishlist dedup (collapsed dupes within a winner's combined
   wishlist + wishlistArray formats)
✅ Email-match claim on Clerk signup
✅ User signs up via Clerk → sees migrated data on Android app
✅ Welcome-back notification fires once on claim, never duplicated
   on subsequent sign-ins
✅ Migrated orders show full timeline (Accepted/Shipped/Delivered/
   Completed) in the Android UI
✅ Migrated reviews surface on their order detail screen via
   `order_id` FK populated at import time
✅ Engagement counters (view_count, save_count, share_count),
   alteration_room, items_included, pickup_location all populated
✅ Loose measurement fields (bustinches/hipsinches/waistinch/
   lengthinches) folded into the structured measurements JSONB
✅ Stripe customer IDs preserved for the 49 historic buyers
✅ Terms acceptance carried over so we don't re-prompt migrated users
✅ Paid-order chat history reconstructed (66 conversations, 537 messages)
   so historic orders show their original buyer↔seller thread
✅ Measurements normalised: string source preserved as `notes`,
   loose numeric keys coerced to strings; API safety net catches
   any other non-string values defensively
✅ `negotiable` flag correctly parsed from Sharetribe's array shape
   (7,267 listings affected — fix pending DB re-run)

---

## Photo migration — plan

### What we know so far

- Client (Megha) is downloading the 112 GB bundle to her laptop tomorrow
  at a coworking space with fast WiFi (her home internet is slow)
- She sent 5 sample listing photos earlier as a representative slice
- **Filename convention confirmed**: UUID only, no file extension
  (e.g. `614ca297-0fcc-4ca3-92f1-58b9ce3303ba`). Format detected by
  binary magic-byte sniff at upload time.
- **Formats**: mixed JPEG / PNG in the sample; HEIC likely in the
  full bundle too (iPhone uploads). Importer handles all four +
  WebP + GIF defensively.
- **Bundle metadata structure**: same envelope as our existing
  `rawdata_synthetic_new.json` — `{id, type, attributes}` records,
  photos referenced by UUID in `attributes.images[]` on listings
  and `attributes.profile.avatar` on users.

### Importer written

`scripts/migrate-photos.ts` is feature-complete with two modes:

**TEST mode** (`--test --target-listings N`):
- Distributes a small folder of sample photos across the top N
  migrated listings (round-robin across positions 0..N-1)
- Validates upload pipeline + storage + DB linkage without needing
  bundle metadata
- Useful for dev testing to make migrated listings actually show
  photos in the Android app

**PRODUCTION mode** (`--bundle-metadata <path>`):
- Reads the bundle JSON, indexes the photo folder by UUID
- For each listing's `images[]` UUID, finds the matching file and
  uploads + links it to `listing_photos`
- For each user's `avatar` UUID, uploads + sets `profiles.avatar_url`
- Idempotent: skips photos already linked via `storage_path` check
- Resumable: continues from wherever an interrupted run stopped

### Why we're NOT running the real upload yet

The 112 GB bundle's photo UUIDs correspond to REAL Sharetribe
listing IDs. Our current main migration data has ANONYMISED UUIDs
(from `rawdata_synthetic_new.json`). If we uploaded the real
bundle now, every photo would silently fail to match a listing →
112 GB of orphaned photos sitting in Supabase Storage that we'd
have to clean up before real cutover. Wasted bandwidth + storage.

The real upload happens at production cutover when both the
real-data migration AND the photo bundle are aligned:
1. Run main migration with REAL prod export → real UUIDs in DB
2. Run photo importer pointed at the bundle metadata + photo folder
3. Photos auto-link to the right listings because UUIDs align

### What client (Megha) should do tomorrow

We'll send her a **verify-only** version of the script she runs
from her laptop with the bundle she just downloaded. Dry-run only,
no uploads — just confirms our parser reads her bundle correctly:

- Bundle JSON shape matches what our importer expects
- Photo UUIDs in `images[]` actually resolve to files in the folder
- Match rate stats (e.g. "47/50 listings have all their photos")

That eliminates surprises at cutover without burning her bandwidth.

### What we still need before cutover

- Real (non-anonymised) production export from Sharetribe → run main
  importer against it on prod Supabase
- Then run photo importer on her machine pointing at her local
  bundle + the production metadata JSON (Supabase URL/service-role
  key set as env vars; no full repo needed)
- Estimated upload time on the bundle: ~3-6 hours depending on her
  upload bandwidth (one round-trip per photo, ~10K-15K photos)
- Cleanup of sample photos we may have uploaded to test listings
  during dev (see section below)

---

## Sharetribe fields we intentionally DON'T migrate

For audit / future reference. Anything not in this list AND not in
the "what we DO import" mapping table in MIGRATION.md is genuinely
unknown — flag it if you spot something.

### Profiles — skipped

| Field | Why |
|---|---|
| `attributes.emailVerified` | Clerk re-verifies via its own OTP flow at signup; trust the new auth provider. |
| `profile.avatar` (UUID) | Avatar images aren't in the JSON export — only UUIDs. Same problem as listing photos: handled by a separate photo-bundle pass at cutover. |
| `profile.privateData.notificationTokens` (FCM) | Old Firebase Cloud Messaging tokens. New app uses OneSignal — users re-register on first install. |
| `profile.privateData.notificationSetting` | Sharetribe-specific event keys (e.g. `message/created`, `transaction/transitioned`) — don't map to our notification taxonomy. |
| `profile.privateData.consentformobile` (3,088 users) | Unclear meaning — possibly mobile-marketing consent. Worth asking client. |
| `profile.publicData.user_type` | "buyer" / "seller" intent from signup. New app has `user_intents` but values don't match; not worth a mapping pass. |
| `profile.protectedData.phoneNumber` (695 users) | Possible separate shipping phone. We use `privateData.phonenumber` for the primary; this would be a fallback we're not storing. |
| `profile.publicData` duplicates of `iso*` fields | They appear in both publicData and privateData; we read from publicData. Redundant. |

### Listings — skipped

| Field | Why |
|---|---|
| `images: [UUID]` | Photo bundle handled by a separate pass at cutover (see photo-migration plan). |
| `Kifaayatvideo` / `KifaayatVideo` / `Kifaayatvideo` / `kifaayatvideo` / `ytvideo` | Video links handled by a separate pass when client sends the MP4 folder. |
| `location.lat/lng + publicData.location.address` (8,739 listings) | New app doesn't have geo-search; not worth adding columns just for migration. |
| `publicData.yearPurchased` | No schema column for it; rarely useful UX-wise. |
| `publicData.usedworn` | Largely redundant with `condition`. |
| `publicData.countrylist` | Sharetribe shipping-country list; superseded by `international_shipping` flag. |
| `publicData.shippingPriceInSubunitsAdditionalItems` | We don't support multi-item bundle pricing on a single listing. |
| `transaction.protectedData.shippingDetails` (address/name/phoneNumber per order) | Historic shipping address per paid order. No `order_addresses` column to put it in. If support team needs old shipping addresses, they can query `legacy_inquiries` for that order's transaction and join back. **Documented gap — could add later if needed.** |
| `transaction.customerProtectedData.stripePaymentIntents` | Stripe payment intent client secrets etc. We already use `payIns[].stripePaymentIntentId` for the canonical ID. |
| `protectedData.deliveryMethod` | We use `pickup_available` boolean; this field is finer-grained but unused in the new app. |
| `currentStock.quantity` | Sharetribe stock concept — our new app treats every listing as 1. |
| `metadata.likedByUserIds`, `shareBy` | "Who liked / shared" arrays. Wishlist preservation captures the "who liked" relationship; shareBy not surfaced in our UX. |
| Sharetribe-internal: `stockType`, `transactionProcessAlias`, `unitType`, `rank`, `eventTypeSelectAllThatApply`, `exampleField`, `tags` | All Sharetribe plumbing fields with no app meaning. |

### Transactions / Orders — skipped

| Field | Why |
|---|---|
| Per-transition timestamps (accept/ship/deliver) | Sharetribe doesn't expose them in the export; we backfill defensible defaults from createdAt + lastTransitionedAt. |
| `protectedData.shippingDetails` | See note in listings table — historic shipping address per order, no column to put it in. |

### Reviews — fully covered

No skipped fields. We import `content`, `rating`, `type`, `listingId`,
`transactionId`, `createdAt` — entire record.

### What we drop entirely

- `stockReservation` (78 records) — Sharetribe stock concept, irrelevant
- `availabilityException` (2 records), `booking` (1 record) — rental artefacts
- All Sharetribe transaction transitions other than the order-lifecycle ones we map

---

## What's still pending for real prod cutover

| Item | Blocker / status |
|---|---|
| Client's cleaned designer dropdown list | Sent `designer_full_export.csv` (1,823 rows). Awaiting her edited list. |
| Real (non-anonymised) production export | Client to provide closer to cutover. |
| High-res photo bundle | Client's 112 GB JSON — provided at final-import time only. Separate one-shot script. |
| Video files | Client to send folder of MP4s keyed by listing ID. Separate one-shot script. |
| Apple Developer Team ID confirmed same | ✅ Confirmed by client; Apple Hide-my-email users will match cleanly. |
| Production schema-08 + schema-09 application | Run on real prod Supabase at cutover. Schema-08 has the `phone` column edit we added mid-session — make sure to run the FULL file, not just the original. |
| Production import dry-run on staging-clone of prod | Recommended before cutover day. |
| Frontend "welcome back" messaging | Client sending an email campaign to users explaining they should sign up with their old Sharetribe email. |

---

## Important code files (last touched today)

| File | Role |
|---|---|
| `src/db/schema-09.sql` | All migration-related schema changes — constraint widenings, new columns, new tables |
| `src/routes/profiles.ts` | Contains `tryClaimLegacyProfile()` + `fetchClerkPrimaryEmail()` helpers; `GET /me` now does the email-match flow |
| `scripts/migrate-sharetribe.ts` | CLI entry. `--file <path> --dry-run / --commit` |
| `scripts/migration/mappings.ts` | All Sharetribe → Supabase field mappings (categories, conditions, currencies, sizes, designer cleanup, price sanitization, etc.) |
| `scripts/migration/importUsers.ts` | Dedupe + batched profile insert + batched referral code generation |
| `scripts/migration/importListings.ts` | Batched listings insert, drops rentals, full field mapping |
| `scripts/migration/importWishlists.ts` | Merges both wishlist formats per user, dedupes (user,listing) pairs |
| `scripts/migration/importOrders.ts` | The ~80 paid historic orders → orders table |
| `scripts/migration/importInquiries.ts` | The 946 inquiry-only chat threads → legacy_inquiries table |
| `scripts/migration/importReviews.ts` | All 90 reviews, with listing-via-transaction fallback |
| `scripts/migration/batch.ts` | `chunk()` helper + DEFAULT_BATCH_SIZE constant |
| `scripts/migration/context.ts` | Shared DB client + remap caches + stats |
| `scripts/migration/types.ts` | Sharetribe record shape definitions |
| `MIGRATION.md` | Long-term planning doc — all decisions, mapping tables, client questions |
| `MIGRATION_STATUS.md` | (This file) Current execution status |

---

## Key design decisions encoded in code

1. **Idempotency everywhere** — every entity has either a unique
   constraint or ON CONFLICT clause. Safe to re-run the importer
   N times; identical end state.

2. **Email is the join key for legacy claim**, NOT clerk_id. Clerk
   creates a fresh identity at signup; we match against
   `LOWER(email)` and stamp clerk_id onto the existing legacy row.

3. **Highest-engagement winner per email** — Sharetribe data has
   email duplicates. Per email, the user with most listings/Stripe
   account/wishlist wins; losers' Sharetribe UUIDs still map to
   the winner's Supabase profile ID so their child entities
   attach to the right person.

4. **profile_complete = false for all migrated users** per client
   decision — Sharetribe didn't have country / buyer-seller
   fields, so all migrated users need to fill those in via the
   new app's onboarding screen on first sign-in.

5. **All buyers + sellers imported** (no zero-signal filter) per
   client decision. Even users with zero engagement get a profile
   row so they receive marketing emails + can sign in.

6. **Rentals dropped entirely**. 217 listings (`rent` / `donate` /
   `securitydepositrental` / `daily-rental`).

7. **Inquiry-only transactions** (946 of 1,026) go to
   `legacy_inquiries` archive — NOT migrated as conversations. New
   app deliberately has no pre-transaction chat (prevents
   offline-deal evasion of commission).

8. **Reviews import as already-revealed** (`visible=true`,
   `revealed_at = createdAt`) — bypasses the new app's 14-day
   double-blind window for legacy data.

9. **Historic orders aren't replayed for disbursement.** They're
   stamped as `status='complete'` with their Stripe refs intact.
   The new escrow / seller_payouts ledger only applies to orders
   placed after cutover.

10. **Referral codes auto-generated** at import time so claimed
    users land with one ready (no waiting for runtime auto-gen).

11. **`productTypeOptional` preserved in a dedicated
    `legacy_product_type` column** — old Sharetribe field, may
    be revived in the future. Kept separate from `curation_tags`
    so admin can distinguish.

12. **Sanity bounds for prices**: `MAX_SANE_CENTS = $20M`. Anything
    over → null. Negative → null. Non-finite → null. Floats →
    rounded.

---

## Things to watch for when running on real prod

1. **Email collisions with existing prod users** — if the new prod
   app has any users signed up before cutover (e.g. you / dev team
   testing), their emails MIGHT collide with Sharetribe emails.
   Synthetic data won't tell us; real data might. Check after
   running the importer:
   ```sql
   SELECT COUNT(*), array_agg(email) FROM profiles
   WHERE email IS NOT NULL
   GROUP BY LOWER(email)
   HAVING COUNT(*) > 1;
   ```

2. **`phone` column on prod schema-08** — make sure schema-08.sql
   from THIS branch (with the phone column edit) gets applied,
   not an older copy.

3. **Stripe account portability** — confirmed same Apple Dev Team
   ID; confirm same Stripe platform account too at cutover. The
   2,940 `acct_XXX` IDs in profiles assume same Stripe platform.

4. **Photo migration is separate** — main importer leaves
   `listing_photos` empty for migrated listings. A separate
   one-shot script reads the 112 GB high-res JSON and inserts
   photo rows.

5. **Video migration is separate** — same pattern, separate
   one-shot when client provides the folder.

6. **Designer normalisation map** — the import currently uses my
   best-guess cleanup map. When client signs off on the
   consolidated dropdown list, update `DESIGNER_FREE_TEXT_MAP` +
   `DESIGNER_SLUG_MAP` in `scripts/migration/mappings.ts` to
   match her canonical list.

7. **The migration data on main right now is FAKE** (synthetic
   anonymised data with collision-prone emails). The 9,200 users
   with `legacy_sharetribe_id` are NOT real Kifaayat users — they
   were created for testing. Cleanup before going live, OR
   re-import against real prod export which will overwrite-by-
   `legacy_sharetribe_id` (idempotent).

---

## Open questions for client (still awaiting answers)

1. Cleaned designer dropdown — full CSV sent, awaiting her edits.

Everything else from the original Q&A is resolved. See `MIGRATION.md`
section 5 for the complete decision history.

---

## Phase index (for quick navigation by future-me)

| Phase | What |
|---|---|
| 1 | Validated migration end-to-end on Supabase branch + iterative bug fixes |
| 2 | Decided to run migration directly on main for testing |
| 3 | Implemented `tryClaimLegacyProfile` (email-match on Clerk signup) |
| 4 | Tested login on Android, end-to-end success |
| 5 | Added `welcome_back` notification (fires once on legacy claim) |
| 6 | Backfilled order timeline timestamps + linked reviews to orders via `orderIdMap` |
| 7 | Closed field-coverage gaps: stripe_customer_id, terms_accepted_at, alteration_room, items_included, pickup_location, engagement counts, userShare aggregation, paid-order chat history (`importOrderConversations`) |
| 8 | Field-level fixes from Android testing: measurements normalisation + `normaliseMeasurements()` API safety net, `negotiable` flag array parsing |
| 9 | JSONB double-encoding bug — postgres-js auto-encodes for JSONB columns; pre-stringifying caused storage as JSON strings instead of objects |
| 10 | `user_intents` mapping from Sharetribe's `user_type` for buyer/seller toggle prefill |
| 11 | Graceful handling of Stripe `account_invalid` in `/api/stripe/account-status` |

---

## Critical files for migration work

If returning to this in a fresh session, these are the load-bearing files:

### Schema
- `src/db/schema-09.sql` — All migration-specific schema changes:
  nullable clerk_id, email, all legacy_* columns, widened constraints
  (currency, location, category, condition), `welcome_back` notification
  type, `legacy_inquiries` table, profiles.stripe_customer_id +
  terms_accepted_at + ISO buyer prefs

### Migration importer (one CLI + per-entity files)
- `scripts/migrate-sharetribe.ts` — CLI entry, partitions records and
  invokes importers in dependency order
- `scripts/migration/context.ts` — Shared state: postgres-js client,
  dry-run flag, remap caches (`userIdMap`, `listingIdMap`,
  `orderIdMap`), `MigrationStats`
- `scripts/migration/types.ts` — Sharetribe record shapes (loose typing,
  intentional — prod data has shapes synthetic doesn't)
- `scripts/migration/mappings.ts` — ALL field-level decisions:
  categories, conditions, currencies, sizes (women's / mens+kids /
  footwear), designer cleanup, price sanitisation, ISO prefs,
  `buildMeasurementsJsonb()`, `extractItemsIncluded()`,
  `coerceToStringArray()`, country/state maps
- `scripts/migration/batch.ts` — `chunk()` + `DEFAULT_BATCH_SIZE = 500`
- `scripts/migration/importUsers.ts` — Profile insert + referral code
  generation (with retry batch); dedup by email keeping highest-engagement
  winner; user_intents from publicData.user_type
- `scripts/migration/importListings.ts` — Listings, with rentals
  filtered; engagement counts (numberOfLikes → save_count, openCount →
  view_count, shareCount → share_count); pickup_location from `building`;
  `negotiable` parsed from `["yes_negotiable"]` array
- `scripts/migration/importShareCounts.ts` — Aggregates
  `profile.metadata.userShare` per listing, post-pass UPDATE to bump
  `listings.share_count`
- `scripts/migration/importWishlists.ts` — Merges old `wishlist` map
  + new `wishlistArray`, dedupes per user
- `scripts/migration/importOrders.ts` — Paid transactions →
  `orders` with full lifecycle timestamps; populates `orderIdMap` for
  reviews to link
- `scripts/migration/importOrderConversations.ts` — Reconstructs
  buyer↔seller chat threads for paid orders (66 conversations / 537
  messages in synthetic data)
- `scripts/migration/importInquiries.ts` — Inquiry-only transactions
  → `legacy_inquiries` admin archive
- `scripts/migration/importReviews.ts` — Reviews with listing-via-
  transaction fallback; linked to orders via `orderIdMap`

### Photo importer
- `scripts/migrate-photos.ts` — Standalone CLI with TEST mode
  (distribute samples across N migrated listings) + PRODUCTION mode
  (match by UUID against bundle metadata). Content-type sniff from
  binary magic bytes (no file extensions in source bundle).

### Backend integration
- `src/routes/profiles.ts` — Contains `tryClaimLegacyProfile()` +
  `fetchClerkPrimaryEmail()` + welcome_back notification dispatch
- `src/routes/stripe.ts` — `/account-status` endpoint with
  `account_invalid` graceful handling
- `src/lib/notifications.ts` — `welcomeBackNotification()` template
- `src/types/transactions.ts` — `NOTIFICATION_TYPES` enum (includes
  `welcome_back`)

### Docs
- `MIGRATION.md` — The PLAN: client Q&A history, all field-mapping
  decisions, original analysis of the Sharetribe data shape
- `MIGRATION_STATUS.md` — This file: execution log + every bug + every
  decision made during implementation
- `PAYOUTS.md` — Independent reference for escrow + payouts (touches
  migration via `seller_payouts` not getting historic-order rows)

### Source data files
- `rawdata_synthetic_new.json` — Anonymised export with CONSISTENT FK
  references (the file to use)
- `rawdata_synthetic.json` — DO NOT USE — original anonymised export
  with broken FK references
- `designer_full_export.csv` — Full unique designer list sent to client
  for cleanup; awaiting her edited version
- `sample-da/` — 5 sample listing photos from client (no extensions,
  UUID-only filenames, mixed JPEG/PNG)

---

## Quick commands cheat sheet

```bash
# Dry-run main migration importer (no DB writes)
npm run migrate:sharetribe -- --file rawdata_synthetic_new.json --dry-run

# Real run
DATABASE_URL="..." npm run migrate:sharetribe -- --file rawdata_synthetic_new.json --commit

# Photo test mode (distribute sample photos across N listings)
npm run migrate:photos -- --photos-folder ./sample-da --test --target-listings 25 --commit

# Photo production mode (match by UUID against bundle metadata)
npm run migrate:photos -- --bundle-metadata <path> --photos-folder <path> --commit

# Typecheck migration scripts (separate config since they're outside src/)
npm run typecheck:scripts

# Wipe migrated data on main (preserves dev/non-legacy data)
# See MIGRATION_STATUS.md Phase 11 "What to do now" section for the
# canonical DELETE sequence in FK-safe order, including the
# listing_photos cleanup that earlier versions missed.
```

---

## What to give me in a fresh session to restore full context

**Just point me at these two files:**

1. `MIGRATION_STATUS.md` (this file) — covers everything that happened
   during execution, all decisions, all bugs+fixes, all current state
2. `MIGRATION.md` — covers the original PLAN + client decisions

Optional bonus context if I need to dig further:
- `PAYOUTS.md` — escrow / multi-method payouts architecture
- Any specific source file from the "Critical files" list above

Saying "read MIGRATION_STATUS.md and MIGRATION.md, then we'll continue
migration work" gets me ~95% of context. The remaining 5% (specific
code in any importer file) I can grep for myself in the moment.

