# Kifaayat Admin Console — Build Status

Snapshot of the admin-console backend rebuild (the 24-screen desired state from
`Kifaayat_Admin_Comparison`). Companion to `ADMIN_API_V2.md` (the endpoint
contract for the FE) and `ADMIN_BUILD_PLAN.md` / `ADMIN_PHASE0_SPEC.md` (design).

_Last updated: 2026-07-08._

## TL;DR
- **Backend for all 24 screens is built** — ~40 new `/api/admin/*` endpoints, all
  additive. The app and public website are **untouched** (they use non-admin routes).
- Every destructive action is **role-gated + audited + reasoned**.
- **3 things deferred** (need a decision/vendor), **3 things are app-repo work**.
- Migrations **26–34** must be applied (26–33 already run; **34 pending**).

---

## Done (backend built, typechecks clean)

| Screen(s) | Feature | Endpoints / mechanism |
|---|---|---|
| 23 | **Audit log** | `admin_audit_log` (append-only, tamper-proof); 31 admin actions write to it; `GET /audit-log` |
| 22 | **Roles + team + 2FA gate** | `admin_users` + permission matrix; `/team*`; 2FA opt-in via `ADMIN_ENFORCE_2FA` |
| 11/12 | **seller_quality** + **user record** | `PATCH /users/:id/seller-quality`; `GET/PATCH /users/:id`; reset-password, mask, owner-only delete |
| 02/03/04 | **Auto quality-score** | 6 checks incl. Gemini **sharpness**; on `listings.quality_checks`; review-queue sort |
| 04 | **Listing detail enrichment** | detail now returns offers + transactions + comments |
| 05 | **Listing edit** | before/after diff + optional reason + seller notify (`listing_updated`) |
| 07/08/09 | **Transactions + offers** | `GET /transactions`, `/:id`, `/offers/:id`; refund, mark-delivered, force-advance |
| 10 | **Payouts** | existing (mark-sent/failed/retry) + cooling-off day in settings |
| 13 | **Referrals** | `GET /referrals` metrics; `POST /referrals/campaign` |
| 14 | **Moderation hold/publish** | `POST /moderation/publish` (release/hide held message) |
| 15 | **Reviews moderation** | `GET /reviews/flagged`; hide; dispute; **auto-flag on submit** |
| 16 | **Push** | `GET/POST /content/push`, `/send` (OneSignal broadcast) |
| 17 | **Email templates** | CRUD + versions + rollback |
| 18 | **Website pages CMS** | CRUD + versions + publish |
| 19 | **Blog** | CRUD + publish |
| 20 | **Taxonomy** | `GET /config/taxonomy` (5 vocabularies + counts) |
| 21 | **Settings policies** | `GET/PATCH /settings/policies` (cooling-off, regions, min price, policy flags) |
| 24 | **Data export** | `POST /export/:dataset` (CSV, PII-gated + audited) |
| 01 | **Dashboard metrics** | `GET /dashboard/metrics` (2 counters + 7 real metrics) |

---

## Deferred — need a decision / vendor (not skipped by accident)

1. **Cover background-removal** (Screen 04) — needs an image-processing provider
   (remove.bg / Photoroom / Cloudinary): a vendor + API-key choice. No misleading
   stub was shipped. Endpoints will be a ~1-hour add once a provider is picked.
2. **Dashboard leak metrics** — `inquiry_to_purchase` + `seller_response_rate`
   return `null`. Blocked on §8.2 ("confirm the nine metrics + define each") and
   on whether we track listing inquiries + seller response times. The other 7
   metrics are live.
3. **2FA enforcement** — built but **opt-in** (`ADMIN_ENFORCE_2FA=false` default so
   nobody is locked out). Flip to `true` before go-live / multi-user.

## App-repo work (cannot be done from this backend)

These features are half-live: the admin can act, but the **mobile app** must
produce the data.

1. **Seller "report this review" button** — the auto-detect half is done (flags on
   submit); the manual seller-report needs an app button → sets `reviews.flagged_at`.
2. **Message hold in the app** — admin publish/release is ready; the app's message
   **send/fetch** path must set `moderation_hold` on flagged messages and hide held
   ones from the recipient.

---

## Migrations (run in order)

`26–33` already applied. **Run `34` before deploying** (seller-notify on edit uses it):

```bash
psql "$DATABASE_URL" -f src/db/schema-34.sql   # listing_updated notification type
```

| # | Adds |
|---|---|
| 25 | `listings.seller_location` (country filter — already live) |
| 26 | `admin_audit_log` |
| 27 | `profiles.seller_quality` |
| 28 | `listings.quality_checks` |
| 29 | `admin_users` (roles) |
| 30 | referral campaign codes |
| 31 | message hold + review flag columns |
| 32 | settings policy columns |
| 33 | content suite (5 tables) |
| 34 | `listing_updated` notification type |

---

## Env / config the admin needs
- `ADMIN_EMAILS` — comma-separated allowlist; these auto-provision as **owner** on
  first login.
- `ADMIN_ENFORCE_2FA` — `true` to require an AAL2 (MFA) Supabase session for all
  admin routes. Default off.
- OneSignal (`ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`) — required for push send.

## Guarantees held throughout
- **Zero changes to public/app endpoints.** App + website fully safe.
- Retiring admin endpoints (boosts, trust-tier, notification-config) are **kept
  alive** — the FE just stops calling them; nothing is removed server-side.
