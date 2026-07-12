# Kifaayat Moderation — implementation & app contract

_Built 2026-07-12. Root cause of "moderation doesn't work at all" fixed here._

## What was broken

`fraud_flags` had CHECK constraints that **rejected the values the code inserts**:
- `entity_type` allowed only `listing/user/order` — but the code inserts `message`.
- `status` allowed only `open/reviewed/dismissed` — but the code inserts `pending`/`actioned`.

So **every** flag insert (the message content-scanner) silently violated the
constraint and was dropped. The queue was permanently empty. `schema-36.sql`
widens both constraints and makes `entity_id` nullable. **Run schema-36 first.**

## The engine

`src/lib/moderation.ts` — `moderate(text) → { verdict: BLOCK|REVIEW|ALLOW, reasons[] }`.
Faithful TS port of `kifaayat_moderation.py` (20/20 self-tests pass). Detects
profanity, slurs/hate, sexual, threats, romanised Desi abuse, off-platform /
contact-sharing, phone numbers (incl. spelled-out digit evasion), emails, URLs,
@handles, payment-app names — with leet/mask/spacing de-obfuscation and
false-positive guards (sizes, prices, measurements, safe substrings).

- **BLOCK** → reject the write.
- **REVIEW** → allow but queue for a moderator.
- **ALLOW** → clean.

## The three admin sections (`kifaayat_admin` → Moderation page, tabbed)

| Section | Source | Backend feed |
|---|---|---|
| Conversations | system (offers/DMs) | `fraud_flags` `entity_type='message'`, `flag_type='system'` |
| Reported comments | users | `fraud_flags` `entity_type='listing_comment'`, `flag_type='user_report'` |
| System comments | engine | `fraud_flags` `entity_type='listing_comment'`, `flag_type='system'` |

## Backend wiring (done)

- **Conversation/DM messages** — `scanMessageContent()` (content-scanner.ts) now
  runs `moderate()` on every message via `sendMessage`. BLOCK/REVIEW → system flag.
- **Offer counter-messages** — `POST /api/offers/:id/counter` runs `moderate()`;
  BLOCK is rejected (contact-aware vs. abuse-aware error copy).
- **Listing comments** — `POST /api/listings/:id/comments`:
  - BLOCK → `422 { error, blocked: true }`, comment **not** created, logged as a
    system flag (entity_id null, content in `details`).
  - REVIEW → comment created + `flag_source='auto'` + system flag.
  - ALLOW → normal.
- **App comment reads** now filter `hidden_at IS NULL` (list + count).

### Admin endpoints (`/api/admin/*`, gated `moderation.act` for actions)
- `GET  /moderation/comments?source=user|system|all&status=pending|all`
- `POST /moderation/comment/hide    { comment_id }`
- `POST /moderation/comment/restore { comment_id }`
- `POST /moderation/flag/dismiss    { flag_id }`  (works for message or comment flags)
- (existing message actions: `/moderation/warn`, `/redact`, `/publish`, `/suspend`)

## Mobile app work required (both apps — NOT in these repos)

> **IMPORTANT — server is the single source of truth for moderation.**
> Do NOT hard-block comments/messages client-side. If the app filters bad
> content locally and never submits it, the server never sees it and the
> admin "System comments" queue stays empty (blocked attempts are invisible,
> so repeat offenders can't be caught). Instead: **always POST, then render
> the server's response.** On BLOCK the server returns `422 { blocked }` AND
> logs the attempt. Any existing client-side filter must be reduced to a
> non-blocking hint (or removed) — the wordlist lives on the server only, so
> a client copy would drift.

1. **Report a comment** — add a "Report" action on each listing comment:
   ```
   POST /api/listings/:listingId/comments/:commentId/report
   Authorization: Bearer <clerk token>
   Body (optional): { "reason": "spam / offensive / scam ..." }
   → 200 { success: true }              // queued
   → 200 { success: true, already_reported: true }   // idempotent
   → 400 { error: "You can't report your own comment" }
   ```
   Idempotent per reporter. Show a confirmation toast ("Thanks, we'll review this").

2. **Handle blocked comment posts** — `POST .../comments` can now return
   `422 { error, blocked: true }`. Show `error` inline; keep the user's text so
   they can edit. (Previously only offer counters were blockable.)

3. **Handle blocked offer counters** — `POST /api/offers/:id/counter` already
   returned 400 for contact info; it now also blocks abuse/threats. Same UX.

No app change is needed for system flagging of DMs/comments — that happens
server-side automatically.

### Realtime: live moderation of the open chat

Admin Hide / Release / Redact / Warn now **broadcast** on the same channel the
app already subscribes to for live messages: `conversation:<conversationId>`.

- **Warn** → emits the existing `new_message` event (full message row payload)
  → the app appends it like any message (no new handler needed).
- **Hide / Release / Redact** → emits a new `message_moderated` event:
  ```
  event: "message_moderated"
  payload: {
    id: string,               // message id
    conversation_id: string,
    moderation_hidden: boolean, // true = hide from chat, false = visible
    content?: string           // present on redact (new bubble text)
  }
  ```
  **App handler (add this):** on `message_moderated`, in the open conversation:
  - `moderation_hidden === true`  → remove that message id from the list
  - `moderation_hidden === false` → simplest is to **refetch** the message list
    (the message may no longer be cached after a hide); if `content` is present
    (redact), update that message's text in place
  The 60s poll + focus-refetch already reconcile it — this just makes it instant
  while the screen is open.

## Files touched
- NEW `src/lib/moderation.ts`, `src/db/schema-36.sql`, this doc
- `src/lib/content-scanner.ts` (engine-backed), `src/lib/audit.ts` (+`listing_comment`)
- `src/routes/listings.ts` (comment create/report/read filter)
- `src/routes/offers.ts` (counter check), `src/routes/admin.ts` (+4 endpoints)
- `kifaayat_admin/src/pages/ModerationPage.tsx` (3 tabs + comment actions)
