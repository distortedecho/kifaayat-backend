# Kifaayat Admin Console — Phased Build Plan (backend)

Target: the desired 24-screen console (Kifaayat_Admin_Comparison). Built in phases
so the **current admin, app, and web never break**.

## Governing rules (non-negotiable)

1. **Additive-only on public endpoints** (`/api/search`, `/api/feed`, `/api/website/*`,
   `/api/listings`, `/api/orders`, `/api/offers`, `/api/stripe`). We only ADD response
   fields — never rename/remove one the app or web reads. The app ignores unknown fields.
2. **Keep-alive on in-use admin endpoints.** Nothing is deleted from the backend. Retired
   screens (boosts, tiers, notification-config) keep responding; the admin FE just stops
   calling them. See the Keep-Alive Register at the end.
3. **App-facing removals are product decisions, never silent.** Boosts + trust tiers stay
   live (app still uses boost endpoints; `seller_trust_tier` still flows to app/web). Admin
   FE simply omits them.
4. **New screens = new endpoints.** No reshaping of an endpoint the live admin still calls;
   ship a new route, migrate the FE, then optionally retire.

Status legend: 🟢 have · 🟡 extend existing · 🔴 net-new

---

## Phase 0 — Foundations (unblock everything else)

These four underpin most later screens; build first.

| Item | Status | Work |
|---|---|---|
| **Audit log** (Screen 23) | 🔴 | `audit_log` table (append-only, write-once): `actor_id, actor_role, action, target_type, target_id, reason, ip, metadata jsonb, created_at`. Helper `writeAudit(...)`. `GET /api/admin/audit-log?actor=&action=&from=&to=`. Then wire EXISTING consequential actions to write here: reject-reason, ban/suspend, payout mark-sent/mark-failed/retry, refunds, listing edits. |
| **Roles + 2FA / Team & access** (Screen 22) | 🔴 | `admin_users` gains `role` (owner\|admin\|moderator\|support) + `two_factor_enabled`. Permission-matrix middleware (`requireAdminPermission('refunds')` etc.). `GET /api/admin/team`, `POST /api/admin/team/invite` (owner-only), 2FA enforce. MVP = role column + gating; 2FA can follow. |
| **Auto quality-score** (Screens 02/03/04) | 🟡 | Extend existing `listings.risk_score` + `src/lib/risk-scoring.ts` with Megha's inputs: image count, blur/sharpness, discount depth (value-for-money), banned words, seller activity, recency + weights. Compute on submit. Backfill nulls. Expose score + breakdown in pending/all/detail responses (additive). |
| **`seller_quality`** (Screens 11/12) | 🔴 | `profiles.seller_quality` numeric 0–5, admin-only (never in public/app responses). `PATCH /api/admin/users/:id/seller-quality`. |

Gate: refunds, force-advance, permanent delete, invites all depend on audit + roles.

---

## Phase 1 — Transaction & offer core (the relational spine)

New `/api/admin/*` — the app/web are untouched (they use `/api/orders`, `/api/offers`).

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /api/admin/transactions` | 🔴 | Orders + offers in one ledger. Tabs (All/Offers/Awaiting shipment/In transit/Delivered/Completed/Refunded), filters (region, method, date), 15% commission column. |
| `GET /api/admin/transactions/:id` | 🔴 | Money breakdown (sale, 15% commission, Stripe fee, seller net, charge id), shipment (carrier/tracking/parcel photo), reverse-chron timeline, private buyer/seller messages. |
| `POST /api/admin/transactions/:id/refund` | 🟡 | Reuses existing `refundOrderPayment` (payoutService). Requires reason → writes audit. Role-gated. |
| `POST /api/admin/transactions/:id/mark-delivered` | 🔴 | Operator delivery mark. |
| `POST /api/admin/transactions/:id/force-advance` | 🔴 | Operator state override. Role-gated (§8.8), reason required, audited. |
| `GET /api/admin/offers/:id` | 🔴 | Read-only offer thread oversight (every counter/decline + reasons). |

---

## Phase 2 — User record + referrals

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /api/admin/users/:id` | 🔴 | Full user record: account fields, payout setup, `seller_quality`, verification (Stripe) pill data, cross-linked listings/transactions/reviews. |
| `PATCH /api/admin/users/:id` | 🔴 | Edit account details (audited). |
| `POST /api/admin/users/:id/reset-password` | 🔴 | Operator-initiated reset. |
| `POST /api/admin/users/:id/mask` | 🔴 | Mask-as-user (impersonation). Sensitive → role-gated + audited. |
| `DELETE /api/admin/users/:id` | 🔴 | Permanent delete + data, **owner-only**, danger-zone, audited. |
| `GET /api/admin/referrals` | 🟡 | Metrics (active codes, referral signups 30d, conversion, reward issued) + table. |
| `POST /api/admin/referrals/campaign` | 🔴 | Create one-off campaign code. (User/referral codes still auto-issue app-side.) |

Keep existing `/referrals/:userId/disable|enable`, `/users/:id/suspend|ban|unsuspend|unban`.

---

## Phase 3 — Moderation split + reviews

| Endpoint | Status | Purpose |
|---|---|---|
| `POST /api/admin/moderation/publish` | 🔴 | Release a held message. Reshape flagged flow to **hold-until-reviewed** (currently only redact). |
| flagged queue incl. listing comments | 🟡 | Listing comments flow into the same queue as DMs. |
| `GET /api/admin/reviews/flagged` | 🔴 | Reviews flagged by seller or auto-detected (abusive language), star + reason + both parties. |
| `POST /api/admin/reviews/:id/hide` | 🔴 | Hide from public profile, kept on record + audit. |
| `POST /api/admin/reviews/:id/dispute` | 🔴 | Open in-console dispute. |

Keep existing `/moderation/redact|warn|suspend|flagged|conversation/:id`.
Dashboard "reported reviews" queue count depends on this phase.

---

## Phase 4 — Listing detail / edit enrichment

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /api/admin/listings/:id` (extend) | 🟡 | Add automated-checks panel, quality-score breakdown, on-listing comments, per-listing offers/transactions ledger. All additive. |
| `PUT /api/admin/listings/:id` (extend) | 🟡 | Mandatory edit reason + seller notification + audited before/after field diff. |
| `POST /api/admin/listings/:id/cover/remove-bg` | 🔴 | Cover background removal — store original, reversible, audited. |
| `POST /api/admin/listings/:id/cover/restore` | 🔴 | Restore original cover. |

---

## Phase 5 — Content suite (all net-new; replaces notification console)

| Endpoint | Status | Purpose |
|---|---|---|
| `GET/POST /api/admin/content/push` | 🔴 | Push copy authoring, merge tags, audience, schedule; versioned + audited. Sends via OneSignal. |
| `GET/POST/PUT /api/admin/content/email-templates` | 🔴 | Transactional/lifecycle templates, versioned w/ rollback, test send. Backed by Resend. |
| `GET/POST/PUT /api/admin/content/pages` | 🔴 | Website/help copy CMS (markdown, versioned, publish → serves via `/api/website/*`). |
| `GET/POST/PUT /api/admin/content/blog` | 🔴 | Blog composer (posts, schedule, SEO slug). |

Notification-config console stays live until this ships (Keep-Alive Register).

---

## Phase 6 — Configure & record polish

| Item | Status | Work |
|---|---|---|
| **Taxonomy unify** (Screen 20) | 🟡 | One screen across 5 vocabularies. Have Categories + Editorial tags + `designers` table. Add **Sizes**, **Occasion**, **Curated edits** as DB-backed managed vocab (currently hardcoded enums). IDs locked/verbatim (already the case). |
| **Settings** (Screen 21) | 🟡 | Add cooling-off days, active regions (5 markets + currency), policies (require receipt for designer claims, no-publish-without-review, hide fees). Keep 15% + A$5. Tiers/Boosts tabs just hidden by FE. |
| **Data export** (Screen 24) | 🟡 | `POST /api/admin/export/:dataset` (users/listings/transactions), PII-gating toggle (off by default), each export audited. Keep existing `/dashboard/export`. |
| **Dashboard** (Screen 01) | 🟡 | Redefine 9 "honest metrics" (define numerator/denominator/window each), 2 live counters, "Today's queue" strip (reported-reviews count needs Phase 3). |
| **Payouts** (Screen 10) | 🟡 | Surface delivered + cooling-off-days release model + Ready/Cooling-off states (have escrow + `auto_complete_at`). Failed/Sent tabs per §8.6. |

---

## Keep-Alive Register — live but "admin FE stops calling"

Never removed from backend. App/web unaffected.

| Endpoint / field | Consumer today | Fate |
|---|---|---|
| `/api/admin/config/boost-pricing` (×3) | admin Settings | FE drops Boosts tab. Stays live. |
| `/api/stripe/boost-payment-intent`, `/api/listings/:id/boost/confirm` | **app** | Untouched — app-only. |
| `/api/admin/settings/tiers`, `/api/admin/users/:id/trust-tier`, `/api/admin/cron/recalculate-tiers` | admin Settings/Users | FE drops tier UI. Stays live. |
| `seller_trust_tier` in `/api/search` + `/api/feed` | **app/web** | Stays in response (return 0/null ok). Admin ignores; app keeps reading. |
| `/api/admin/config/notification-types`, `/api/admin/notification-toggles` | admin Notifications page | FE stops using when Content suite lands. Stays live. |

---

## Open decisions blocking specific phases (from spec §8)

- §8.1 Settings worked example: canonical A$895 vs 680/102/578 illustration → **Settings/Phase 6**
- §8.3 Keep an in-console per-event notification toggle? → **Phase 5/6**
- §8.4 Drop `saved_search` push audience? → **Phase 5**
- §8.5 Admin create-listing: include open-to-offers + shipping fields? → **Create (existing)**
- §8.6 Where failed/historical payouts reconcile (Failed/Sent tabs)? → **Phase 6 Payouts**
- §8.7 Keep bulk approve (reject one-at-a-time)? → **Review queue (existing)**
- §8.8 Which roles can force-advance? → **Phase 0 roles + Phase 1**

---

## Sequencing rationale

Phase 0 first (audit + roles + quality-score + seller_quality) because refunds,
force-advance, delete, edits, and export all must write audit and be role-gated.
Then the transaction/offer spine (Phase 1) since detail screens link to it. Users
(2) and moderation/reviews (3) light up the CRM + queue. Listing enrichment (4),
Content suite (5), and Configure/record (6) follow. Every phase adds routes; none
remove one the live admin calls.
