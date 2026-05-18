# Kifaayat Backend

REST API server powering the Kifaayat React Native app — a secondhand marketplace. Built with **Hono** (TypeScript), **Supabase** (PostgreSQL), **Clerk** (auth), and **Stripe** (payments).

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | [Hono](https://hono.dev/) on Node.js (`@hono/node-server`) |
| Language | TypeScript (strict, ES modules) |
| Database | Supabase PostgreSQL (PostgREST + raw `postgres` client) |
| Auth | Clerk (users) + Supabase Auth (admin) |
| Payments | Stripe |
| AI | Google Gemini API |
| Email | Resend |
| Push Notifications | OneSignal |
| Background Jobs | pg-boss (PostgreSQL-backed queue) + node-cron |
| Validation | Zod |

---

## Project Structure

```
src/
├── index.ts              # App entry: middleware stack, route mounting, server start
├── routes/               # One file per resource — thin HTTP handlers only
├── services/             # Business logic (offers, orders, conversations, admin, stripe)
├── middleware/           # Auth (Clerk/admin), rate limiting, request logger
├── lib/                  # Shared utilities: DB clients, jobs, email, notifications, risk scoring
├── types/                # Zod schemas + derived TypeScript types
├── listeners/            # Domain event handlers (fire on DB changes → email/notification/risk)
└── db/
    └── schema.sql        # Canonical PostgreSQL schema (Supabase)
```

**Convention**: routes call services; services call `lib/`. Routes should not contain business logic.

---

## Architecture Overview

```
React Native App
      │
      │  HTTPS  (Bearer: Clerk JWT)
      ▼
┌─────────────────────────────────────────────┐
│               Hono Server                   │
│                                             │
│  Middleware (in order):                     │
│  1. CORS                                    │
│  2. Rate Limiting  (4 tiers — see below)    │
│  3. gzip Compression                        │
│  4. Request Logger (structured JSON + ID)   │
│  5. Auth  (Clerk JWT → clerkMiddleware)      │
│                                             │
│  Routes → Services → lib/db                 │
└──────────────┬──────────────────────────────┘
               │
       ┌───────┴────────┐
       │                │
  Supabase JS      postgres npm
  (PostgREST)      (raw SQL)
       │                │
       └───────┬────────┘
               │
        Supabase PostgreSQL
        (with RLS policies)
```

**Two DB clients** are used side-by-side:
- **Supabase JS client** — CRUD via PostgREST, uses the Clerk-issued Supabase token so Row-Level Security (RLS) is automatically enforced per-user.
- **Raw `postgres` client** — complex queries, transactions, and joins that PostgREST can't express. Used with the service-role key (bypasses RLS, so only called from server-side service code).

---

## Authentication Flow

### Mobile Users (Clerk)

```
1. User signs in via Clerk in the app
2. App receives a Clerk JWT (short-lived, ~60s)
3. Clerk JWT contains a custom `supabaseAccessToken` claim
4. App sends: Authorization: Bearer <clerk-jwt>
5. clerkMiddleware verifies JWT with CLERK_SECRET_KEY
6. Extracted userId + supabaseToken stored in Hono context
7. Supabase JS client initialized with supabaseToken → RLS enforced
```

### Admin Users

```
1. Admin logs in with email/password via Supabase Auth
2. Receives a Supabase JWT
3. Sends: Authorization: Bearer <supabase-jwt>
4. adminAuthMiddleware verifies JWT + checks email against ADMIN_EMAILS env var
5. Resolves admin profile ID from DB → stored in context
```

### Internal Endpoints

Webhook and cron endpoints validate a static `x-internal-secret` header against `INTERNAL_API_SECRET`.

---

## Rate Limiting

Four tiers applied per route group:

| Tier | Limit | Applied To |
|---|---|---|
| Global | 100 req/min per IP | All routes |
| Auth | 5 req/min per IP | Admin login |
| AI | 10 req/min per user | `/api/v1/ai/*` |
| Public Read | 60 req/min per IP | Feed, search |
| Write | 30 req/min per user | Mutations (offers, orders, etc.) |

---

## API Routes

All routes are mounted at `/api/v1` (canonical) and `/api` (alias for backwards compatibility).

| Route File | Resource | Notes |
|---|---|---|
| `health.ts` | `GET /health` | Liveness probe |
| `listings.ts` | `/listings` | Create, read, update listings + images |
| `profiles.ts` | `/profiles` | User profile CRUD |
| `feed.ts` | `/feed` | Algorithmic paginated feed |
| `search.ts` | `/search` | Filter by category, condition, price, market |
| `sellers.ts` | `/sellers` | Seller shop, ratings, trust tier |
| `offers.ts` | `/offers` | Make / accept / decline / counter offers |
| `orders.ts` | `/orders` | Order lifecycle from purchase to fulfillment |
| `cart.ts` | `/cart` | Shopping cart |
| `wishlists.ts` | `/wishlists` | Save listings |
| `conversations.ts` | `/conversations` | Direct messaging between users |
| `reviews.ts` | `/reviews` | Post-order reviews and ratings |
| `notifications.ts` | `/notifications` | In-app notification feed |
| `stripe.ts` | `/stripe` | Checkout session + webhook handler |
| `ai.ts` | `/ai` | Image descriptions, styling advice (Gemini) |
| `exchange-rates.ts` | `/exchange-rates` | Currency conversion |
| `reports.ts` | `/reports` | Abuse / fraud reporting |
| `referrals.ts` | `/referrals` | Referral program |
| `admin.ts` | `/admin` | Moderation, stats, user management |
| `email-hooks.ts` | `/email-hooks` | Inbound email webhook (Resend) |
| `iso.ts` | `/iso` | ISO listing requests |
| `sitemap.ts` | `/sitemap.xml` | SEO sitemap |

---

## Core Data Flows

### Creating a Listing

```
POST /api/v1/listings
  → clerkMiddleware (verify JWT)
  → writeRateLimit
  → routes/listings.ts (validate body with Zod)
  → Supabase JS client INSERT into listings table
  → Domain event → listeners/ → push notification to followers
```

### Offer → Order Flow

```
1. Buyer sends POST /api/v1/offers
   → services/offerService.ts: create offer row, notify seller

2. Seller accepts → PATCH /api/v1/offers/:id/accept
   → offerService: update offer status, trigger checkout

3. Buyer pays → POST /api/v1/stripe/create-checkout-session
   → services/stripeService.ts: create Stripe session with offer metadata

4. Stripe webhook → POST /api/v1/stripe/webhook
   → stripeService: verify signature, create order row
   → services/orderService.ts: update listing status, notify buyer+seller

5. Order fulfilled → PATCH /api/v1/orders/:id/ship
   → orderService: update tracking, notify buyer
```

### Background Jobs

```
pg-boss queue (PostgreSQL-backed):
  - Email jobs     → Resend API
  - Push jobs      → OneSignal API
  - Risk scoring   → fraud/trust evaluation on new users/listings

node-cron:
  - Scheduled tasks (e.g., expiring stale offers, cleaning up drafts)

Domain event listeners (src/listeners/):
  - Fire automatically when DB state changes
  - Decouple side-effects (notifications, emails) from request handlers
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default `3001`) |
| `NODE_ENV` | `development` / `production` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public PostgREST key (RLS enforced) |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key (bypasses RLS — server only) |
| `CLERK_SECRET_KEY` | Clerk JWT verification |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Transactional email |
| `GEMINI_API_KEY` | Google AI (image descriptions) |
| `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` | Push notifications |
| `ADMIN_EMAILS` | Comma-separated list of admin emails |
| `INTERNAL_API_SECRET` | Shared secret for internal webhooks |
| `CRON_SECRET` | Auth header for cron job endpoints |
| `CORS_ORIGINS` | Comma-separated production CORS origins |

---

## Running Locally

```bash
npm install
cp .env.example .env   # fill in values

npm run dev            # tsx watch mode — restarts on file changes
npm run typecheck      # type-check without running
```

Production / Docker:

```bash
docker build -t kifaayat-backend .
docker run -p 3001:3001 --env-file .env kifaayat-backend
```

---

## Key Concepts to Know

- **RLS (Row-Level Security)**: Supabase enforces data ownership at the DB level. Every Supabase JS call uses the user's JWT, so a user can only ever read/write their own rows. The service-role key (used in services/) bypasses this intentionally for admin operations.
- **Dual API mounting** (`/api` + `/api/v1`): Exists so the mobile app can migrate to versioned URLs without a forced update.
- **Idempotency-Key header**: Supported on write endpoints to safely retry failed requests without double-submitting.
- **Trust tiers**: Sellers are assigned a trust level based on listing history, reviews, and risk score. Affects visibility in feed ranking.
- **Request correlation IDs**: Every request gets a UUID logged with it — useful for tracing a specific request through structured logs.
