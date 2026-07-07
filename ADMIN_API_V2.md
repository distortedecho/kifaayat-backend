# Kifaayat Admin — Backend API Contract (v2)

Reference for the **admin frontend** to build the new 24-screen console and wire it
up. Companion to the original contract (still valid for the endpoints it lists) and
to `ADMIN_STATUS.md` (what's done/left). This doc adds every **new** endpoint and
notes which existing ones are kept, reshaped, or retired-but-alive.

- **Base URL:** `VITE_API_URL` (default `http://localhost:3001`), all under `/api/admin/*`.
- **Auth:** `Authorization: Bearer <supabase access_token>` from the admin login flow.
- **Content-type:** `application/json` (uploads use `multipart/form-data`).
- **Envelope:** responses are the object described inline (no `{ data }` wrapper) unless noted.
- **Errors:** `{ error: string, details?: {...} }` with a 4xx/5xx status.

## Permissions (new — Screen 22)

Every admin resolves to a **role**: `owner | admin | moderator | support`. Some
endpoints require a specific permission (noted as 🔒`perm`). A `403 { error: "Forbidden: '<perm>' required" }` means the role lacks it. Matrix comes from `GET /team`.

| perm | owner | admin | moderator | support |
|---|:-:|:-:|:-:|:-:|
| listings.review / delete | ✓ | ✓ | – | – |
| transactions.refund / force_advance | ✓ | ✓ | – | – |
| payouts.release | ✓ | ✓ | – | – |
| moderation.act | ✓ | ✓ | ✓ | – |
| users.ban | ✓ | ✓ | ✓ | – |
| users.mask | ✓ | ✓ | – | – |
| users.delete | ✓ | – | – | – |
| taxonomy.edit / settings.edit / content.edit | ✓ | ✓ | – | – |
| export.run | ✓ | ✓ | – | – |
| export.pii | ✓ | – | – | – |
| team.manage | ✓ | – | – | – |
| audit.read + all reads | ✓ | ✓ | ✓ | ✓ |

> **2FA:** if `ADMIN_ENFORCE_2FA=true`, every admin request needs an AAL2 (MFA) Supabase session, else `403 { code: "2fa_required" }`. Off by default.

---

# NEW endpoints by screen

## Screen 01 — Dashboard
```
GET /api/admin/dashboard/metrics
```
→ `{ counters: { active_listings, total_users }, metrics: { health: { gmv, revenue_this_week, weekly_orders, buyers_per_seller, liquidity_rate }, leaks: { inquiry_to_purchase: null, seller_response_rate: null, stripe_activation }, growth: { new_buyers, active_buyers } }, note }`
All money in **cents**. `inquiry_to_purchase` + `seller_response_rate` are `null` (pending tracking). Existing `/dashboard`, `/dashboard/timeseries`, `/dashboard/export` still work.

## Screen 02/03/04 — Listings (review, all, detail)
Existing `GET /listings/pending`, `/listings/all`, approve/reject/batch **unchanged**. New/extended:
- `GET /api/admin/listings/:id` → now also returns **`offers[]`**, **`transactions[]`**, **`comments[]`** for the listing (alongside `listing`). Listing objects include **`quality_checks`** (auto quality-score breakdown) and `risk_score`.
- `quality_checks` shape: `{ score: 0-100|null, scored_at, checks: [{ key, label, score, verdict: "pass"|"near"|"fail"|"unknown", weight, detail }] }`. Keys: `image_count, sharpness, value_for_money, banned_words, seller_activity, recency`.

## Screen 05 — Listing edit
```
PUT|PATCH /api/admin/listings/:id
```
Body: partial listing fields + optional **`reason`** (string). Curation-only saves may omit `reason`. Records a before/after diff to the audit log; a content change notifies the seller. (Unchanged endpoint — just accepts `reason` now.)

## Screen 07 — Transactions (sales + offers ledger)
```
GET /api/admin/transactions?tab=&region=&from=&to=&search=&page=&limit=
```
`tab` = `all | offers | awaiting_shipment | in_transit | delivered | completed | refunded`.
→ `{ items: [{ kind: "order"|"offer", id, ref, listing, buyer, seller, seller_location, amount, currency, commission, seller_payout?, state, created_at }], total, page, limit }`. `region` = AU/US/NZ/CA/GB. `search` = order ref or buyer email.

## Screen 08 — Transaction detail + actions
```
GET  /api/admin/transactions/:id
POST /api/admin/transactions/:id/refund          🔒 transactions.refund   body: { reason }
POST /api/admin/transactions/:id/mark-delivered
POST /api/admin/transactions/:id/force-advance   🔒 transactions.force_advance   body: { reason }
```
GET → `{ transaction, money: { sale, item, shipping, voucher_discount, commission_rate, commission, seller_payout, currency, charge_id, note }, shipment: { carrier, tracking, receipt_photo, shipped_at, delivery_method }, timeline: [{ at, event }] }`.
`refund` → Stripe refund (reverses destination transfer + app fee), order → cancelled, frees a reserved listing, cancels payout, notifies buyer. `force-advance` steps `paid→shipped→delivered→complete` (releases payout on complete).

## Screen 09 — Offer thread
```
GET /api/admin/offers/:id
```
→ `{ offer, thread: [{ id, amount, currency, status, round, offered_by, message, created_at }], outcome, lowest_offer }`. Read-only.

## Screen 10 — Payouts
Unchanged (`GET /payouts`, `/payouts/summary`, mark-sent/mark-failed/retry). Cooling-off days now live in `GET /settings/policies`.

## Screen 11/12 — Users + record
```
GET   /api/admin/users/:id
PATCH /api/admin/users/:id                🔒 users.ban   body: { display_name?, location?, bio? }
POST  /api/admin/users/:id/reset-password 🔒 users.ban   (revokes Clerk sessions)
POST  /api/admin/users/:id/mask           🔒 users.mask  → { sign_in_token, expires_in_seconds }
DELETE /api/admin/users/:id               🔒 users.delete (owner only; deletes Clerk + profile)
PATCH /api/admin/users/:id/seller-quality               body: { seller_quality: 0-5|null }
```
`GET /users/:id` → `{ user, verification: { stripe_status }, seller_quality, counts: { listings, purchases, sales, reviews }, referral_code }`. `mask` returns a Clerk sign-in token the FE uses to impersonate. Existing suspend/ban/unban still work. **Drop the tier UI**; ignore `trust_tier`.

## Screen 13 — Referrals
```
GET  /api/admin/referrals               → { metrics: { active_codes, signups_30d, conversion_pct, qualified_total }, codes: [...] }
POST /api/admin/referrals/campaign      body: { code, campaign_name }
```
Existing `/referrals/:userId/disable|enable` still work. User/influencer codes auto-issue on signup (app side).

## Screen 14 — Conversations moderation
```
POST /api/admin/moderation/publish   🔒 moderation.act   body: { message_id, action: "publish"|"hide" }
```
Releases a held message (or hides it for good). Existing `/moderation/flagged`, `/conversation/:id`, `redact`, `warn`, `suspend` unchanged.

## Screen 15 — Reviews moderation
```
GET  /api/admin/reviews/flagged                → { reviews: [{ id, rating, comment, reviewer_role, flag_reason, flag_source, dispute_status, reviewer, reviewee, ... }] }
POST /api/admin/reviews/:id/hide     🔒 moderation.act   body: { reason? }
POST /api/admin/reviews/:id/dispute  🔒 moderation.act   body: { status: "open"|"resolved", note? }
```
Reviews auto-flag on submit (contact info / abusive language). Seller "report review" is app-side (sets `flagged_at`).

## Screen 16 — Push
```
GET  /api/admin/content/push
POST /api/admin/content/push          🔒 content.edit   body: { title, body, deep_link?, audience?: { market?, segment? }, scheduled_at? }
POST /api/admin/content/push/:id/send 🔒 content.edit   (OneSignal broadcast to Subscribed Users)
```

## Screen 17 — Email templates (versioned)
```
GET  /api/admin/content/email-templates
GET  /api/admin/content/email-templates/:key
PUT  /api/admin/content/email-templates/:key           🔒 content.edit   body: { subject, heading?, body }
GET  /api/admin/content/email-templates/:key/versions
POST /api/admin/content/email-templates/:key/rollback  🔒 content.edit   body: { version }
```
Each PUT snapshots the prior version; rollback restores a snapshot as a new version.

## Screen 18 — Website pages CMS (versioned)
```
GET  /api/admin/content/pages
GET  /api/admin/content/pages/:id
POST /api/admin/content/pages          🔒 content.edit   body: { slug, title, body_md, seo_title?, seo_description? }
PUT  /api/admin/content/pages/:id      🔒 content.edit   body: { title?, body_md?, seo_title?, seo_description? }
POST /api/admin/content/pages/:id/publish 🔒 content.edit
```
Published pages are public-readable (served to the website).

## Screen 19 — Blog
```
GET  /api/admin/content/blog
POST /api/admin/content/blog           🔒 content.edit   body: { slug, title, body_md, cover_image_url?, tags?, scheduled_at? }
PUT  /api/admin/content/blog/:id       🔒 content.edit   body: { title?, body_md?, cover_image_url?, tags? }
POST /api/admin/content/blog/:id/publish 🔒 content.edit
```

## Screen 20 — Taxonomy
```
GET /api/admin/config/taxonomy
```
→ `{ vocabularies: { categories: {managed, values}, editorial_tags: {managed, values}, sizes: {locked, counts}, occasions: {locked, values}, curated_edits: {locked, counts}, designers: {count, via} } }`. Categories + editorial-tags CRUD unchanged (`/config/categories*`, `/config/editorial-tags*`). Designers via `/api/designers` typeahead.

## Screen 21 — Settings
```
GET   /api/admin/settings/policies
PATCH /api/admin/settings/policies   🔒 settings.edit   body: { cooling_off_days?, min_listing_price_cents?, active_regions?, require_receipt_for_designer?, no_publish_without_review?, hide_fees_from_sellers? }
```
Existing `GET/PUT /settings` (commission_rate) + `/settings/auto-approve` unchanged. **Drop the Tiers + Boosts tabs** (endpoints still respond; just stop calling).

## Screen 22 — Team & access
```
GET   /api/admin/team                 → { members: [...], permissions: [...], role_matrix: {...} }
POST  /api/admin/team/invite          🔒 team.manage   body: { email, role: "admin"|"moderator"|"support" }
PATCH /api/admin/team/:id/role        🔒 team.manage   body: { role }
POST  /api/admin/team/:id/disable     🔒 team.manage
```

## Screen 23 — Audit log
```
GET /api/admin/audit-log?actor=&action=&target_type=&target_id=&from=&to=&page=&limit=
```
→ `{ entries: [{ id, actor_email, actor_role, action, target_type, target_id, reason, metadata, ip, created_at }], total, page, limit }`. Read-only (append-only server-side).

## Screen 24 — Data export
```
POST /api/admin/export/:dataset?pii=true   🔒 export.run  (pii columns also need 🔒 export.pii)
```
`dataset` = `users | listings | transactions`. Returns a **CSV file** (`text/csv`, `Content-Disposition: attachment`). Without `pii=true` (or without the perm) PII columns are omitted. Every export is audited.

---

# Keep existing (do NOT rebuild — still authoritative)
- Auth: `/auth/login`, `/auth/refresh`.
- Dashboard: `/dashboard`, `/dashboard/timeseries`, `/dashboard/export`.
- Listings: `/listings/pending`, `/listings/all`, `/listings/:id/approve|reject`, `/listings/batch`, `/listings` (create), `/listings/:id/photos`, `/listings/:id/tags`, `/sellers/:id/refresh-stripe`.
- Payouts: `/payouts`, `/payouts/summary`, `/payouts/:id/mark-sent|mark-failed|retry`.
- Users: `/users`, `/users/:id/suspend|unsuspend|ban|unban`.
- Moderation: `/moderation/flagged`, `/conversation/:id`, `redact`, `warn`, `suspend`.
- Config: `/config/categories*`, `/config/editorial-tags*`, `/listing-config` (public).

# Retired-but-alive (STOP calling; backend keeps them so nothing breaks)
- Boosts: `/config/boost-pricing*`.
- Trust tiers: `/settings/tiers`, `/users/:id/trust-tier`, `/cron/recalculate-tiers`. Ignore `trust_tier` / `seller_trust_tier`; show the Stripe **verification pill** + `seller_quality` instead.
- Notification console: `/config/notification-types*`, `/notification-toggles` — replaced by the Content suite.
- Analytics page (`/analytics/*`) — folds into the Dashboard.

---

_Backend: this repo. Contact for shape changes: keep this file + `ADMIN_STATUS.md` in sync. Last updated 2026-07-08._
