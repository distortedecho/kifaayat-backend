# Backend TODO

Track work that's planned but not yet built. When picking something up, move it to "In Progress" or remove on completion.

---

## Pending

### Top Picks (admin-curated)

**Status:** not started
**Effort:** ~1 day
**Why:** Client asked for a "Top Picks for you" section on the home feed. We don't have any recommendation/curation surfacing today — `curation_tags` column exists on listings with `"Top Picks"` as a valid value but nothing reads or writes it.

**Scope (Option A — admin-curated, same picks for everyone):**

- [ ] `POST /api/admin/listings/:id/curation` — admin endpoint to set/unset `curation_tags` on a listing (validate against `CURATION_TAGS` enum)
- [ ] `GET /api/feed/top-picks?limit=20&cursor=...` — public endpoint returning listings where `'Top Picks' = ANY(curation_tags)`, ordered by most recently tagged, paginated
- [ ] Add `top_picks` section to `GET /api/feed/` home response (between `new_arrivals` and `trending` — order TBD with frontend)
- [ ] Include `estimated_size`, `size_type`, `designer_name` on each card (match the other list endpoints)
- [ ] Index on `curation_tags` for fast filtering (`CREATE INDEX IF NOT EXISTS idx_listings_curation_tags ON listings USING GIN(curation_tags);` — already in schema-07.sql, verify it's actually created in Supabase)

**Not in scope (deferred):**
- Personalized "For You" based on user behavior — revisit once we have enough usage data to learn from. With <100 active users, behavior-based recommendations are noise.
- Trending-based ranking (sales velocity, view counts, save rates). Current `/api/feed/` trending is just most-recent listings — also worth real ranking later, separate task.

**Open question:** does the client want a single global "Top Picks" list curated by admin, or per-category top picks? Default to global until they ask.

---

## In Progress

_(nothing right now)_

---

### DB constraint cleanup — currency + location (CA/UK markets)

**Status:** not started — deferred
**Effort:** 5 min (3 ALTERs in Supabase SQL editor)
**Why:** Five CHECK constraints on the live DB still use the original AU/US/NZ market set and reject `CAD`, `GBP`, `'CA'`, `'UK'`. Any CA or UK seller's first transaction (profile setup, listing creation, offer, or order) will blow up with a constraint violation. Code already supports all 5 markets; DB just needs to catch up.

**Affected:**
- `profiles.location` — missing `'CA'`, `'UK'`
- `profiles.currency` — missing `'CAD'`, `'GBP'`
- `listings.price_currency` — missing `'CAD'`, `'GBP'`
- `offers.currency` — missing `'CAD'`, `'GBP'`
- `orders.currency` — missing `'CAD'`, `'GBP'`

**Diagnostic** (run first to confirm the live DB hasn't already been manually altered):
```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid::regclass::text IN ('profiles', 'listings', 'offers', 'orders')
  AND pg_get_constraintdef(oid) ~ '(AUD|AU)';
```

**Migration** (only on stale ones):
```sql
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_location_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_location_check CHECK (location IN ('AU','US','NZ','CA','UK'));

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_currency_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_currency_check CHECK (currency IN ('AUD','USD','NZD','CAD','GBP'));

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_price_currency_check;
ALTER TABLE listings ADD CONSTRAINT listings_price_currency_check CHECK (price_currency IN ('AUD','USD','NZD','CAD','GBP'));

ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_currency_check;
ALTER TABLE offers ADD CONSTRAINT offers_currency_check CHECK (currency IN ('AUD','USD','NZD','CAD','GBP'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_currency_check;
ALTER TABLE orders ADD CONSTRAINT orders_currency_check CHECK (currency IN ('AUD','USD','NZD','CAD','GBP'));
```

**Trigger to do this:** before the first real CA or UK user touches the app. Until then, no breakage — AU/US/NZ flows are unaffected.

---

### DB constraint cleanup — taxonomy (low priority, cosmetic)

**Status:** not started — deferred indefinitely
**Effort:** 5 min
**Why:** Pure data hygiene. Code already won't send the stale values, so there's no functional impact — just extra values the DB allows that the app will never use.

**Affected:**
- `listings.category` CHECK still allows `Anarkali`, `Sharara`, `Dupatta`, `Jewellery` (4 dropped categories), and is missing `Footwear`. If `Footwear` is missing in the live DB it's a real bug — diagnostic above will show.
- `listings.condition` CHECK still allows `'New'`, `'Like New'`, `'Good'`, `'Fair'` (4 stale values from before the live-app alignment).

**Trigger to do this:** never urgent. Tackle if/when we do a broader schema cleanup or compliance audit. Can also be skipped permanently — extra allowed values cost nothing.

---

## Done (recent)

- Taxonomy alignment with live Sharetribe: dropped 4 phantom categories (Anarkali, Sharara, Dupatta, Jewellery), 6 phantom fabrics, and 9 phantom items_included lists
- `LISTING_CATEGORY_CONFIG` + `GET /api/listing-config` — per-category field visibility map and full options taxonomy in one endpoint so the frontend stops maintaining its own copy
- `role: 'buyer' | 'seller' | 'system'` added to every notification's `data` payload so frontend can bucket into Selling / Buying / System tabs without type-mapping
- Forum-style listing comments with @mention replies (`parent_comment_id` + `reply_to_comment_id`, `comment_reply` notification type)
- Photo type discriminator on `listing_photos` (`product` / `brand_tag` / `receipt`) with per-type response splitting
- Video upload via signed URL (`POST /listings/:id/video/upload-url`, `DELETE /listings/:id/video`)
- Realtime broadcast for new notifications on `user:<profile_id>` channel
- `POST /api/orders/:id/confirm-received` — buyer-driven completion so reviews unlock immediately
- `AUTO_COMPLETE_DAYS` 7 → 10
- Commission 12% → 15% baseline (tier rates 15/13/11/9)
- Listing visibility opened to any past order participant (fixes "Listing not found" from chat threads)
- Surface `estimated_size`, `size_type`, `designer_name` on feed / search / seller profile / wishlist cards
- Postgres + pg-boss pool sizes shrunk to fit Supabase session-mode 15-slot cap
