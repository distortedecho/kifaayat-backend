# Backend answers to the FE wiring doc (v2)

Reply to `Kifaayat Admin — FE wiring status`. Verified against the actual code.
"✅ confirmed" = drop your fallback. "⚠️ correct" = your guess differs from what
ships. Two real backend changes were made in response (bottom).

_2026-07-08._

## Backend changes made for you
1. **`GET /transactions` items are now OBJECTS with ids** (were bare strings). Shape below — you can link buyer/seller/listing.
2. **NEW `GET /api/admin/me`** → `{ id, email, role, permissions: string[] }`. Use `permissions` to gate buttons for the current admin. No need to match email against `/team`.

---

## §2.1 Response-shape picks (drop the other branch)

| Endpoint | Canonical shape | Note |
|---|---|---|
| `GET /transactions` | `{ items, total, page, limit }` | ✅ use `items` |
| `GET /payouts` | `{ items, next_cursor }` | ✅ use `items` (not `payouts`) |
| `GET /payouts/summary` | `{ summary: {...} }` | ✅ nested `summary` |
| `GET /listing-config` | `{ options: { curation_tags } }` | ✅ |
| `GET /config/taxonomy` | `{ vocabularies: {...} }` | ✅ nested |
| `GET /content/push` | `{ campaigns: [...] }` | ⚠️ **`campaigns`**, not `notifications`/`items` |
| `GET /content/email-templates` | `{ templates: [{ id, key, subject, version, updated_at }] }` | ⚠️ list has **no** `heading`/`body` — those come from `GET /:key` |
| `GET /content/pages` | `{ pages: [{ id, slug, title, status, version, published_at, updated_at }] }` | ⚠️ list has **no** `body_md`/`seo_*` — get those from `GET /:id` |
| `GET /content/blog` | `{ posts: [{ id, slug, title, status, tags, scheduled_at, published_at, updated_at }] }` | ⚠️ list has no `cover_image_url`/`body_md`; get from... (no single-blog GET yet — say the word and I'll add `GET /content/blog/:id`) |
| `GET /team` | `{ members, permissions, role_matrix }` | see §2.10 |
| `GET /referrals` | `{ metrics, codes }` | see below |
| `POST /users/:id/mask` | `{ sign_in_token, expires_in_seconds }` | ✅ |

**`GET /referrals` exact shape** (⚠️ several of your guessed fields differ):
```jsonc
{
  "metrics": { "active_codes", "signups_30d", "conversion_pct", "qualified_total" },
  "codes": [{
    "id", "code",
    "code_type": "user" | "influencer" | "campaign",   // NOT "kind"
    "campaign_name": string | null,
    "user_id": string | null,                           // NOT "owner_email"
    "disabled": boolean,                                 // NOT "active"
    "created_at"
  }]
}
```
There are **no** per-code `signups`/`conversions`/`qualified` counts — those are only in `metrics` (aggregate). If you want per-code stats, ask and I'll add them.

## §2.2 `GET /users/:id` fields — confirmed
```jsonc
{
  "user": { /* full profiles row */ id, display_name, email, location, bio,
            avatar_url, created_at, suspended_at, banned_at, ... },
  "verification": { "stripe_status": "not_connected"|"incomplete"|"complete" },
  "seller_quality": number | null,
  "counts": { "listings", "purchases", "sales", "reviews" },
  "referral_code": { "code": string, "disabled": boolean } | null   // ⚠️ OBJECT, not string — read .code
}
```
- **`email` is present** here — no separate Clerk fetch.
- **`counts.reviews` = reviews RECEIVED** (`reviewee_id`), i.e. reviews *about* this user.

## §2.3 `GET /transactions` items — now objects (changed for you)
```jsonc
{
  "kind": "order" | "offer",
  "id",                                   // → route to /transactions/:id (order) or /offers/:id (offer)
  "ref",                                  // order: "KIF-20260708-068U"; offer: "OFFER-a1b2c3d4"
  "listing": { "id", "title" } | null,
  "buyer":   { "id", "display_name" } | null,
  "seller":  { "id", "display_name", "location" } | null,
  "seller_location": "AU"|... | null,     // also flat, for the region chip
  "amount", "currency",
  "commission": number | null,            // null for offers
  "seller_payout": number | null,         // orders only
  "state",
  "round": number,                        // offers only
  "created_at"
}
```
- **`ref`** is `KIF-YYYYMMDD-XXXX` for orders (not `KFY-2026-0042`), `OFFER-<8hex>` for offers.
- **`state` for orders** = raw order status: **`paid | shipped | delivered | complete | cancelled`** — NOT your tab names. Map your colour keys: `awaiting_shipment→paid`, `in_transit→shipped`, `completed→complete`, `refunded→cancelled`. There is **no** `refunded` state — a refund sets the order to `cancelled`.
- **`state` for offers** = **`pending | countered | accepted | declined | completed`**.
- Money (`amount`, `commission`, `seller_payout`) is in **cents**.

## §2.4 `mask` UX — confirmed
It's a **Clerk sign-in token** (10-min expiry). No redirect URL is built server-side. Your clipboard-copy + expiry-toast is exactly right. (If you later want a ready-made ticket URL, Clerk's is `https://<clerk-frontend-api>/v1/tickets/accept?ticket=<token>` — but the token alone is fine.)

## §2.5 `export` — confirmed
`Content-Type: text/csv`, `Content-Disposition: attachment; filename="<dataset>-export.csv"`. Your own filename override is fine. Without `?pii=true` (or without the `export.pii` perm) PII columns are omitted; a `403` means the role lacks `export.pii` — surface it as a toast (working as intended).

## §2.6 `config/taxonomy` — shape VARIES per vocabulary ⚠️
```jsonc
{ "vocabularies": {
  "categories":     { "managed": true,  "values": [{ id, name, display_order, icon_url, is_active }] },
  "editorial_tags": { "managed": true,  "values": [{ id, name, is_active }] },
  "sizes":          { "managed": false, "locked": true, "counts": { "<size>": <n>, ... } },   // MAP, not array
  "occasions":      { "managed": false, "locked": true, "values": ["Bridal", "Casual", ...] }, // string[]
  "curated_edits":  { "managed": false, "locked": true, "counts": { "<tag>": <n>, ... } },     // MAP, not array
  "designers":      { "managed": true,  "count": <n>, "via": "/api/designers" }
}}
```
So: categories/editorial_tags = **object array** under `values`; occasions = **string array** under `values`; sizes/curated_edits = **counts map** (no array); designers = just a count. Your dual string/object handling covers `values`; add a branch for the two `counts` maps.

## §2.7 `audit-log` — confirmed + action enum
Entry: always `id, action, target_type, created_at`; optional `actor_id, actor_email, actor_role, target_id, reason, metadata (JSON), ip`. Filters AND-ed, all optional. **`action` is a fixed taxonomy** — you can use a Select:
```
listing.approve, listing.reject, listing.delete, listing.edit, listing.status_change, listing.create,
moderation.warn, moderation.message_redact, moderation.message_publish, moderation.suspend,
payout.mark_sent, payout.mark_failed, payout.retry,
user.ban, user.unban, user.suspend, user.unsuspend, user.seller_quality_set, user.edit,
user.reset_password, user.mask, user.delete,
transaction.refund, transaction.mark_delivered, transaction.force_advance,
review.hide, review.dispute,
settings.edit, taxonomy.edit, referral.disable, referral.enable,
content.publish, team.invite, team.role_change, export.run
```
`target_type` ∈ `listing | user | order | payout | review | message | settings | taxonomy | content | export | team | referral`.

## §2.8 Curation tags on `/listings/all` — confirmed inline
Each listing carries **`curation_tags: string[] | null` inline** (the row selects `*`). No second query needed.

## §2.9 `dashboard/metrics` null handling — one correction ⚠️
`inquiry_to_purchase` + `seller_response_rate` = `null` → render `—`. ✅
But **`liquidity_rate` and `stripe_activation` are already 0–100 percentages** (e.g. `56.4`), **not** 0–1 fractions — render `${value}%` directly, do NOT ×100. `buyers_per_seller` is a ratio (e.g. `1.04`). `gmv` + `revenue_this_week` are **cents**; `weekly_orders`, `new_buyers`, `active_buyers` are counts.

## §2.10 `team` matrix + current role — resolved
- **Current role/permissions:** use the new **`GET /api/admin/me`** → `{ id, email, role, permissions: string[] }`. Gate a button by checking the permission is in `me.permissions`.
- **`role_matrix`** from `/team` is `Record<role, permissionKey[]>` (role → array of permission keys) — **not** `Record<perm, Record<role, bool>>`.
- **`permissions`** from `/team` is the full `string[]` of permission keys.
- **Permission keys are stable — hardcode them:**
  `listings.review, listings.delete, transactions.refund, transactions.force_advance, payouts.release, moderation.act, users.ban, users.mask, users.delete, taxonomy.edit, settings.edit, content.edit, export.run, export.pii, team.manage, audit.read`

---

Anything marked ⚠️ is where your fallback/guess needs a tweak; everything else you can lock to the single shape. Ping me if you want `GET /content/blog/:id` or per-code referral stats added.
