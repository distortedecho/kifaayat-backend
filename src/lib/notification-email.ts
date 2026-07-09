// ============================================================
// Notification → email bridge (transactional order lifecycle)
//
// When createNotification fires a transactional ORDER notification, this
// also sends the matching email. It's self-sufficient: given the
// notification's `data.order_id` + `role`, it fetches the order + listing +
// recipient and renders the email — so no trigger needs to change.
//
// Copy source: an admin-authored row in the Content-suite `email_templates`
// table (key = notification type) overrides the built-in default below.
// Transactional emails (receipts, dispatch, refunds, payout) always send —
// no opt-out. Engagement/offer emails are a later phase.
// ============================================================

import { createSupabaseAdmin } from "./supabase.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";

// Order-lifecycle types that also send an email (always-on, transactional).
const ORDER_EMAIL_TYPES = new Set([
  "order_paid",
  "order_accepted",
  "order_rejected",
  "order_shipped",
  "order_delivered",
  "order_complete",
]);

function firstNameOf(name?: string | null): string {
  return name ? name.trim().split(/\s+/)[0] || "there" : "there";
}

function money(cents?: number | null, currency?: string | null): string {
  if (cents == null) return "";
  const sym: Record<string, string> =
    { AUD: "A$", USD: "US$", NZD: "NZ$", CAD: "C$", GBP: "£" };
  return `${sym[currency || "AUD"] || `${currency} `}${(cents / 100).toFixed(2)}`;
}

interface Vars {
  firstName: string;
  listingTitle: string;
  amount: string;
  payout: string;
  orderNumber: string;
  reason: string;
  carrier: string;
  tracking: string;
  role: string;
}

/** Wrap body content in a minimal branded shell + sign-off. */
function shell(inner: string): string {
  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;line-height:1.55">` +
    inner +
    `<p style="margin-top:24px">Thanks,<br/>The Kifaayat team</p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>` +
    `<p style="font-size:12px;color:#888">Kifaayat — pre-loved South Asian fashion.</p>` +
    `</div>`
  );
}

/** Built-in default template per type (role-aware where needed). */
function builtIn(type: string, v: Vars): { subject: string; html: string } | null {
  const p = (s: string) => `<p>${s}</p>`;
  const hi = p(`Hi ${v.firstName},`);
  switch (type) {
    case "order_paid": // seller — you made a sale
      return {
        subject: `You made a sale: '${v.listingTitle}'`,
        html: shell(
          hi +
            p(`Great news — you've sold '${v.listingTitle}' for ${v.amount}.`) +
            p(`Please accept the order within 48 hours to confirm it. Once you ship, you'll earn your payout of ${v.payout}.`) +
            p(`Review and accept the order in the app.`)
        ),
      };
    case "order_accepted": // buyer
      return {
        subject: `Your order is confirmed`,
        html: shell(hi + p(`The seller accepted your order for '${v.listingTitle}' and is getting it ready to ship. We'll let you know as soon as it's on its way.`)),
      };
    case "order_rejected": // buyer — declined + refunded
      return {
        subject: `Your order was declined and refunded`,
        html: shell(
          hi +
            p(`Unfortunately your order for '${v.listingTitle}' was cancelled and a full refund of ${v.amount} is on its way back to your original payment method.`) +
            (v.reason ? p(`Reason: ${v.reason}`) : "") +
            p(`There's plenty more to discover — keep exploring.`)
        ),
      };
    case "order_shipped": // buyer — on its way
      return {
        subject: `Your order is on its way`,
        html: shell(
          hi +
            p(`Good news — your order for '${v.listingTitle}' has shipped.`) +
            (v.carrier ? p(`Carrier: ${v.carrier}`) : "") +
            (v.tracking ? p(`Tracking: ${v.tracking}`) : "") +
            p(`Once it arrives, please confirm receipt in the app so we can release payment to the seller.`)
        ),
      };
    case "order_delivered":
      return {
        subject: `Your order has been marked as delivered`,
        html: shell(hi + p(`The order for '${v.listingTitle}' has been marked as delivered. If everything looks right, no action is needed. If something seems off, please contact support.`)),
      };
    case "order_complete":
      if (v.role === "seller") {
        return {
          subject: `Sale complete — payout released`,
          html: shell(hi + p(`Your sale of '${v.listingTitle}' is complete. Your payout of ${v.payout} is now being released and will reach your account in 7–10 business days.`) + p(`Thanks for selling on Kifaayat.`)),
        };
      }
      return {
        subject: `Your order is complete`,
        html: shell(hi + p(`Your order for '${v.listingTitle}' is complete. We hope it's everything you hoped for.`) + p(`If you have a moment, leave the seller a review — it helps the whole community trade with confidence.`)),
      };
    default:
      return null;
  }
}

function substitute(str: string, vars: Record<string, string>): string {
  return str.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/**
 * Send the transactional email for an order notification, if applicable.
 * Fire-and-forget: logs on failure, never throws.
 */
export async function sendNotificationEmail(params: {
  userId: string;
  type: string;
  data?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    if (!ORDER_EMAIL_TYPES.has(params.type)) return;
    const orderId = params.data?.order_id as string | undefined;
    if (!orderId) return;

    const supabase = createSupabaseAdmin();
    const [orderRes, profileRes] = await Promise.all([
      supabase
        .from("orders")
        .select(
          "amount, seller_payout, currency, order_number, seller_rejection_reason, " +
            "shipping_carrier, shipping_tracking_number, listings!orders_listing_id_fkey(title)"
        )
        .eq("id", orderId)
        .single(),
      supabase
        .from("profiles")
        .select("email, display_name")
        .eq("id", params.userId)
        .single(),
    ]);

    const order = orderRes.data as Record<string, unknown> | null;
    const profile = profileRes.data as { email?: string; display_name?: string } | null;
    if (!order || !profile?.email) return;

    const listing = order.listings as Record<string, unknown> | null;
    const currency = (order.currency as string) || "AUD";
    const vars: Vars = {
      firstName: firstNameOf(profile.display_name),
      listingTitle: (listing?.title as string) || "your item",
      amount: money(order.amount as number, currency),
      payout: money(order.seller_payout as number, currency),
      orderNumber: (order.order_number as string) || "",
      reason: (order.seller_rejection_reason as string) || "",
      carrier: (order.shipping_carrier as string) || "",
      tracking: (order.shipping_tracking_number as string) || "",
      role: (params.data?.role as string) || "buyer",
    };

    // Admin override (Content suite) keyed by notification type, else built-in.
    const { data: tpl } = await supabase
      .from("email_templates")
      .select("subject, body")
      .eq("key", params.type)
      .maybeSingle();

    let subject: string;
    let html: string;
    if (tpl) {
      subject = substitute(tpl.subject as string, vars as unknown as Record<string, string>);
      html = substitute(tpl.body as string, vars as unknown as Record<string, string>);
    } else {
      const b = builtIn(params.type, vars);
      if (!b) return;
      subject = b.subject;
      html = b.html;
    }

    await sendEmail({ to: profile.email, subject, html });
  } catch (err) {
    logger.error("notification_email.failed", {
      type: params.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
