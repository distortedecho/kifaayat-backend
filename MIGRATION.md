# Sharetribe → Supabase Migration Plan

Status doc capturing the analysis of the client's anonymised data export and
the migration approach. Read this before touching anything migration-related.

Source data:
- `rawdata_synthetic.json` (50 MB) — initial anonymised export. Useful for
  shape/volume work but had **broken FK references** (top-level UUIDs were
  regenerated, foreign-key fields weren't). DO NOT USE for relationship work.
- `rawdata_synthetic_new.json` (49 MB) — re-anonymised export with consistent
  UUID mapping. **This is the file to use for all FK-dependent analysis and
  importer dry-runs.**

Last updated: see `git log`.

---

## TL;DR for future-me reading this after compaction

We're migrating the old Kifaayat (Sharetribe-based) into the new Supabase
backend. Client sent an anonymised JSON export to plan the migration off.
The current export has **broken FK references** (top-level UUIDs were
regenerated, foreign-key fields were not) — usable for shape/volumes but
NOT for actually linking users to their listings/transactions. We've asked
the client to re-anonymise with consistent UUID mapping AND to answer ~15
substantive questions about the data in parallel.

When both come back we can write the importer end-to-end and dry-run it
against the linked synthetic file before running on production data at
cutover.

---

## 1. What's in the export

```
user                  18,454   (~11,312 with engagement signals, 7,142 dead accounts)
listing               10,409   (3,683 published / 715 pending / 2,371 draft / 3,640 closed)
transaction            1,026   (946 pure inquiry chats / ~80 actual paid orders)
review                    90
stockReservation          78   (rental artefact — drop)
availabilityException      2   (rental artefact — drop)
booking                    1   (rental artefact — drop)
```

### User engagement breakdown

| Bucket | Count | Definition |
|---|---|---|
| Real users (any signal) | 11,312 | Has ≥1 of: user_type set, Stripe account/customer, wishlist, FCM token, phone, ISO prefs, userShare |
| Zero-signal users | 7,142 | None of the above. 4,244 verified email but did nothing else. 28 banned. |
| **Of which actually transacted** | **49** | Has `stripeCustomerId` (Sharetribe creates this on first purchase) |
| Sellers who started Stripe Connect | 2,940 | Has `stripeAccountId` |
| Active in mobile app | 5,805 | Has ≥1 FCM token |

### Listing breakdown

- Categories (Sharetribe `categoryLevel2`): salwarsuits 3,505 / lehengas 3,397 / sarees 884 / otherclothing 697 / indowestern 621 / kids 272 / menswear 136 / blouses 97 / footwear (combined) 82 / jewellery (combined) 576 / accessories (combined) 103
- listingType: sell 10,180 / rent 193 / donate 18 / securitydepositrental 5 / daily-rental 1
- ~3,875 listings have structured `measurements` JSONB
- ~1,806 listings have a legacy numeric `extId` (pre-Sharetribe)

### Transactions breakdown

- 946 of 1,026 are `transition/inquire` — chat threads, no payment
- ~80 are actual orders (mostly `expire-review-period` or `review-2-by-provider` after completion)
- `payIns[]` carries the Stripe charge/PI ID; `payOuts[]` carries the transfer/payout/balance-tx IDs

---

## 2. FK references — FIXED in `rawdata_synthetic_new.json`

The original `rawdata_synthetic.json` had broken FK references — top-level
record UUIDs were regenerated, but the fields pointing AT those records
(author, customerId, providerId, listingId, image UUIDs, wishlist keys)
were left as the original Sharetribe UUIDs. This made the file useless for
relationship traversal.

The client re-ran the anonymiser with consistent UUID mapping, producing
`rawdata_synthetic_new.json`. Validation:

| Relationship | Total refs | Resolves | Orphans |
|---|---|---|---|
| listing.author → user | 5,494 | 5,494 | **0** |
| transaction.customerId → user | 338 | 330 | 8 (2%) |
| transaction.providerId → user | 627 | 608 | 19 (3%) |
| transaction.listingId → listing | 1,026 | 989 | 37 (4%) |
| wishlist keys → listing | 1,732 | 1,701 | 31 (2%) |
| wishlistArray → listing | 1,391 | 1,370 | 21 (2%) |
| userShare keys → listing | 234 | 231 | 3 (1%) |
| message.sender → user | 3,559 | 3,470 | 89 (3%) |
| review.transactionId → transaction | 37 | 36 | 1 |
| **review.listingId → listing** | 90 | 38 | **52 (58%)** |

1–4% orphan rates are noise (hard-deleted records, export filters).
Importer skips orphaned refs and logs them.

The review→listing 58% orphan rate is an anomaly. Workaround: when
`review.listingId` doesn't resolve, fall back to
`review.transactionId → transaction.listingId` (which has 96% resolution).
Worst case: import the review with buyer/seller from the transaction and
leave `listing_id` null.

### Real activity counts unlocked by the consistent-FK file

| Stat | Count |
|---|---|
| Sellers with ≥1 published listing | 1,844 (of 5,058 marked as sellers) |
| Buyers who actually completed a purchase | 55 |
| Closed listings tied to a real paid transaction | 43 |
| Closed listings just delisted by seller (never sold) | 3,597 |

---

## 2b. Original broken-FK issue (historical, for reference)

The client's `anonymise_json.py` regenerates the top-level `id` of every
record (via the `consistent("uuid", ...)` cache), but the reference fields
that POINT at those records (`author` on listings, `customerId`/`providerId`
on transactions, image UUIDs, wishlist keys) were never added to the
`FIELDS` dict — so they were left as the original Sharetribe UUIDs.

**Result**: in the current file you cannot trace any record to its
referenced entity. `appeared_as_customer_in_tx: 0` proves this.

**Counts that ARE reliable** (record-internal fields, no FK needed):
record totals per entity, listing state/category distribution, transaction
`lastTransition` distribution, user activity-signal counts, rental count,
Stripe account count, FCM token count, banned count, designer-field junk
distribution, kifaayatonly/productTypeOptional/tags counts.

**Counts that need the re-anonymised file**: anything involving
user↔listing↔transaction↔wishlist relationships (active sellers with ≥1
published listing, orphan listings, wishlist contents, closed listings
tied to a real transaction, duplicate accounts on same email).

### Fix to ask the client to apply

Add these to `FIELDS` in `anonymise_json.py` as `"uuid"` so they go through
the consistency cache:

```python
"attributes.author":             "uuid",   # listing -> user
"attributes.customerId":         "uuid",   # transaction -> user
"attributes.providerId":         "uuid",   # transaction -> user
"attributes.listingId":          "uuid",   # transaction / review -> listing
"attributes.bookingId":          "uuid",
"attributes.stockReservationId": "uuid",
"attributes.messages[].id":      "uuid",
"attributes.messages[].sender":  "uuid",
"attributes.payIns[].id":        "uuid",
"attributes.payOuts[].id":       "uuid",
"attributes.images[]":           "uuid",   # whole array element is a uuid
```

Plus special handling for **object-keys-as-listing-IDs** (the current path
walker only descends into values, not keys):

```
attributes.profile.metadata.wishlist        # {listingId: true, ...}
attributes.profile.metadata.wishlistArray   # [listingId, listingId, ...]
attributes.profile.metadata.userShare       # {listingId: count, ...}
```

These leaves need key-by-key remapping using the same `consistent("uuid", ...)`
cache, so a wishlist entry references the same fake UUID as the listing's
top-level id.

---

## 3. Entity-by-entity migration mapping

### users → `profiles`

Sharetribe shape:

```js
{
  id, attributes: {
    createdAt, banned, email, emailVerified,
    stripeAccountId, stripeCustomerId,
    profile: {
      displayName, firstName, lastName, bio, avatar (uuid only),
      privateData: { phonenumber (int!), notificationTokens [FCM], notificationSetting },
      protectedData: {},
      publicData: {
        user_type: ["seller","buyer"], user_country: "australia_user",
        isotype, isosize, isocountry, isobudget, isopersonalised  // buyer "looking-for"
      },
      metadata: {
        extId, isAdmin, stripeConnectVerified,
        wishlist: { listingId: true, ... },     // OLD format (403 users)
        wishlistArray: [ ... ],                  // NEW format (340 users)
        userShare: { listingId: count, ... }     // 189 users — meaning TBC
      }
    }
  }
}
```

Mapping:

| Sharetribe field | Our `profiles` column | Notes |
|---|---|---|
| `email` | (need to add column or store legacy lookup) | Clerk currently owns email — see auth strategy below |
| `profile.displayName` | `display_name` | Direct |
| `profile.firstName + lastName` | Used only if displayName empty | Combine on fallback |
| `profile.bio` | `bio` | Direct |
| `attributes.banned` | `is_banned` | Direct |
| `profile.publicData.user_country` | `location` | Map `australia_user → AU`, etc. |
| `profile.privateData.phonenumber` (int) | `phone` (text) | Cast int→string, prepend leading `0` for AU mobile |
| `attributes.stripeAccountId` | `stripe_account_id` | Only portable if same Stripe platform |
| `stripeAccountId IS NOT NULL` | `stripe_onboarding_complete = true` | Approximation; better signal: `metadata.stripeConnectVerified` |
| `profile.metadata.isAdmin` | `is_admin` | 2 admins total |
| `profile.publicData.isotype` etc | New cols: `looking_for_categories`, `usual_sizes`, `buy_preferences`, `budget_ceiling`, `search_notes` | Already drafted in schema-07.sql comments lines 881–885 |
| `profile.metadata.wishlist` + `wishlistArray` | `wishlists` table rows | Merge both formats |
| `attributes.createdAt` | `created_at` | Preserve original signup date |
| `id` (Sharetribe UUID) | `legacy_sharetribe_id` | New column — enables email-match lookup at Clerk signup |
| `profile.metadata.extId` | `legacy_numeric_id` | Pre-Sharetribe sequential ID, useful for support |

Drop entirely:
- `profile.privateData.notificationTokens` (FCM, we use OneSignal)
- `profile.privateData.notificationSetting` (Sharetribe-specific event keys)
- `attributes.availabilityPlan` (rental)
- 7,142 zero-signal users (keep optional email-only lookup table — see below)

### listings → `listings`

| Sharetribe | Our column |
|---|---|
| `title` | `title` |
| `state` | `status` (`draft`/`pendingApproval` → `pending_review`, `published` → `active`, `closed` → `sold` or `archived` based on transaction link) |
| `author` | `seller_id` (after Sharetribe→Supabase user-id remap) |
| `price.amount` × 100 | `price_amount` (Sharetribe stores dollars as float; we store cents) |
| `price.currency` | `price_currency` |
| `publicData.condition` | `condition` |
| `publicData.negotiable` | `negotiable` |
| `publicData.fabric` | `fabric_types` (array in our schema) |
| `publicData.colour` | `colors` |
| `publicData.Occasion` | `occasion_tags` |
| `publicData.dryCleaningStatus` | `dry_cleaning_status` |
| `publicData.designer` (cleaned) | `designer_name` |
| `publicData.country` | `country_of_origin` |
| `publicData.measurements` | `measurements` (JSONB) |
| `publicData.shippingPriceInSubunitsOneItem` | `shipping_cost_amount` |
| `publicData.shippingEnabled === false && pickupEnabled` | `pickup_available = true` |
| `publicData.estimate{Women,Mens,MenS}SizeAu` (coalesce all 3) | `estimated_size` + `size_type` |
| `publicData.footwearSizeAu` | `estimated_size` + `size_type = footwear` |
| `publicData.estimateOriginalPurchasePriceAud` × 100 | `original_price_amount` |
| `location.lat/lng + publicData.location.address` | New columns (not in current schema) — TBD |
| `images[]` | `listing_photos` rows — **need URLs from client (see Q1)** |
| `id` | `legacy_sharetribe_id` |
| `metadata.extId` | `legacy_numeric_id` |
| `createdAt` | `created_at` |

#### Sharetribe categoryLevel2 → our LISTING_CATEGORIES

| Sharetribe | Our category |
|---|---|
| `salwarsuits` | Salwar Kameez |
| `lehengas` | Lehenga |
| `sarees` | Saree |
| `otherclothing` | Other |
| `indowestern` | Indo-Western |
| `kids` | Kidswear |
| `menswear` | Menswear |
| `blouses` | Blouse |
| `womensfootwear` / `mensfootwear` / `otherfootwear` | Footwear |
| `necklace` / `earrings` / `bangles` / `earringtika` / `otherjewellery` / `jewelleryother` | Jewellery |
| `bags` / `belts` / `otheraccessories` | Accessories |

Drop / coerce:
- 217 rental-type listings (`rent`/`donate`/`securitydepositrental`/`daily-rental`) — pending client decision (Q5)
- `availabilityPlan` (rental artefact)
- Designer-field junk values (empty / `N/A` / `NA` / `None` / `unknown` / trailing-space variants) → null on import

### transactions → `orders` (paid) + `legacy_inquiries` (inquiry-only)

Two import paths:

**Inquiry-only (946)** → **NEW table `legacy_inquiries`** (NOT conversations).
Client explicitly does not want pre-transaction chat re-introduced — the
new app only allows messaging post-order to prevent offline-deal evasion.
Inquiry threads are preserved as an admin-only archive accessed via
helpdesk lookup, not surfaced in user UI.

Suggested table:

```sql
CREATE TABLE legacy_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_sharetribe_id TEXT UNIQUE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  buyer_email TEXT,
  seller_email TEXT,
  buyer_legacy_id TEXT,
  seller_legacy_id TEXT,
  messages JSONB,  -- array of {id, createdAt, content, sender_email}
  last_transitioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
);
```

Admin-only RLS. Helpdesk can query by email or listing.

**Real orders (~80)** → `orders` rows:

| Sharetribe | Our column |
|---|---|
| `customerId` | `buyer_id` |
| `providerId` | `seller_id` |
| `listingId` | `listing_id` |
| `payinTotal.amount × 100` | `amount` |
| `payoutTotal.amount × 100` | `seller_payout` |
| `payinTotal − payoutTotal × 100` | `commission_amount` |
| `lineItems[].percentage` (provider-commission line) | `commission_rate` |
| `payIns[0].stripePaymentIntentId` | `stripe_payment_intent_id` |
| `lastTransition` | `status` (`complete`/`expire-review-period`/`auto-complete` → `complete`, `cancel*` → `cancelled`) |
| `createdAt` | `created_at` |
| `lastTransitionedAt` | `updated_at` |
| `id` | `legacy_sharetribe_id` |

Note: do NOT replay disbursement for historic orders. They've already
settled on Stripe — these are pure historical records. The new
`seller_payouts` ledger should NOT get rows for migrated historic orders
(or if we do create rows, mark them `status='paid'` with the historic
Stripe transfer ID for audit only).

### reviews → `reviews`

Direct map. All 90 are `state: public` (already public on Sharetribe), so
import as `revealed_at = createdAt` — bypass the new app's 14-day
double-blind window for legacy reviews.

| Sharetribe | Our column |
|---|---|
| `attributes.type: ofProvider` | `reviewer_role: buyer` (buyer reviewing seller) |
| `attributes.type: ofCustomer` | `reviewer_role: seller` (seller reviewing buyer) |
| `rating` | `rating` |
| `content` | `comment` |
| `transactionId` | `order_id` |
| `listingId` | (lookup from order) |
| `createdAt` | `created_at` AND `revealed_at` |

Buyer/seller IDs come from the linked transaction's customerId/providerId.

### wishlists → `wishlists`

Two source formats to merge:
- `metadata.wishlist: { listingId: true, ... }` — 403 users
- `metadata.wishlistArray: [ listingId, ... ]` — 340 users

Both produce one `wishlists` row per (user_id, listing_id) pair. No
price-at-save baseline (Sharetribe didn't track it) — leave that column
null for legacy entries; the price-drop banner will only work for
NEW wishlist saves post-migration.

---

## 4. Auth strategy (recommendation)

These users have no Clerk identity yet. The chosen approach:

**Pre-create profiles, match by email on Clerk signup**

1. Migrate every "active" user (~11,312) into `profiles` with:
   - `clerk_id = NULL` (make this column nullable)
   - `legacy_sharetribe_id = <original UUID>`
   - `email` stored (need to add column)
2. Add a Clerk webhook (or sign-in hook) that on first signup:
   - Looks up `profiles WHERE email = <clerk email> AND clerk_id IS NULL`
   - If found, stamps `clerk_id` on the existing row → user instantly has
     their old listings/wishlist/reviews
   - If not found, creates a fresh profile as today
3. Zero-signal users (7,142): keep a slim `legacy_users_lookup` table
   (`email`, `sharetribe_id`, `created_at`) for "we knew you before"
   matching, without creating a profile row. Pending client sign-off
   (Q4).

**Schema changes needed**:
- `profiles.clerk_id` → NULLABLE (currently NOT NULL), unique-when-not-null
- `profiles.email` → new column, indexed
- `profiles.legacy_sharetribe_id` → new column, unique
- `profiles.legacy_numeric_id` → new column, indexed
- New table `legacy_users_lookup` (email PK, sharetribe_id, created_at)

---

## 5. Decisions made + open client questions

### ✅ Decided (no need to revisit)

- **Cutover strategy** → **HARD cutover**. New app replaces current app same
  day. No parallel operation, no in-flight orders to handle. No delta-sync
  logic needed in the importer.
- **In-flight orders at cutover** → not applicable (none pending at switchover).
- **Listings active during cutover** → not applicable (hard cutover).
- **Multi-market** → AU-only in production today. Skip multi-currency
  handling for legacy import; new app handles other markets going forward.
- **Email policy / Privacy** → users will be told to sign up via Clerk on
  the new app; we match on email and patch their Sharetribe data in
  automatically. No separate email-consent flow needed beyond standard
  signup.
- **Test / staff accounts** → none to exclude.
- **Trust tier seeding** → SKIP. Trust tier system exists in services but
  isn't actively used in the new app. Don't bother seeding from Sharetribe
  history.
- **Photos** → confirmed option (c): re-host on Supabase Storage. Client
  has a 112 GB JSON with high-res photos on her machine. She'll provide it
  at FINAL import time (high-speed internet needed). For dry-run dev,
  importer will leave photos as `null` and fill later.
- **Stripe platform account** → SAME business account as today. The 2,940
  existing `acct_XXX` IDs are directly portable. Sellers do NOT need to
  re-onboard. The synthetic file's IDs are anonymised; real IDs work as-is.
- **Auth strategy** → confirmed: pre-create profiles with
  `legacy_sharetribe_id`, match by email when user signs up via Clerk,
  stamp the Clerk ID onto the existing row. (Requires `profiles.clerk_id`
  to become nullable.)
- **Rental listings (217)** → DROP entirely. (Already in `closed` state
  per client.)
- **Inquiry-only transactions (946)** → DO NOT migrate as chat
  conversations. Reason: new app deliberately has no pre-transaction
  private messaging (prevents offline-deal evasion of commission).
  Instead, store in a new `legacy_inquiries` archive table accessible only
  to admin/helpdesk for support lookups.
- **Closed listings (3,640)** → import ALL closed listings (no subsetting).
- **Bans (112 users)** → CARRY FORWARD. These are professional spammers
  flagged on Sharetribe; do not reset on new platform.
- **`metadata.userShare`** → it's the count of how many times each listing
  was SHARED by the user (`{listingId: shareCount}`). Store as
  `legacy_share_counts` JSONB on the profile, or aggregate into a per-listing
  share-count column. (Our schema already has `share_count` on listings —
  can sum these into that column.)
- **`publicData.kifaayatonly`** → editorial / curation tags like
  `bridal-edit`, `popular_brands`, `designer-edit`, `top-picks`,
  `petite`, `plussize`, `maternity`. Note: 1,071 of 1,215 listings
  have it but as an EMPTY array — only ~144 have real tags. Maps to
  our existing `curation_tags TEXT[]` column.
- **`publicData.productTypeOptional`** → OLD field no longer surfaced
  in the listing form (replaced by separate `Occasion` field). Per
  client Q13: preserve in a dedicated `listings.legacy_product_type`
  column so the data isn't lost — they may want to revive the field
  later. Do NOT merge with kifaayatonly (keeping them separate lets
  admin tell at a glance which came from where).
- **`publicData.tags`** → old field no longer used. DROP.
- **`profile.metadata.extId`** → preserve in new `legacy_numeric_id`
  column on profiles AND listings for support continuity.
- **Designer field cleanup** → normalise junk to null on import, build
  a consolidated dropdown from union of `designer` (free text) +
  `designerID` (slug). See doc section 10 for the proposed list — pending
  client review.
- **Size field clarification** → confirmed:
  - `estimateWomenSSizeAu` → women's clothing, numeric AU sizes
  - `estimateMensSizeAu` AND `estimateMenSSizeAu` (typo) → menswear AND
    kidswear, lettered sizes. **Merge both into one column on import.**
  - `footwearSizeAu` → footwear, numeric. Independent.
- **Notification tokens (5,805 FCM tokens)** → DROP. New app uses OneSignal;
  users re-register on first sign-in.
- **Buyer ISO preferences (726 users)** → STORE in `profiles` columns
  (`looking_for_categories`, `usual_sizes`, `buy_preferences`,
  `budget_ceiling`, `search_notes`). Do NOT auto-create ISO posts. Just
  preserve for future personalisation.
- **Wishlist overlap** → 340 users have BOTH formats, 63 have ONLY the
  old map format, 0 have ONLY the new array. Total distinct = 403. The
  importer must dedupe listing IDs across the two formats per user.
- **Zero-signal users (~4,672)** → IMPORT AS FULL PROFILES per client.
  She wants every user's country / role selection preserved so they
  don't have to re-enter on signup, and the marketing list stays whole.
  Drop the originally-planned `legacy_users_lookup` table entirely.
- **Historic reviews** → confirmed: import with `revealed_at = createdAt`.
  No 14-day double-blind window for legacy data.
- **FCM tokens** → confirmed drop. Users WILL miss push notifications on
  the new app until they re-install and re-grant permissions, but
  critical events (order_paid for sellers) also fire via email and
  in-app inbox so nothing gets fully lost. This would happen regardless
  of the migration approach — it's a side effect of switching from FCM
  to OneSignal as the push provider.
- **Size fields** → confirmed: 3 distinct categories (women's, mens+kids,
  footwear). `estimateMenSSizeAu` (capital-S typo) and `estimateMensSizeAu`
  are stored identically and represent the same field — likely an
  artefact of the old Sharetribe → new Sharetribe migration the client
  did 1.5-2 years ago. Importer merges both.
- **Referral codes** → AUTO-GENERATE one per migrated user at import
  time. Same `BASE-K####` format as the runtime generator (lib/profiles).
  When the user signs up via Clerk and we match-by-email, their code is
  already there waiting; they can immediately refer friends.
- **Profile complete flag** → set FALSE for all migrated users. Per
  client: most won't have country/buyer-seller filled (those fields
  didn't exist on Sharetribe), so the new app's onboarding screen should
  surface to capture missing info on first sign-in.
- **Email verified** → don't bother carrying forward. Clerk re-verifies
  via its own OTP / email flow at signup regardless of what Sharetribe
  thought. Stored email_verified flag is informational only.
- **Video (`Kifaayatvideo`, 223 listings)** → SKIP in main importer.
  Client will provide a folder of video files keyed by listing ID
  separately; a second-pass migration after the main import will
  upload these to storage and write `video_url` onto the relevant
  listings. No code path needed in the v1 importer.
- **Seller follows** → CLEAN SLATE. Old Sharetribe versions had a
  follow concept but it was so long ago, client wants the new app's
  follow system to start fresh. Nothing to migrate.
- **`createdAt` preservation** → CONFIRMED. Every entity (profile,
  listing, order, review) keeps its original Sharetribe `createdAt`.
  Member-since dates + listing post dates carry through.

### Still awaiting client answers

1. **Designer dropdown — full cleanup pass**: client requested the FULL
   unique designer list (not just the top 60) because she wants to
   manually clean spelling errors / merge near-duplicates / cull junk.
   Full CSV exported to `designer_full_export.csv` (1,823 rows: 27
   dropdown slugs + 1,759 free-text values, all sorted by count).
   Sent to her; pending her cleaned-up version which becomes both the
   importer's normalisation map AND the new-listings dropdown.

All FK-dependent verification (orphan listings, real seller counts, etc.)
still pending the re-anonymised export with consistent UUID mapping.

---

## 10. Consolidated designer dropdown (pending client review)

Merged from `designerID` (slug dropdown, 646 listings) + `designer`
(free text, 3,299 listings). Junk values normalised to null on import.

**Specific designers** (from union of both fields, ≥6 occurrences in
free text or any presence in dropdown):

| Designer name | Occurrences |
|---|---|
| Arivaah | 69 |
| Sana Safinaz | ~33 (23 + 10 typos) |
| Maria B | 36 |
| Kalki Fashion | ~26 (15 + 11) |
| Lashkaraa | ~22 (14 + 8) |
| Agha Noor | 22 |
| Seema Gujral | 18 |
| Limelight | 17 |
| Royal Threads | 15 |
| Asim Jofa | 12 |
| Meena Bazaar | 11 |
| Sabyasachi | 14 |
| Anita Dongre | 5 |
| Manish Malhotra | 1 |
| Khaadi | 10 |
| Faiza Saqlain | 10 |
| Baroque | 9 |
| Frontier Raas | 8 |
| Biba | 8 |
| Lulusar | 7 |
| Indya | 7 |
| W (Indian brand) | 7 |
| Saira Shakira | 6 |
| Sapphire | 6 |
| Suffuse by Sana Yasir | 6 |
| Papa Don't Preach | dropdown |
| Sobia Nazir | dropdown |
| Mohsin Naveed Ranjha | dropdown |
| Gaurav Gupta | dropdown |
| Mahima Mahajan | dropdown |
| Dolly J | dropdown |
| Anushree Reddy | dropdown |
| Tarun Tahiliani | dropdown |
| Ritu Kumar | dropdown |
| Payal Singhal | dropdown |
| Masaba Gupta | dropdown |
| Abhinav Mishra | dropdown |
| Vvani | dropdown |
| Hussain Rehar | dropdown |

**Catch-all entries (also offered in dropdown):**
- Other
- Custom Made
- No designer / Non-designer

**Values normalised to null on import** (i.e. designer field cleared):
empty, `n/a`, `na`, `none`, `unknown`, `no`, `yes`, `test`, `home`,
`india`, `indian`, `pakistan`, `pakistani`, `ethnic`, `no name`, `nil`,
`-`, `not sure`, `not known`, `local`, `boutique`, `self`, `designer`,
`customised` / `customized` / `custom` / `custome made`,
`pakistani designer`, `indian designer`, `j.`, `ssdesigners`,
`no designer`, `non designer`, `not designer`

Client owns the final dropdown — she'll review, fix spellings, add /
remove names. Once she signs off, this list becomes:
1. The cleanup mapping used by the importer (free-text → canonical name)
2. The dropdown options in the new app for fresh listings

---

## 6. Implementation order (when answers + re-anonymised file land)

1. **Schema additions** (schema-09.sql):
   - `profiles.clerk_id` → nullable, unique-when-not-null (currently NOT NULL)
   - `profiles.email` → new column, indexed, used for Clerk-match
   - `profiles.legacy_sharetribe_id` → new column, unique
   - `profiles.legacy_numeric_id` → new column, indexed (pre-Sharetribe IDs)
   - `profiles.looking_for_categories`, `usual_sizes`, `buy_preferences`,
     `budget_ceiling`, `search_notes` → buyer ISO preferences (drafted
     in schema-07.sql comments lines 881-885)
   - `listings.legacy_sharetribe_id`, `listings.legacy_numeric_id`
   - `orders.legacy_sharetribe_id`
   - `legacy_users_lookup` table (for the 7,142 zero-signal users —
     pending client confirm on Q1)
   - `legacy_inquiries` table (for the 946 inquiry-only transactions —
     admin-only RLS, see section 3)
2. **Importer scaffold** in `scripts/migrate-sharetribe.ts`:
   - Stream-parse the JSON (50 MB is small enough to load, but design
     for streaming so we can swap in the eventual prod export at
     hundreds of MB)
   - One pass to build the user-id remap (Sharetribe UUID → new
     Supabase UUID, plus email → Supabase ID)
   - Second pass to insert users, then listings, then wishlists, then
     transactions/orders/conversations, then reviews
   - All inserts idempotent on `legacy_sharetribe_id` so re-runs are
     safe
   - **One-shot importer** (no delta-sync needed — confirmed hard
     cutover). Simplifies design significantly.
3. **Clerk sign-in hook**: on first sign-in, match by email and stamp
   `clerk_id` on the existing profile if found.
4. **Photo migration**: depends on client answer to Q1. If re-hosting,
   spawn a worker that downloads each Sharetribe image and re-uploads
   to Supabase Storage, writing the new URL into `listing_photos`.
5. **Dry-run on the re-anonymised file**: full importer end-to-end on
   the synthetic linked data. Validate row counts, FK integrity, no
   orphans. Spot edge cases.
6. **Production cutover**: pull a fresh production export with real
   intact UUIDs, run the importer against it, do one more validation
   pass, flip DNS / launch new app.

---

## 7. Things that WON'T be migrated

- Push notification tokens (FCM → OneSignal re-registration)
- Sharetribe-specific notification settings
- `availabilityPlan`, `stockReservation`, `availabilityException`, `booking`
  (rental artefacts)
- Sharetribe transaction transitions other than the order lifecycle ones
- Listings in `state: closed` with no buyer, if client picks the subset
  option in Q9
- Zero-signal users (~7,142), if client picks "drop" in Q4
- The 3,640 closed listings (or a subset of them) — TBC
- Bans, if client wants to wipe slate (Q10)

---

## 8. What stays unchanged

- The new app's full UX, schema, escrow architecture, payout flow — none
  of this is affected by the migration. The importer just populates the
  same tables the live app already writes to.
- Stripe Connect flow for sellers — historic accounts are pre-stamped,
  new sellers go through normal onboarding.
- All notifications, voucher, referral, comment, ISO, review systems —
  these are unaffected; the importer just adds rows the running app can
  read.

---

## 9. Files referenced by this doc

- `rawdata_synthetic.json` — current anonymised export (broken FKs)
- `anonymise_json.py` — client's anonymiser script (needs FK fields added)
- `Kifaayat_3.0_Schema_Migration.docx`, `Kifaayat_3.0_tables.pdf`,
  `Kifaayat_3.0_tables.txt`, `Kifaayat_3.pdf`, `Kifaayat_3.txt` —
  client's schema docs from earlier discussions
- `src/db/schema-07.sql` lines 875-889 — placeholder column list for
  Sharetribe migration (legacy_sharetribe_id, deleted, bio,
  phone_number, looking_for_categories, budget_ceiling,
  buy_preferences, usual_sizes, search_notes, etc)
- `PAYOUTS.md` — escrow / multi-method payouts (independent of migration)
