import { Hono } from "hono";
import { z } from "zod";
import { createClerkClient } from "@clerk/backend";
import { sendEmail } from "../lib/email.js";
import {
  welcomeEmail,
  orderConfirmationEmail,
  saleNotificationEmail,
  listingReviewEmail,
} from "../lib/email-templates.js";

const emailHooks = new Hono();

// ---------------------------------------------------------------------------
// Internal auth: shared secret header check
// ---------------------------------------------------------------------------

function verifyInternalSecret(secretHeader: string | undefined): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    console.warn(
      "[email-hooks] INTERNAL_API_SECRET not set — allowing all requests (dev mode)"
    );
    return true;
  }
  return secretHeader === expected;
}

// Middleware to check internal secret on all routes
emailHooks.use("*", async (c, next) => {
  const secret = c.req.header("X-Internal-Secret");
  if (!verifyInternalSecret(secret)) {
    return c.json({ error: "Unauthorized" }, 403);
  }
  await next();
});

// ---------------------------------------------------------------------------
// POST /api/email-hooks/welcome
// Called after user profile creation
// ---------------------------------------------------------------------------

const welcomeSchema = z.object({
  clerk_user_id: z.string().min(1),
  email: z.string().optional(), // optional — will look up via Clerk if empty
  display_name: z.string().optional(),
});

emailHooks.post("/welcome", async (c) => {
  const body = await c.req.json();
  const parsed = welcomeSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { sent: false, error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { clerk_user_id, display_name } = parsed.data;
  let email = parsed.data.email || "";
  let name = display_name || "";

  // Look up user email and name from Clerk if not provided
  if (!email || !name) {
    try {
      const clerk = createClerkClient({
        secretKey: process.env.CLERK_SECRET_KEY || "",
      });
      const user = await clerk.users.getUser(clerk_user_id);
      if (!email) {
        email = user.emailAddresses[0]?.emailAddress || "";
      }
      if (!name) {
        name = user.firstName || user.username || "there";
      }
    } catch (err) {
      console.error("[email-hooks] Failed to look up Clerk user:", err);
      return c.json({ sent: false, error: "Could not resolve user email" }, 500);
    }
  }

  if (!email) {
    return c.json({ sent: false, error: "No email address found" }, 400);
  }

  const template = welcomeEmail({ displayName: name });
  const result = await sendEmail({ to: email, ...template });

  return c.json({
    sent: !!result,
    email_id: result?.id || null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/email-hooks/order-confirmation
// Called after successful payment — sends to buyer
// ---------------------------------------------------------------------------

const orderConfirmationSchema = z.object({
  buyer_email: z.string().email(),
  buyer_name: z.string().min(1),
  listing_title: z.string().min(1),
  listing_photo_url: z.string().url(),
  price_display: z.string().min(1),
  order_id: z.string().min(1),
});

emailHooks.post("/order-confirmation", async (c) => {
  const body = await c.req.json();
  const parsed = orderConfirmationSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { sent: false, error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { buyer_email, buyer_name, listing_title, listing_photo_url, price_display, order_id } =
    parsed.data;

  const template = orderConfirmationEmail({
    buyerName: buyer_name,
    listingTitle: listing_title,
    listingPhotoUrl: listing_photo_url,
    priceDisplay: price_display,
    orderId: order_id,
  });

  const result = await sendEmail({ to: buyer_email, ...template });

  return c.json({
    sent: !!result,
    email_id: result?.id || null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/email-hooks/sale-notification
// Called after successful payment — sends to seller
// ---------------------------------------------------------------------------

const saleNotificationSchema = z.object({
  seller_email: z.string().email(),
  seller_name: z.string().min(1),
  listing_title: z.string().min(1),
  listing_photo_url: z.string().url(),
  price_display: z.string().min(1),
  order_id: z.string().min(1),
});

emailHooks.post("/sale-notification", async (c) => {
  const body = await c.req.json();
  const parsed = saleNotificationSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { sent: false, error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { seller_email, seller_name, listing_title, listing_photo_url, price_display, order_id } =
    parsed.data;

  const template = saleNotificationEmail({
    sellerName: seller_name,
    listingTitle: listing_title,
    listingPhotoUrl: listing_photo_url,
    priceDisplay: price_display,
    orderId: order_id,
  });

  const result = await sendEmail({ to: seller_email, ...template });

  return c.json({
    sent: !!result,
    email_id: result?.id || null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/email-hooks/listing-review
// Called after admin approves/rejects a listing
// ---------------------------------------------------------------------------

const listingReviewSchema = z.object({
  seller_email: z.string().email(),
  seller_name: z.string().min(1),
  listing_title: z.string().min(1),
  listing_photo_url: z.string().url().optional().or(z.literal("")),
  listing_id: z.string().min(1),
  approved: z.boolean(),
  rejection_reason: z.string().optional(),
});

emailHooks.post("/listing-review", async (c) => {
  const body = await c.req.json();
  const parsed = listingReviewSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { sent: false, error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const {
    seller_email,
    seller_name,
    listing_title,
    listing_photo_url,
    listing_id,
    approved,
    rejection_reason,
  } = parsed.data;

  const template = listingReviewEmail({
    sellerName: seller_name,
    listingTitle: listing_title,
    listingPhotoUrl: listing_photo_url,
    approved,
    rejectionReason: rejection_reason,
    listingId: listing_id,
  });

  const result = await sendEmail({ to: seller_email, ...template });

  return c.json({
    sent: !!result,
    email_id: result?.id || null,
  });
});

export default emailHooks;
