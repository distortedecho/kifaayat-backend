// ============================================================
// Offer service (Phase 2.8)
//
// Extracts the accept / decline business logic out of routes/offers.ts
// so the route file can stay focused on HTTP concerns. Create and
// counter remain in the route file for now -- they are relatively
// thin and would require lifting substantial validation code for
// marginal benefit. When those grow we can extract them the same
// way.
//
// Side effects (notifications) are emitted as events; listeners
// in backend/src/listeners/ handle them asynchronously.
// ============================================================

import { createSupabaseAdmin } from "../lib/supabase.js";
import { emit } from "../lib/events.js";
import {
  type OfferStatus,
  ACCEPTED_OFFER_PAYMENT_HOURS,
} from "../types/transactions.js";
import { logger } from "../lib/logger.js";

export class OfferServiceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "OfferServiceError";
  }
}

interface ActorContext {
  profileId: string;
}

/**
 * Accept a pending offer. Updates status, reserves the listing,
 * and emits `offer:accepted` for notification dispatch.
 */
export async function acceptOffer(
  offerId: string,
  actor: ActorContext
): Promise<Record<string, unknown>> {
  const supabase = createSupabaseAdmin();

  const { data: offer, error: fetchError } = await supabase
    .from("offers")
    .select("*, listings!offers_listing_id_fkey(id, title, seller_id)")
    .eq("id", offerId)
    .single();
  if (fetchError || !offer) {
    throw new OfferServiceError("Offer not found", 404);
  }
  if (offer.status !== "pending") {
    throw new OfferServiceError("Offer is not pending", 400);
  }

  const isSeller = offer.seller_id === actor.profileId;
  const isBuyer = offer.buyer_id === actor.profileId;
  if (!isSeller && !isBuyer) {
    throw new OfferServiceError("Not authorized", 403);
  }
  const isOddRound = offer.round % 2 === 1;
  const recipientIsSeller = isOddRound;
  const userIsRecipient = recipientIsSeller ? isSeller : isBuyer;
  if (!userIsRecipient) {
    throw new OfferServiceError("Only the offer recipient can accept", 403);
  }

  const paymentDeadline = new Date();
  paymentDeadline.setHours(
    paymentDeadline.getHours() + ACCEPTED_OFFER_PAYMENT_HOURS
  );

  const { data: updatedOffer, error: updateError } = await supabase
    .from("offers")
    .update({
      status: "accepted" as OfferStatus,
      expires_at: paymentDeadline.toISOString(),
    })
    .eq("id", offerId)
    .select()
    .single();
  if (updateError || !updatedOffer) {
    logger.error("offerService.accept_failed", {
      offer_id: offerId,
      error: updateError?.message,
    });
    throw new OfferServiceError("Failed to accept offer", 500);
  }

  const listing = offer.listings as Record<string, unknown>;
  await supabase
    .from("listings")
    .update({ status: "reserved" })
    .eq("id", listing.id as string);

  const notifyUserId = isSeller ? offer.buyer_id : offer.seller_id;
  // If the caller is the seller, the recipient is the buyer (and vice versa).
  const recipientRole: "buyer" | "seller" = isSeller ? "buyer" : "seller";
  emit("offer:accepted", {
    offerId,
    listingId: offer.listing_id,
    listingTitle: listing.title as string,
    notifyUserId,
    recipientRole,
    amount: offer.amount,
    currency: offer.currency,
  });

  return updatedOffer;
}

/**
 * Decline a pending offer. Updates status and emits `offer:rejected`.
 */
export async function declineOffer(
  offerId: string,
  actor: ActorContext
): Promise<Record<string, unknown>> {
  const supabase = createSupabaseAdmin();

  const { data: offer, error: fetchError } = await supabase
    .from("offers")
    .select("*, listings!offers_listing_id_fkey(title)")
    .eq("id", offerId)
    .single();
  if (fetchError || !offer) {
    throw new OfferServiceError("Offer not found", 404);
  }
  if (offer.status !== "pending") {
    throw new OfferServiceError("Offer is not pending", 400);
  }

  const isSeller = offer.seller_id === actor.profileId;
  const isBuyer = offer.buyer_id === actor.profileId;
  if (!isSeller && !isBuyer) {
    throw new OfferServiceError("Not authorized", 403);
  }
  const isOddRound = offer.round % 2 === 1;
  const recipientIsSeller = isOddRound;
  const userIsRecipient = recipientIsSeller ? isSeller : isBuyer;
  if (!userIsRecipient) {
    throw new OfferServiceError("Only the offer recipient can decline", 403);
  }

  const { data: updatedOffer, error: updateError } = await supabase
    .from("offers")
    .update({ status: "declined" as OfferStatus })
    .eq("id", offerId)
    .select()
    .single();
  if (updateError || !updatedOffer) {
    logger.error("offerService.decline_failed", {
      offer_id: offerId,
      error: updateError?.message,
    });
    throw new OfferServiceError("Failed to decline offer", 500);
  }

  const listing = offer.listings as Record<string, unknown>;
  const notifyUserId = isSeller ? offer.buyer_id : offer.seller_id;
  const recipientRole: "buyer" | "seller" = isSeller ? "buyer" : "seller";
  emit("offer:rejected", {
    offerId,
    listingId: offer.listing_id,
    listingTitle: listing.title as string,
    notifyUserId,
    recipientRole,
    amount: offer.amount,
    currency: offer.currency,
  });

  return updatedOffer;
}
