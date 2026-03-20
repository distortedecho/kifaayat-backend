import { Hono } from "hono";
import Stripe from "stripe";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { getSellerCommissionRate } from "../lib/commission.js";
import {
  createNotification,
  rentalRequestNotification,
  rentalConfirmedNotification,
  rentalDeclinedNotification,
  rentalShippedNotification,
  rentalReturnedNotification,
  rentalDepositReleasedNotification,
  rentalCompleteNotification,
  rentalDamageClaimNotification,
} from "../lib/notifications.js";
import {
  type RentalStatus,
  VALID_RENTAL_TRANSITIONS,
  RENTAL_MAX_DURATION_DAYS,
} from "../types/transactions.js";

// ============================================================
// Stripe lazy-init (duplicated from stripe.ts to avoid circular dep)
// ============================================================

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _stripe = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  }
  return _stripe;
}

// ============================================================
// Price calculation (pure function, exported for mobile reuse)
// ============================================================

export function calculateRentalPrice(
  days: number,
  rates: { daily_1_3: number; daily_4_7: number; daily_8_14: number },
  cleaningFee: number,
  securityDeposit: number
): {
  dailyRate: number;
  rentalSubtotal: number;
  cleaningFee: number;
  totalCharged: number;
  depositHeld: number;
  tier: "1-3" | "4-7" | "8-14";
} {
  let dailyRate: number;
  let tier: "1-3" | "4-7" | "8-14";

  if (days <= 3) {
    dailyRate = rates.daily_1_3;
    tier = "1-3";
  } else if (days <= 7) {
    dailyRate = rates.daily_4_7;
    tier = "4-7";
  } else {
    dailyRate = rates.daily_8_14;
    tier = "8-14";
  }

  const rentalSubtotal = dailyRate * days;
  const totalCharged = rentalSubtotal + cleaningFee;

  return {
    dailyRate,
    rentalSubtotal,
    cleaningFee,
    totalCharged,
    depositHeld: securityDeposit,
    tier,
  };
}

// ============================================================
// Zod Schemas
// ============================================================

const bookingSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date must be YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be YYYY-MM-DD"),
  payment_method_id: z.string().min(1, "payment_method_id is required"),
});

const shipSchema = z.object({
  tracking_number: z.string().min(1, "tracking_number is required"),
});

const returnSchema = z.object({
  tracking_number: z.string().min(1, "tracking_number is required"),
});

const inspectSchema = z.object({
  condition: z.literal("ok"),
});

const claimSchema = z.object({
  description: z.string().min(1, "description is required"),
  photos: z.array(z.string().url()).min(1, "At least one photo is required"),
});

const blackoutSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start_date must be YYYY-MM-DD"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end_date must be YYYY-MM-DD"),
  reason: z.string().optional(),
});

// ============================================================
// Helpers
// ============================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Terminal statuses that don't block date availability */
const TERMINAL_STATUSES: RentalStatus[] = ["complete", "declined", "cancelled"];

/** Validate a status transition against the state machine */
function validateTransition(
  current: RentalStatus,
  next: RentalStatus
): boolean {
  const allowed = VALID_RENTAL_TRANSITIONS[current];
  return allowed?.includes(next) ?? false;
}

/** Calculate number of days between two YYYY-MM-DD date strings (inclusive) */
function daysBetween(startDate: string, endDate: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}

/** Get or create a Stripe customer for a user */
async function getOrCreateStripeCustomer(
  profileId: string
): Promise<string> {
  const supabase = createSupabaseAdmin();

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_customer_id, display_name")
    .eq("id", profileId)
    .single();

  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  // Create a new Stripe customer
  const customer = await getStripe().customers.create({
    metadata: { kifaayat_profile_id: profileId },
    name: profile?.display_name || undefined,
  });

  // Store customer ID on profile
  await supabase
    .from("profiles")
    .update({ stripe_customer_id: customer.id })
    .eq("id", profileId);

  return customer.id;
}

// ============================================================
// Routes
// ============================================================

const rentals = new Hono();

// a. GET /availability/:listing_id (public)
rentals.get("/availability/:listing_id", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("listing_id");
  if (!UUID_REGEX.test(listingId)) {
    return c.json({ error: "Invalid listing_id" }, 400);
  }

  const supabase = createSupabaseAdmin();
  const now = new Date();
  const ninetyDaysLater = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split("T")[0];
  const futureStr = ninetyDaysLater.toISOString().split("T")[0];

  // Get non-terminal bookings overlapping next 90 days
  const { data: bookings, error: bookingsError } = await supabase
    .from("rental_bookings")
    .select("start_date, end_date")
    .eq("listing_id", listingId)
    .not("status", "in", `(${TERMINAL_STATUSES.join(",")})`)
    .lte("start_date", futureStr)
    .gte("end_date", todayStr);

  if (bookingsError) {
    console.error("Error fetching rental bookings:", bookingsError);
    return c.json({ error: "Failed to fetch availability" }, 500);
  }

  // Get blackout dates
  const { data: blackouts, error: blackoutsError } = await supabase
    .from("rental_blackouts")
    .select("start_date, end_date")
    .eq("listing_id", listingId)
    .lte("start_date", futureStr)
    .gte("end_date", todayStr);

  if (blackoutsError) {
    console.error("Error fetching blackouts:", blackoutsError);
    return c.json({ error: "Failed to fetch availability" }, 500);
  }

  return c.json({
    booked_dates: (bookings || []).map((b) => ({
      start_date: b.start_date,
      end_date: b.end_date,
    })),
    blackout_dates: (blackouts || []).map((b) => ({
      start_date: b.start_date,
      end_date: b.end_date,
    })),
  });
});

// b. POST /book (requireProfile)
rentals.post("/book", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = bookingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, start_date, end_date, payment_method_id } = parsed.data;

  // Verify listing exists and is rentable
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select(
      "id, seller_id, is_rentable, title, rental_daily_rate, rental_4to7_rate, rental_8to14_rate, rental_security_deposit, rental_cleaning_fee"
    )
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (!listing.is_rentable) {
    return c.json({ error: "This listing is not available for rental" }, 400);
  }

  if (listing.seller_id === profile.id) {
    return c.json({ error: "You cannot rent your own listing" }, 400);
  }

  // Calculate duration
  const days = daysBetween(start_date, end_date);
  if (days < 1 || days > RENTAL_MAX_DURATION_DAYS) {
    return c.json(
      { error: `Rental duration must be between 1 and ${RENTAL_MAX_DURATION_DAYS} days` },
      400
    );
  }

  // Validate start_date is in the future
  const today = new Date().toISOString().split("T")[0];
  if (start_date < today) {
    return c.json({ error: "Start date must be today or in the future" }, 400);
  }

  // Calculate pricing
  const rates = {
    daily_1_3: listing.rental_daily_rate || 0,
    daily_4_7: listing.rental_4to7_rate || listing.rental_daily_rate || 0,
    daily_8_14: listing.rental_8to14_rate || listing.rental_daily_rate || 0,
  };
  const cleaningFee = listing.rental_cleaning_fee || 0;
  const securityDeposit = listing.rental_security_deposit || 0;

  const pricing = calculateRentalPrice(days, rates, cleaningFee, securityDeposit);

  // Check no overlapping confirmed/pending bookings
  const { data: overlapping } = await supabase
    .from("rental_bookings")
    .select("id")
    .eq("listing_id", listing_id)
    .not("status", "in", `(${TERMINAL_STATUSES.join(",")})`)
    .lte("start_date", end_date)
    .gte("end_date", start_date)
    .limit(1);

  if (overlapping && overlapping.length > 0) {
    return c.json({ error: "These dates overlap with an existing booking" }, 409);
  }

  // Check no overlapping blackout dates
  const { data: overlappingBlackouts } = await supabase
    .from("rental_blackouts")
    .select("id")
    .eq("listing_id", listing_id)
    .lte("start_date", end_date)
    .gte("end_date", start_date)
    .limit(1);

  if (overlappingBlackouts && overlappingBlackouts.length > 0) {
    return c.json({ error: "These dates fall within a blackout period" }, 409);
  }

  // Create Stripe SetupIntent to validate the renter's card
  let setupIntent: Stripe.SetupIntent;
  try {
    const stripeCustomerId = await getOrCreateStripeCustomer(profile.id);

    setupIntent = await getStripe().setupIntents.create({
      payment_method: payment_method_id,
      confirm: true,
      usage: "off_session",
      customer: stripeCustomerId,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });
  } catch (stripeError) {
    console.error("Error creating SetupIntent:", stripeError);
    return c.json({ error: "Failed to validate payment method" }, 400);
  }

  // Insert rental booking
  const { data: booking, error: bookingError } = await supabase
    .from("rental_bookings")
    .insert({
      listing_id,
      renter_id: profile.id,
      lender_id: listing.seller_id,
      start_date,
      end_date,
      daily_rate: pricing.dailyRate,
      total_rental_amount: pricing.rentalSubtotal,
      cleaning_fee: pricing.cleaningFee,
      security_deposit: securityDeposit,
      status: "pending_confirmation" as const,
      stripe_setup_intent_id: setupIntent.id,
      stripe_payment_method_id: payment_method_id,
    })
    .select()
    .single();

  if (bookingError) {
    console.error("Error creating rental booking:", bookingError);
    return c.json({ error: "Failed to create booking" }, 500);
  }

  // Notify lender
  const template = rentalRequestNotification(
    profile.display_name || "A user",
    listing.title,
    start_date,
    end_date
  );
  await createNotification({
    user_id: listing.seller_id,
    type: "rental_request",
    ...template,
    data: { rental_booking_id: booking.id, listing_id },
  });

  return c.json({
    ...booking,
    client_secret: setupIntent.client_secret,
    pricing,
  }, 201);
});

// c. GET /my (requireProfile)
rentals.get("/my", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const role = c.req.query("role") || "renter";
  const statusFilter = c.req.query("status") || "all";

  let query = supabase
    .from("rental_bookings")
    .select(
      "*, listings:listing_id(title, listing_photos(url, position))"
    )
    .order("created_at", { ascending: false });

  if (role === "lender") {
    query = query.eq("lender_id", profile.id);
  } else {
    query = query.eq("renter_id", profile.id);
  }

  if (statusFilter === "active") {
    query = query.not("status", "in", `(${TERMINAL_STATUSES.join(",")})`);
  } else if (statusFilter === "completed") {
    query = query.in("status", TERMINAL_STATUSES);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Error fetching rentals:", error);
    return c.json({ error: "Failed to fetch rentals" }, 500);
  }

  // Map listing data for response
  const rentalsWithListings = (data || []).map((rental: Record<string, unknown>) => {
    const listings = rental.listings as Record<string, unknown> | null;
    const photos = listings?.listing_photos as Array<Record<string, unknown>> | null;
    let coverPhoto: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverPhoto = (cover.url as string) || null;
    }
    return {
      ...rental,
      listing_title: listings?.title || null,
      listing_cover_photo: coverPhoto,
      listings: undefined,
    };
  });

  return c.json({ rentals: rentalsWithListings });
});

// d. GET /:id (requireProfile)
rentals.get("/:id", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error } = await supabase
    .from("rental_bookings")
    .select("*, listings:listing_id(title, seller_id, listing_photos(url, position))")
    .eq("id", bookingId)
    .single();

  if (error || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  // Verify user is renter or lender
  if (booking.renter_id !== profile.id && booking.lender_id !== profile.id) {
    return c.json({ error: "Not authorized to view this booking" }, 403);
  }

  const listings = booking.listings as Record<string, unknown> | null;
  const photos = listings?.listing_photos as Array<Record<string, unknown>> | null;
  let coverPhoto: string | null = null;
  if (photos && photos.length > 0) {
    const cover = photos.find((p) => p.position === 0) || photos[0];
    coverPhoto = (cover.url as string) || null;
  }
  return c.json({
    ...booking,
    listing_title: listings?.title || null,
    listing_cover_photo: coverPhoto,
    listings: undefined,
  });
});

// e. PATCH /:id/confirm (lender only)
rentals.patch("/:id/confirm", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.lender_id !== profile.id) {
    return c.json({ error: "Only the lender can confirm a booking" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "confirmed")) {
    return c.json({ error: `Cannot confirm a booking with status '${booking.status}'` }, 400);
  }

  if (!booking.stripe_payment_method_id) {
    return c.json({ error: "No payment method on file for this booking" }, 400);
  }

  // Get renter's Stripe customer ID
  const renterCustomerId = await getOrCreateStripeCustomer(booking.renter_id);

  // Get lender's Stripe Connect account
  const { data: lenderProfile } = await supabase
    .from("profiles")
    .select("stripe_account_id, stripe_onboarding_complete")
    .eq("id", booking.lender_id)
    .single();

  if (!lenderProfile?.stripe_account_id || !lenderProfile?.stripe_onboarding_complete) {
    return c.json({ error: "Lender has not completed Stripe setup" }, 400);
  }

  // Calculate commission on rental amount only
  const commissionRate = await getSellerCommissionRate(booking.lender_id);
  const rentalChargeAmount = booking.total_rental_amount + booking.cleaning_fee;
  const applicationFee = Math.round(booking.total_rental_amount * commissionRate / 100);

  let rentalPI: Stripe.PaymentIntent;
  let depositPI: Stripe.PaymentIntent | null = null;

  try {
    // Create rental PaymentIntent (auto-capture, Destination Charges)
    rentalPI = await getStripe().paymentIntents.create({
      amount: rentalChargeAmount,
      currency: "aud",
      payment_method: booking.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      customer: renterCustomerId,
      application_fee_amount: applicationFee,
      transfer_data: {
        destination: lenderProfile.stripe_account_id,
      },
      metadata: {
        rental_booking_id: booking.id,
        type: "rental_charge",
      },
    });
  } catch (stripeError) {
    console.error("Error creating rental PaymentIntent:", stripeError);
    return c.json({ error: "Failed to charge rental amount" }, 500);
  }

  // Create deposit PaymentIntent (manual capture, extended auth)
  if (booking.security_deposit > 0) {
    try {
      depositPI = await getStripe().paymentIntents.create({
        amount: booking.security_deposit,
        currency: "aud",
        payment_method: booking.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        customer: renterCustomerId,
        capture_method: "manual",
        payment_method_options: {
          card: {
            request_extended_authorization: "if_available",
          },
        },
        metadata: {
          rental_booking_id: booking.id,
          type: "rental_deposit",
        },
      });
    } catch (stripeError) {
      console.error("Error creating deposit PaymentIntent:", stripeError);
      // Rental charge already succeeded -- log for manual resolution
      // Continue to confirm the booking
    }
  }

  // Update booking status
  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "confirmed",
      stripe_payment_intent_id: rentalPI.id,
      stripe_deposit_payment_intent_id: depositPI?.id || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating booking:", updateError);
    return c.json({ error: "Failed to update booking" }, 500);
  }

  // Fetch listing title for notification
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify renter
  const template = rentalConfirmedNotification(
    listing?.title || "Item",
    booking.start_date,
    booking.end_date
  );
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_confirmed",
    ...template,
    data: { rental_booking_id: booking.id },
  });

  return c.json(updated);
});

// f. PATCH /:id/decline (lender only)
rentals.patch("/:id/decline", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.lender_id !== profile.id) {
    return c.json({ error: "Only the lender can decline a booking" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "declined")) {
    return c.json({ error: `Cannot decline a booking with status '${booking.status}'` }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "declined",
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error declining booking:", updateError);
    return c.json({ error: "Failed to decline booking" }, 500);
  }

  // Fetch listing title for notification
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify renter
  const template = rentalDeclinedNotification(listing?.title || "Item");
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_declined",
    ...template,
    data: { rental_booking_id: booking.id },
  });

  return c.json(updated);
});

// g. PATCH /:id/ship (lender only)
rentals.patch("/:id/ship", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const body = await c.req.json();
  const parsed = shipSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.lender_id !== profile.id) {
    return c.json({ error: "Only the lender can mark as shipped" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "shipped")) {
    return c.json({ error: `Cannot ship a booking with status '${booking.status}'` }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "shipped",
      shipping_tracking_number: parsed.data.tracking_number,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating booking:", updateError);
    return c.json({ error: "Failed to update booking" }, 500);
  }

  // Fetch listing title for notification
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify renter
  const template = rentalShippedNotification(
    listing?.title || "Item",
    parsed.data.tracking_number
  );
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_shipped",
    ...template,
    data: {
      rental_booking_id: booking.id,
      tracking_number: parsed.data.tracking_number,
    },
  });

  return c.json(updated);
});

// h. PATCH /:id/return (renter only)
rentals.patch("/:id/return", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const body = await c.req.json();
  const parsed = returnSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.renter_id !== profile.id) {
    return c.json({ error: "Only the renter can mark as returned" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "returned")) {
    return c.json({ error: `Cannot return a booking with status '${booking.status}'` }, 400);
  }

  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "returned",
      return_tracking_number: parsed.data.tracking_number,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating booking:", updateError);
    return c.json({ error: "Failed to update booking" }, 500);
  }

  // Fetch listing title for notification
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify lender
  const template = rentalReturnedNotification(listing?.title || "Item");
  await createNotification({
    user_id: booking.lender_id,
    type: "rental_returned",
    ...template,
    data: {
      rental_booking_id: booking.id,
      tracking_number: parsed.data.tracking_number,
    },
  });

  return c.json(updated);
});

// i. PATCH /:id/inspect (lender only) -- condition OK, release deposit
rentals.patch("/:id/inspect", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const body = await c.req.json();
  const parsed = inspectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.lender_id !== profile.id) {
    return c.json({ error: "Only the lender can inspect" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "inspected")) {
    return c.json({ error: `Cannot inspect a booking with status '${booking.status}'` }, 400);
  }

  // Cancel deposit PI to release hold
  if (booking.stripe_deposit_payment_intent_id && !booking.deposit_released) {
    try {
      await getStripe().paymentIntents.cancel(booking.stripe_deposit_payment_intent_id);
    } catch (stripeError) {
      console.error("Error cancelling deposit PI:", stripeError);
      // Log but continue -- deposit may have already expired
    }
  }

  // Transition to inspected, then immediately to complete
  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "complete",
      deposit_released: true,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating booking:", updateError);
    return c.json({ error: "Failed to update booking" }, 500);
  }

  // Fetch listing title for notifications
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify renter -- deposit released
  const depositTemplate = rentalDepositReleasedNotification(
    booking.security_deposit,
    "AUD"
  );
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_deposit_released",
    ...depositTemplate,
    data: { rental_booking_id: booking.id },
  });

  // Notify both -- rental complete
  const completeTemplate = rentalCompleteNotification(listing?.title || "Item");
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_complete",
    ...completeTemplate,
    data: { rental_booking_id: booking.id },
  });
  await createNotification({
    user_id: booking.lender_id,
    type: "rental_complete",
    ...completeTemplate,
    data: { rental_booking_id: booking.id },
  });

  return c.json(updated);
});

// j. PATCH /:id/claim (lender only) -- file damage claim
rentals.patch("/:id/claim", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const bookingId = c.req.param("id");

  if (!UUID_REGEX.test(bookingId)) {
    return c.json({ error: "Invalid booking id" }, 400);
  }

  const body = await c.req.json();
  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const supabase = createSupabaseAdmin();

  const { data: booking, error: fetchError } = await supabase
    .from("rental_bookings")
    .select("*")
    .eq("id", bookingId)
    .single();

  if (fetchError || !booking) {
    return c.json({ error: "Booking not found" }, 404);
  }

  if (booking.lender_id !== profile.id) {
    return c.json({ error: "Only the lender can file a claim" }, 403);
  }

  if (!validateTransition(booking.status as RentalStatus, "inspected")) {
    return c.json({ error: `Cannot file claim for a booking with status '${booking.status}'` }, 400);
  }

  // Transition to inspected with claim details (stays at inspected until admin resolves)
  const { data: updated, error: updateError } = await supabase
    .from("rental_bookings")
    .update({
      status: "inspected",
      damage_claim_description: parsed.data.description,
      damage_claim_photos: parsed.data.photos,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bookingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating booking:", updateError);
    return c.json({ error: "Failed to file claim" }, 500);
  }

  // Fetch listing title for notification
  const { data: listing } = await supabase
    .from("listings")
    .select("title")
    .eq("id", booking.listing_id)
    .single();

  // Notify renter about damage claim
  const template = rentalDamageClaimNotification(listing?.title || "Item");
  await createNotification({
    user_id: booking.renter_id,
    type: "rental_damage_claim",
    ...template,
    data: { rental_booking_id: booking.id },
  });

  return c.json(updated);
});

// k. POST /blackouts (listing owner only)
rentals.post("/blackouts", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = blackoutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, start_date, end_date, reason } = parsed.data;

  // Verify listing ownership
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to manage blackouts for this listing" }, 403);
  }

  // Check no overlap with confirmed bookings
  const { data: overlapping } = await supabase
    .from("rental_bookings")
    .select("id")
    .eq("listing_id", listing_id)
    .in("status", ["confirmed", "shipped", "in_use", "return_due"])
    .lte("start_date", end_date)
    .gte("end_date", start_date)
    .limit(1);

  if (overlapping && overlapping.length > 0) {
    return c.json({ error: "Cannot create blackout overlapping with active bookings" }, 409);
  }

  const { data: blackout, error: insertError } = await supabase
    .from("rental_blackouts")
    .insert({
      listing_id,
      start_date,
      end_date,
      reason: reason || null,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating blackout:", insertError);
    return c.json({ error: "Failed to create blackout" }, 500);
  }

  return c.json(blackout, 201);
});

// l. DELETE /blackouts/:id (listing owner only)
rentals.delete("/blackouts/:id", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const blackoutId = c.req.param("id");

  if (!UUID_REGEX.test(blackoutId)) {
    return c.json({ error: "Invalid blackout id" }, 400);
  }

  const supabase = createSupabaseAdmin();

  // Fetch blackout
  const { data: blackout, error: fetchError } = await supabase
    .from("rental_blackouts")
    .select("id, listing_id")
    .eq("id", blackoutId)
    .single();

  if (fetchError || !blackout) {
    return c.json({ error: "Blackout not found" }, 404);
  }

  // Verify listing ownership
  const { data: listing } = await supabase
    .from("listings")
    .select("seller_id")
    .eq("id", blackout.listing_id)
    .single();

  if (!listing || listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to delete this blackout" }, 403);
  }

  const { error: deleteError } = await supabase
    .from("rental_blackouts")
    .delete()
    .eq("id", blackoutId);

  if (deleteError) {
    console.error("Error deleting blackout:", deleteError);
    return c.json({ error: "Failed to delete blackout" }, 500);
  }

  return c.body(null, 204);
});

// m. GET /blackouts/:listing_id (listing owner only)
rentals.get("/blackouts/:listing_id", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const listingId = c.req.param("listing_id");

  if (!UUID_REGEX.test(listingId)) {
    return c.json({ error: "Invalid listing_id" }, 400);
  }

  const supabase = createSupabaseAdmin();

  // Verify listing ownership
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to view blackouts for this listing" }, 403);
  }

  const { data: blackouts, error: fetchError } = await supabase
    .from("rental_blackouts")
    .select("*")
    .eq("listing_id", listingId)
    .order("start_date", { ascending: true });

  if (fetchError) {
    console.error("Error fetching blackouts:", fetchError);
    return c.json({ error: "Failed to fetch blackouts" }, 500);
  }

  return c.json({ blackouts: blackouts || [] });
});

export default rentals;
