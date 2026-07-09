# Kifaayat — Notifications the Backend Can Send

Reality-check of the Master Notifications sheet against what the backend actually
fires. Of the 86 listed, the backend **actively sends ~24** — all as **push +
in-app**, and the six transactional order emails (📧) plus listing approve/reject +
welcome also send **email**. This lists exactly which, mapped to the sheet's
`Event Key`, with the variables the backend really has at each trigger.

_Last updated: 2026-07-10._

## Conventions
- Every notification carries **`{firstName}`** (first word of the user's display
  name; falls back to a generic greeting if unset).
- "Backend type" = the `NOTIFICATION_TYPES` value that fires.
- Channel today = **push + in-app** unless the row says "also email".

---

## ✅ Actively sent (push + in-app) — with real variables

| Sheet Event Key | Backend type | Extra variables available |
|---|---|---|
| **PurchaseNewOrder** / **PurchaseOrderReceipt** (26/27) | `order_paid` | `{listingTitle}`, `{amount}`, `{payout}` — 📧 **also email** |
| **PurchaseSellerAcceptedToBuyer** (30) | `order_accepted` | `{listingTitle}` — 📧 **also email** |
| **PurchaseSellerRejectedToBuyer** / auto-reject (31/33) | `order_rejected` | `{listingTitle}`, `{amount}`, `{reason}` — 📧 **also email** |
| **PurchaseOrderMarkedAsDelivered** (36, "on its way") | `order_shipped` | `{listingTitle}`, `{carrier}`, `{trackingNumber}` — 📧 **also email** *(push still lacks carrier; email has it)* |
| Operator mark-delivered (38) | `order_delivered` | `{listingTitle}` — 📧 **also email** |
| **…MarkedAsReceived** / auto-complete (39/40/41) | `order_complete` | `{listingTitle}`, `{payout}`, `{currency}` (seller variant) — 📧 **also email** |
| **OfferNewFromBuyer** (55) | `offer_received` | `{buyerName}`, `{listingTitle}`, `{amount}` |
| **OfferAcceptedBySellerToBuyer** (59) | `offer_accepted` | `{listingTitle}`, `{amount}` |
| **OfferRejectedBySellerToBuyer** (61) | `offer_declined` | `{listingTitle}`, `{amount}` |
| **OfferCounterFromSeller/Buyer** (57/58) | `offer_countered` | `{counterpartyName}`, `{listingTitle}`, `{amount}`, `{round}` |
| **OfferExpiredToBuyer/Seller** (67/68) | `offer_expired` | `{listingTitle}` |
| **ListingApproved** (8) | `listing_approved` | `{listingTitle}` — **also sends email** |
| **ListingRejected** (9) | `listing_rejected` | `{listingTitle}`, `{reason}` — **also sends email** |
| **ListingEditedByOperator** (11) | `listing_updated` | `{listingTitle}`, `{reason}` |
| **FollowedSellerNewListing** (17) | `followed_seller_new_listing` | `{sellerName}`, `{listingTitle}` |
| **WishlistPriceDrop** (14) | `price_drop_wishlist` | `{listingTitle}`, `{newPrice}` |
| **ListingNewComment** (18) | `listing_comment` | `{listingTitle}` |
| **ListingCommentReply** (19/20) | `comment_reply` | `{listingTitle}` |
| **NewMessage** (24) | `new_message` | `{senderName}` |
| **ReviewByOtherPartyPublished** (75) | `review_revealed` | `{otherPartyName}` |
| **ReviewReminder 24h/7d** (76/77) | `review_reminder` | `{listingTitle}`, `{daysLeft}` |
| **ReferralCreditEarned** (83) | `referral_credit_earned` | `{referredName}` |
| **AccountSuspended** (82) | `account_suspended` | `{reason}` |
| **WelcomeBackReturningUser** (85) | `welcome_back` | `{firstName}` only |

---

## 🟡 Copy-ready but NOT wired (builder exists, no trigger fires it)

The text builder is in code but nothing triggers it yet. Turning each on = adding a
trigger (+ a cron for the scheduled ones):

- **NewListingInYourSize** (16) — has `{category}`, `{listingTitle}`
- **ListingStale** (10) — `{listingTitle}`, `{N}` days
- **MilestoneAchieved** (81) — `{milestoneText}`
- **ReferralNudge** (84)
- **ReEngagementNudge** (86)
- **WeeklyDigest**
- **SellerRepliedToReview** (78) — `{sellerName}`

---

## ❌ Not built (in the sheet, no backend support)

- **Auth** — VerifyEmail, ResetPassword, PasswordChanged, VerifyChangedEmail,
  EmailChanged (1–7): handled by **Clerk / Supabase**, not this backend.
  `{verifyLink}` / `{resetLink}` originate there.
- **AbandonedCheckout** (25)
- **All disputes** (47–54)
- **Offer withdrawn / cap reached** (63, 64, 69, 70)
- **Wishlisted / wishlist milestone** (12, 13)
- **Comment mention / thread activity** (21, 22)
- **RefundProcessed** (44)
- **Shipping-time-expired** (45, 46)
- **Operator-action variants** (dispute/delivered/received/cancel confirmations to
  the counterparty) beyond the ones listed as sent above.

---

## Two caveats

1. **Email vs push.** `createNotification` sends **push + in-app**, and now also
   **email** for the six transactional **order-lifecycle** types (📧 rows above),
   via `src/lib/notification-email.ts` — always-send (receipts/refunds/payout, no
   opt-out). **listing approve/reject** and **welcome** also email (their own path).
   Everything else is push/in-app only for now.
   - **Admin override:** author an `email_templates` row in the Content suite with
     `key` = the notification type (e.g. `order_paid`) to replace the built-in copy.
     Merge tags: `{firstName} {listingTitle} {amount} {payout} {reason} {carrier}
     {trackingNumber} {orderNumber}`.
   - **Not yet emailing:** offer events (`offer_received`, etc. — need an offer-fetch
     variant) and engagement events (wishlist/price-drop — need an email preference).
2. **`{firstName}`** is the first word of `display_name`; missing name → generic
   greeting. `{payout}` is on `order_paid` + the seller `order_complete`. `{carrier}`
   is in the **email** for `order_shipped` (the **push** for it still carries only
   `{trackingNumber}`).
