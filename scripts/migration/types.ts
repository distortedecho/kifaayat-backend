// ============================================================
// Sharetribe export record shapes
//
// Loose typing — Sharetribe public/private/protected data is
// effectively a free-form JSONB blob. We only assert the structural
// fields (id, type, attributes) and keep everything inside attributes
// as Record<string, unknown> so the importer reads through with
// explicit casts. This is intentional: prod data will have edge
// cases not present in the synthetic export, and over-typing here
// would hide them with type errors instead of letting us log + skip.
// ============================================================

export interface SharetribeRecord {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface SharetribeUser extends SharetribeRecord {
  type: "user";
  attributes: {
    createdAt: string;
    banned?: boolean;
    email: string;
    emailVerified?: boolean;
    stripeAccountId?: string | null;
    stripeCustomerId?: string | null;
    profile: {
      displayName?: string;
      firstName?: string;
      lastName?: string;
      bio?: string | null;
      avatar?: string | null;
      privateData?: {
        phonenumber?: number | string;
        notificationTokens?: string[];
        notificationSetting?: Record<string, unknown>;
      };
      protectedData?: Record<string, unknown>;
      publicData?: {
        user_type?: string[];
        user_country?: string;
        isotype?: string[];
        isosize?: string[];
        isocountry?: string[];
        isobudget?: string;
        isopersonalised?: string;
      };
      metadata?: {
        extId?: string | number;
        isAdmin?: boolean;
        stripeConnectVerified?: boolean;
        wishlist?: Record<string, boolean>;
        wishlistArray?: string[];
        userShare?: Record<string, number>;
      };
    };
  };
}

export interface SharetribeListing extends SharetribeRecord {
  type: "listing";
  attributes: {
    title: string;
    createdAt: string;
    state: "draft" | "pendingApproval" | "published" | "closed";
    author: string;
    images?: string[];
    description?: string;
    price?: { amount: number; currency: string };
    location?: { lat: number; lng: number };
    publicData?: Record<string, unknown>;
    metadata?: {
      extId?: string | number;
      numberOfLikes?: number;
      openCount?: number;
      shareCount?: number;
      likedByUserIds?: string[];
      shareBy?: Record<string, unknown>;
      Kifaayatvideo?: string;
      [key: string]: unknown;
    };
  };
}

export interface SharetribeTransaction extends SharetribeRecord {
  type: "transaction";
  attributes: {
    createdAt: string;
    lastTransitionedAt?: string;
    lastTransition: string;
    customerId: string;
    providerId: string;
    listingId: string;
    bookingId?: string | null;
    stockReservationId?: string | null;
    payinTotal?: { amount: number; currency: string } | null;
    payoutTotal?: { amount: number; currency: string } | null;
    lineItems?: Array<{
      code: string;
      percentage?: number | null;
      lineTotal: { amount: number; currency: string };
      reversal?: boolean;
      includeFor?: string[];
    }>;
    payIns?: Array<{
      id: string;
      amount: { amount: number; currency: string };
      stripeChargeId?: string | null;
      stripePaymentIntentId?: string | null;
      state: string;
    }>;
    payOuts?: Array<{
      id: string;
      amount: { amount: number; currency: string };
      stripeTransferId?: string | null;
      stripePayoutId?: string | null;
      stripeBalanceTxId?: string | null;
      state: string;
    }>;
    messages?: Array<{
      id: string;
      createdAt: string;
      content: string;
      sender: string;
    }>;
    customerProtectedData?: Record<string, unknown>;
    protectedData?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

export interface SharetribeReview extends SharetribeRecord {
  type: "review";
  attributes: {
    createdAt: string;
    type: "ofProvider" | "ofCustomer";
    state: string;
    rating: number;
    content: string;
    listingId: string;
    transactionId: string;
  };
}
