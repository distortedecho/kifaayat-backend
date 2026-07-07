# Phase 0 — Detailed Spec (Foundations)

Companion to ADMIN_BUILD_PLAN.md. Four foundations that unblock the rest.
Grounded in current code; **nothing here is built yet** — spec for review.

Current-state facts this builds on:
- **Admins auth via Supabase Auth** (`signInWithPassword`), gated by the `ADMIN_EMAILS`
  env allowlist. App users are Clerk — a *separate* identity system. `adminAuthMiddleware`
  verifies the Supabase JWT, checks the email, resolves `adminProfileId` from
  `profiles.supabase_user_id`.
- **Risk scoring already exists**: `listings.risk_score` (0–100, 100 = risky),
  `src/lib/risk-scoring.ts` = Gemini AI fraud (60%) + seller history (40%). The seller-history
  half currently reads `trust_tier` — which is retiring, so it needs reworking.

---

## 0.1 Audit log (Screen 23)

### Table

```sql
CREATE TABLE admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,          -- monotonic, cheap ordering
  actor_id     UUID,                           -- admin (profiles.id); NULL for system
  actor_email  TEXT,                           -- denormalized snapshot (actors may be deleted)
  actor_role   TEXT,                           -- role at time of action
  action       TEXT NOT NULL,                  -- from the taxonomy below
  target_type  TEXT NOT NULL,                  -- 'listing'|'user'|'order'|'payout'|'review'|'message'|'settings'|'export'|'team'
  target_id    TEXT,                           -- id of the thing acted on
  reason       TEXT,                           -- required for refunds/edits/force-advance/delete
  metadata     JSONB DEFAULT '{}'::jsonb,      -- before/after diff, amounts, etc.
  ip           INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_created ON admin_audit_log (created_at DESC);
CREATE INDEX idx_audit_actor   ON admin_audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_target  ON admin_audit_log (target_type, target_id);
CREATE INDEX idx_audit_action  ON admin_audit_log (action, created_at DESC);
```

**Immutability:** no UPDATE/DELETE granted to the app role — only INSERT + SELECT.
Enforce with a Postgres rule or by revoking UPDATE/DELETE on the table from
`service_role` via a `BEFORE UPDATE/DELETE` trigger that `RAISE EXCEPTION`. (Spec
decision: trigger is simplest and portable.)

### Helper

```ts
// src/lib/audit.ts
writeAudit({
  actorId, actorEmail, actorRole,
  action: "transaction.refund",
  targetType: "order", targetId,
  reason,                       // throws if the action requires a reason and it's missing
  metadata,                     // e.g. { amount_cents, currency, before, after }
  ip: c.req.header("x-forwarded-for"),
}): Promise<void>   // fire-and-forget; failure logs but never blocks the action
```

### Action taxonomy (write-points — all EXISTING handlers gain a writeAudit call)

| action | where it fires |
|---|---|
| `listing.approve` / `listing.reject` / `listing.edit` / `listing.delete` / `listing.status_change` | admin listings routes |
| `listing.cover_bg_removed` / `listing.cover_restored` | Phase 4 |
| `user.ban` / `user.unban` / `user.suspend` / `user.unsuspend` / `user.edit` / `user.reset_password` / `user.mask` / `user.delete` / `user.seller_quality_set` | admin users routes |
| `transaction.refund` / `transaction.mark_delivered` / `transaction.force_advance` | Phase 1 |
| `payout.mark_sent` / `payout.mark_failed` / `payout.retry` | admin payouts routes |
| `moderation.message_publish` / `.message_redact` / `.warn` / `.suspend` / `review.hide` / `review.dispute` | moderation/reviews |
| `settings.edit` / `taxonomy.edit` | config/settings routes |
| `content.publish` (push/email/page/blog) | Phase 5 |
| `export.run` (+ `pii: true` in metadata when PII enabled) | Phase 6 |
| `team.invite` / `team.role_change` / `auth.login` | team/auth |

### Endpoint
`GET /api/admin/audit-log?actor=&action=&target_type=&from=&to=&page=&limit=` → paginated,
read-only. Requires `audit.read` permission. Never editable.

---

## 0.2 Roles, Team & access, 2FA (Screen 22)

### Table

```sql
CREATE TABLE admin_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id   UUID UNIQUE NOT NULL,     -- the Supabase Auth identity
  email              TEXT UNIQUE NOT NULL,
  role               TEXT NOT NULL DEFAULT 'support'
                       CHECK (role IN ('owner','admin','moderator','support')),
  permissions_override JSONB,                  -- optional per-user grant/deny on top of role
  two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
  invited_by         UUID REFERENCES admin_users(id),
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('invited','active','disabled')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at      TIMESTAMPTZ
);
```

**Migration path (no breakage):** seed `admin_users` from the current `ADMIN_EMAILS`
list as `role='owner'`. Keep `ADMIN_EMAILS` as a fallback in the middleware during
transition so the live admin never locks out. Remove the env fallback only once every
admin exists in the table.

### Permission matrix (proposed — confirm)

Permissions are granular; roles map to sets. `permissions_override` can tweak per-user.

| Permission | owner | admin | moderator | support |
|---|:--:|:--:|:--:|:--:|
| `listings.review` (approve/reject/edit) | ✓ | ✓ | ✗ | ✗ |
| `listings.delete` | ✓ | ✓ | ✗ | ✗ |
| `transactions.refund` | ✓ | ✓ | ✗ | ✗ |
| `transactions.force_advance` | ✓ | ✓ | ✗ | ✗ |
| `payouts.release` | ✓ | ✓ | ✗ | ✗ |
| `moderation.act` (publish/redact/warn/suspend, review hide) | ✓ | ✓ | ✓ | ✗ |
| `users.ban` | ✓ | ✓ | ✓ | ✗ |
| `users.mask` (impersonate) | ✓ | ✓ | ✗ | ✗ |
| `users.delete` (permanent) | ✓ | ✗ | ✗ | ✗ |
| `taxonomy.edit` / `settings.edit` | ✓ | ✓ | ✗ | ✗ |
| `content.edit` | ✓ | ✓ | ✗ | ✗ |
| `export.run` | ✓ | ✓ | ✗ | ✗ |
| `export.pii` (include PII columns) | ✓ | ✗ | ✗ | ✗ |
| `team.manage` (invite / role) | ✓ | ✗ | ✗ | ✗ |
| `audit.read` | ✓ | ✓ | ✓ | ✓ (read-only) |
| everything read/view | ✓ | ✓ | ✓ | ✓ |

Force-advance (§8.8) → owner + admin only, always reasoned + audited.

### Middleware evolution

`adminAuthMiddleware` stays (verifies Supabase JWT + resolves identity), and gains:
1. Look up `admin_users` by `supabase_user_id`; set `adminRole`, `adminPermissions`,
   `adminEmail` on context. (Fallback to ADMIN_EMAILS→owner during transition.)
2. New `requireAdminPermission("transactions.refund")` guard used per-route.

```ts
admin.post("/transactions/:id/refund", requireAdminPermission("transactions.refund"), …)
```

### 2FA — use Supabase Auth native MFA (don't build our own)

Supabase Auth ships TOTP MFA with Assurance Levels (AAL1/AAL2). Enforce by checking the
JWT `aal` claim:
- Enrolment endpoints proxy Supabase MFA (`/api/admin/2fa/enroll`, `/verify`).
- Middleware: for any write permission, require `aal2`; a member with
  `two_factor_enabled=false` is blocked from privileged actions until enrolled
  ("a member stays blocked until setup is complete" — Screen 22).

### Endpoints
`GET /api/admin/team` · `POST /api/admin/team/invite` (owner) ·
`PATCH /api/admin/team/:id/role` (owner) · `POST /api/admin/team/:id/disable` (owner) ·
`POST /api/admin/2fa/enroll` · `POST /api/admin/2fa/verify`.

---

## 0.3 Auto quality-score (Screens 02/03/04)

Megha's "auto quality score" = a **quality** framing of what we already compute as
**risk**. Non-breaking approach: **keep `risk_score` and `risk-scoring.ts` as-is** (the
auto-approve config still uses it), and ADD an explicit, deterministic checks layer that
maps to her named inputs, stored for the review-card + detail breakdown.

### New column

```sql
ALTER TABLE listings
  ADD COLUMN quality_checks JSONB;   -- { checks:[{key,score,verdict}], score:int, scored_at }
-- quality_score presented to admin = the rolled-up `score` (0–100, 100 = best),
-- or simply 100 - risk_score if we choose to derive. Kept separate so the two
-- engines don't entangle.
```

### The six checks (Megha's inputs → computable signals + proposed weights)

| Check (key) | Signal (deterministic where possible) | Weight | pass / near / fail |
|---|---|--:|---|
| `image_count` | # product photos | 15% | ≥4 pass · 2–3 near · ≤1 fail |
| `sharpness` | blur score (Gemini vision, or Laplacian variance if we process bytes) | 20% | crisp / soft / blurry |
| `value_for_money` | discount depth = (orig−price)/orig | 15% | plausible / steep / too-good-to-be-true |
| `banned_words` | scan title+desc vs banned list (reuse offers `findContactInfo` + off-platform terms) | 20% | clean / minor / contact-or-off-platform found |
| `seller_activity` | listings, completed sales, response rate, last-active | 15% | established / new / dormant-or-none |
| `recency` | account age | 15% | >90d / 30–90d / <7d |

Roll-up `score` = weighted blend → 0–100. `verdict` per check drives the pass/near/fail
chips in the review card + listing detail "automated checks" panel.

### Rework needed in `risk-scoring.ts`
- **Drop the `trust_tier` term** from `computeSellerHistoryScore` (tiers retiring).
  Replace with `seller_quality` (0.3 below) + activity signals above.
- Add the deterministic `banned_words`, `image_count`, `value_for_money` checks (cheap,
  no AI) so scoring degrades gracefully if Gemini is unavailable.

### Exposure (all additive)
`quality_score` + `quality_checks` added to `/listings/pending`, `/listings/all`,
`/listings/:id`. Review queue sorts by it (`sort=quality` / existing `risk_high`).
**Never** added to public `/api/search` or `/api/feed`.

---

## 0.4 seller_quality (Screens 11/12)

```sql
ALTER TABLE profiles
  ADD COLUMN seller_quality NUMERIC(2,1)
    CHECK (seller_quality IS NULL OR (seller_quality >= 0 AND seller_quality <= 5));
-- admin-only, operator-assigned 0.0–5.0, never shown to users.
```

- `PATCH /api/admin/users/:id/seller-quality` body `{ seller_quality: number }` →
  writes audit (`user.seller_quality_set`, before/after).
- **Must be excluded from every public/app response** — verify `getProfileByClerkId`
  select list, `/api/search`, `/api/feed`, `/api/sellers/*` do NOT include it. (These
  select explicit columns today, so it won't leak by default — just don't add it.)
- Feeds the revised `seller_activity`/history term in 0.3.

---

## Build order within Phase 0
1. **Audit log** (0.1) — needed by everything that writes.
2. **seller_quality** (0.4) — tiny, unblocks the scoring rework.
3. **Quality-score rework** (0.3) — drops the tier dependency, adds checks.
4. **Roles + 2FA** (0.2) — larger; gate privileged routes once refund/force-advance land.

Every item is additive DDL + new/extended admin routes. No public endpoint or in-use
admin endpoint changes shape. App/web untouched.

## Decisions to confirm before building 0
- Permission matrix rows (esp. moderator vs admin split, and export.pii = owner-only).
- Quality-score: derive `100 − risk_score`, or compute an independent `quality_checks`
  roll-up? (Spec leans independent, so the named checks are explainable.)
- Audit immutability mechanism: trigger-based `RAISE EXCEPTION` on UPDATE/DELETE — OK?
- 2FA via Supabase native MFA (AAL2) rather than a custom TOTP — confirm.
