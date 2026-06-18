# Kifaayat — Push Notification Wordings

Complete list of every push notification the app sends, organised by
category. Use this to review wording, tone, and brand voice. Anything
in `{curly braces}` is filled in dynamically (item title, buyer name,
price, etc.) when the notification fires.

If you want to change any wording, mark it up directly on this doc
and send back — backend changes are quick.

---

## 🛒 Selling & Offers

### Offer Received
**When:** A buyer sends you an offer on your listing.
- **Title:** New Offer Received
- **Body:** {Buyer name} offered {price} for "{Listing title}"

### Offer Accepted
**When:** A seller accepts your offer.
- **Title:** Offer Accepted!
- **Body:** Your offer of {price} for "{Listing title}" was accepted. You have 24 hours to complete payment.

### Offer Declined
**When:** A seller declines your offer.
- **Title:** Offer Declined
- **Body:** Your offer of {price} for "{Listing title}" was declined.

### Counter-Offer Received
**When:** The other party counter-offers your offer.
- **Title:** Counter-Offer Received
- **Body:** {Name} countered with {price} for "{Listing title}" (Round {N} of {Max})

### Offer Expired
**When:** An offer expires without action.
- **Title:** Offer Expired
- **Body:** The offer on "{Listing title}" has expired.

### You Made a Sale (Order Paid)
**When:** A buyer pays for your listing.
- **Title:** You Made a Sale!
- **Body:** "{Listing title}" was purchased for {amount}. Ship it to earn {payout} (incl. {shipping} shipping).
- _Variant if no shipping:_ Ship it to earn {payout}.

---

## 📦 Order Lifecycle

### Order Accepted (buyer-facing)
**When:** The seller accepts your paid order.
- **Title:** Order Accepted!
- **Body:** The seller has accepted your order for "{Listing title}". It will be shipped soon.

### Order Cancelled / Rejected
**When:** Seller rejects or cancels your paid order.
- **Title:** Order Cancelled
- **Body:** Your order for "{Listing title}" was cancelled. Reason: {reason}. A refund has been issued.
- _Variant without reason:_ Your order for "{Listing title}" was cancelled and a refund has been issued.

### Your Order Has Shipped
**When:** Seller marks the order as shipped.
- **Title:** Your Order Has Shipped!
- **Body:** "{Listing title}" is on its way. Tracking: {tracking number}

### Order Delivered (seller-facing)
**When:** Buyer confirms delivery.
- **Title:** Order Delivered
- **Body:** "{Listing title}" has been delivered to the buyer.

### Order Complete — Seller
**When:** Buyer confirms receipt, payout released.
- **Title:** Sale Complete - Payout Released
- **Body:** Your sale of "{Listing title}" is complete. Payout of {amount} released.

### Order Complete — Buyer
**When:** You confirm receipt of the item.
- **Title:** Order Complete
- **Body:** Your order for "{Listing title}" is complete.

### Order Auto-Completed — Seller
**When:** No action taken; system auto-completes after 7 days.
- **Title:** Sale Auto-Completed - Payout Released
- **Body:** Sale of "{Listing title}" auto-completed. Payout of {amount} released.

### Order Auto-Completed — Buyer
**When:** Same as above, buyer-side.
- **Title:** Order Auto-Completed
- **Body:** Your order for "{Listing title}" has been automatically completed after 7 days.

---

## ⭐ Reviews

### Reviews are Revealed
**When:** Both parties leave reviews (or 14 days pass) — reviews unblind.
- **Title:** Reviews are in!
- **Body:** See what {Other party name} said about your transaction

### Review Reminder
**When:** A few days after order completion, reminding you to leave a review.
- **Title:** How was your experience?
- **Body:** Leave a review for "{Item title}" — {N} days left

### Seller Replied to Your Review
**When:** A seller publicly replies to a review you left.
- **Title:** {Seller name} replied to your review
- **Body:** See their response

---

## 📝 Listing Lifecycle

### Listing Approved
**When:** Admin approves your pending listing.
- **Title:** Listing Approved!
- **Body:** Your listing "{Listing title}" has been approved and is now live.

### Listing Needs Changes (Rejected)
**When:** Admin rejects your pending listing.
- **Title:** Listing Needs Changes
- **Body:** Your listing "{Listing title}" was not approved. Reason: {reason}

### Listing Needs Attention (Stale)
**When:** A listing has no activity for N days.
- **Title:** Your listing needs attention
- **Body:** "{Listing title}" hasn't had activity in {N} days. Consider adjusting the price.

### Boost Activated
**When:** A seller's paid boost goes live.
- **Title:** Boost Activated
- **Body:** Your listing boost is now active! It will appear at the top of search results.

### Boost Expiring (placeholder — no current message yet)
**When:** A few days before a boost ends.
- _No active wording — flag for client whether this should be implemented._

---

## 💬 Messages & Comments

### New Message
**When:** Someone sends you a chat message (post-purchase).
- **Title:** New message from {Sender name}
- **Body:** You have a new message. Tap to read.

### New Comment on Your Listing
**When:** A buyer leaves a public comment on your listing.
- **Title:** New comment on your listing
- **Body:** {Buyer name} commented on "{Listing title}"

### Seller Replied on a Listing
**When:** A seller replies to a comment thread on their listing.
- **Title:** Seller replied on a listing
- **Body:** {Seller name} replied on "{Listing title}"

### Comment Reply
**When:** Someone @replies to your comment.
- **Title:** {Name} replied to your comment
- **Body:** {Reply text snippet}

---

## 🎯 Discovery & Wishlist

### Price Drop Alert
**When:** A listing in your wishlist gets a price reduction.
- **Title:** Price Drop Alert!
- **Body:** "{Listing title}" is now {new price}

### New Matching Listing
**When:** A new listing matches your saved search.
- **Title:** New listing matches your search
- **Body:** Check out "{Listing title}"

### New Listing in Your Size
**When:** A listing in your usual size is posted in a category you browse.
- **Title:** New {Category} in your size
- **Body:** "{Listing title}" just listed and fits your measurements

### Followed Seller Listed Something New
**When:** A seller you follow posts a new listing.
- **Title:** {Seller name} listed something new
- **Body:** Check out "{Listing title}"

---

## 🔍 ISO (In Search Of)

### ISO Match Found
**When:** A new listing matches an ISO post you made.
- **Title:** New match for your ISO!
- **Body:** A listing matching "{Snippet of description}..." was found

### ISO Response Received
**When:** A seller responds to your ISO post directly.
- **Title:** {Seller name} has what you're looking for!
- **Body:** Someone responded to your ISO: "{Snippet}..."

### ISO Match (Alternative wording)
- **Title:** Match found for your ISO!
- **Body:** A listing matches your request: "{ISO title}"

---

## 🏆 Account & Tier Status

### Tier Upgraded
**When:** You qualify for a higher seller tier.
- **Title:** Congratulations! You're now a {Tier label}!
- **Body:** Your commission rate is now {N}%. Your listings are now auto-approved!

### Tier Downgraded
**When:** Activity drops; you move down a tier.
- **Title:** Your seller tier has changed
- **Body:** You've moved from {Previous tier} to {New tier}. Maintain your ratings and activity to regain your previous tier.

### Milestone Achieved
**When:** You hit a sales / activity milestone.
- **Title:** Milestone achieved!
- **Body:** {Custom milestone text — e.g. "You just made your 10th sale!"}

### Account Suspended
**When:** Admin suspends your account.
- **Title:** Account Suspended
- **Body:** Your account has been suspended: {reason}

---

## 🎁 Referrals & Vouchers

### Referral Credit Earned
**When:** Someone you referred makes their first purchase.
- **Title:** You received a new voucher!
- **Body:** {Referred name} made a purchase using your referral code. You've earned a new voucher!

### Referral Nudge
**When:** Periodically reminding active users to refer friends.
- **Title:** Share & earn $10
- **Body:** Invite a friend to Kifaayat. You both get $10 credit!

---

## 📬 Re-engagement / Lifecycle

### Welcome Back (Sharetribe Returning User)
**When:** A returning Sharetribe user signs up via Clerk and we successfully link their old data.
- **Title:** Welcome back, {First name}!
- _Variant if no name:_ Welcome back!
- **Body:** Your listings, wishlist, and reviews from the old app are all here. Pick up right where you left off.

### Weekly Digest
**When:** Weekly summary of activity.
- **Title:** Your weekly digest
- **Body:** {N} new listings this week. Your listings got {N} views.

### Re-engagement Nudge
**When:** User hasn't opened the app in a while.
- **Title:** We miss you!
- **Body:** New arrivals are waiting for you. Come take a look.

---

## Summary by category count

| Category | Number of notifications |
|---|---|
| Selling & Offers | 7 |
| Order Lifecycle | 8 |
| Reviews | 3 |
| Listing Lifecycle | 5 (1 placeholder) |
| Messages & Comments | 4 |
| Discovery & Wishlist | 4 |
| ISO | 3 |
| Account & Tier | 4 |
| Referrals | 2 |
| Re-engagement | 3 |
| **Total** | **~43 distinct notification types** |

---

## Notes for the client

- All wordings use **{curly brace placeholders}** for dynamic values — those are auto-filled by the backend.
- **Order of words matters for push notifications** — phones show the title in bold + body below. The title is what shows on the lock screen, so keeping it punchy is key.
- **Emoji policy**: currently no emojis are used in any title/body. Easy to add if you want them.
- **Tone today**: friendly + transactional. Mixes excitement (🎉 vibe like "You Made a Sale!", "Boost Activated") with informational ("Order Complete").
- If you want to change a wording, edit it directly in this doc and send back. Each one is one line in the codebase to update.
