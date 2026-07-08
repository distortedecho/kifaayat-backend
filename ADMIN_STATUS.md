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
- `ADMIN_APP_URL` — the admin FE base URL (e.g. `http://localhost:5173` dev,
  `https://<admin-domain>` prod). Used to build the invite email's redirect. See runbook.

---

## Runbook — inviting team members (Screen 22)

Admins log in via **Supabase Auth** (email + password). Inviting a member creates
their Supabase Auth account + an `admin_users` row, and emails them a link to set
a password. Their role's permissions apply on first login (row flips
`invited → active`). One-time setup is required or the invite link 404s.

### Flow
1. Owner invites `x@email.com` + role → `POST /api/admin/team/invite`.
2. Backend creates the Supabase Auth user, emails a **set-password link**, and
   inserts the `admin_users` row (`status: invited`). Re-inviting a pending member
   is idempotent (re-sends, no error).
3. Person clicks the link → lands on the FE **`/accept-invite`** page → sets a
   password → logs in. First request activates their row.

### One-time setup (required)
1. **Supabase → Auth → URL Configuration**
   - **Site URL** = the admin FE URL (dev `http://localhost:5173`, prod the deployed URL).
   - **Redirect URLs** allowlist → add `<ADMIN_APP_URL>/accept-invite` for dev **and** prod.
     A `redirectTo` not on the allowlist is ignored → link falls back to the Site URL
     (that's the `localhost:3000` "site can't be reached" symptom).
2. **Backend env** → `ADMIN_APP_URL=<admin FE base URL>` on the admin backend service.
3. **Supabase → Auth → SMTP** (recommended) → point at Resend so invite emails send
   from `@kifaayat.shop` reliably (built-in email is rate-limited).
4. **Admin FE `/accept-invite` page** (FE task):
   - Supabase JS client with `detectSessionInUrl: true` auto-consumes the
     `#access_token` fragment and establishes a session.
   - Show a "set your password" form → `await supabase.auth.updateUser({ password })`.
   - Redirect to the dashboard on success.

### Unblock a member invited before this setup (no FE work)
Supabase → **Authentication → Users** → their email → **Send password recovery**
(or set a password) → they log in at the admin login with email + password. The
middleware's email-claim links them to their invited row and activates it.

## Guarantees held throughout
- **Zero changes to public/app endpoints.** App + website fully safe.
- Retiring admin endpoints (boosts, trust-tier, notification-config) are **kept
  alive** — the FE just stops calling them; nothing is removed server-side.
