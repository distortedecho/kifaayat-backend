/**
 * HTML email templates for Kifaayat transactional emails.
 * All templates return { subject, html } ready for sendEmail().
 */

const BRAND_COLOR = "#7c3aed";
const BRAND_COLOR_DARK = "#6d28d9";
const LIGHT_BG = "#f5f3ff";

/**
 * Shared responsive HTML email wrapper with Kifaayat branding.
 */
function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kifaayat</title>
</head>
<body style="margin:0;padding:0;background-color:${LIGHT_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${LIGHT_BG};">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND_COLOR};padding:24px 32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:700;letter-spacing:-0.5px;">Kifaayat</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">Preloved South Asian Fashion</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:32px 32px 24px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Kifaayat — Preloved South Asian Fashion</p>
              <p style="margin:0;color:#9ca3af;font-size:11px;">
                You received this email because of your Kifaayat account.
                <br>
                <a href="kifaayat://settings/notifications" style="color:#9ca3af;text-decoration:underline;">Manage email preferences</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * CTA button helper — large tap target, brand-colored.
 */
function ctaButton(text: string, href: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
  <tr>
    <td align="center">
      <a href="${href}" style="display:inline-block;background-color:${BRAND_COLOR};color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;min-width:180px;text-align:center;">
        ${text}
      </a>
    </td>
  </tr>
</table>`;
}

/**
 * Listing photo card helper — shows listing image with rounded corners.
 */
function listingPhotoCard(
  photoUrl: string,
  title: string,
  priceDisplay?: string
): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background-color:#f9fafb;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
  <tr>
    <td align="center" style="padding:16px;">
      <img src="${photoUrl}" alt="${title}" width="200" style="display:block;max-width:200px;width:100%;height:auto;border-radius:8px;object-fit:cover;" />
    </td>
  </tr>
  <tr>
    <td style="padding:0 16px 12px;text-align:center;">
      <p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#1f2937;">${title}</p>
      ${priceDisplay ? `<p style="margin:0;font-size:15px;color:${BRAND_COLOR};font-weight:600;">${priceDisplay}</p>` : ""}
    </td>
  </tr>
</table>`;
}

// ---------------------------------------------------------------------------
// Template functions
// ---------------------------------------------------------------------------

export function welcomeEmail(params: { displayName: string }): {
  subject: string;
  html: string;
} {
  const { displayName } = params;

  const subject = "Welcome to Kifaayat! \u{1F389}";

  const content = `
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">Hi ${displayName}!</h2>
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">
      Welcome to the Kifaayat community — your new home for preloved South Asian fashion.
    </p>
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">
      Whether you're here to find your next stunning lehenga or share pieces from your own collection, we're thrilled to have you. From bridal wear to everyday elegance, our community celebrates the beauty and craftsmanship of South Asian fashion.
    </p>
    <p style="margin:0 0 4px;color:#374151;font-size:15px;line-height:1.6;">
      Ready to explore?
    </p>
    ${ctaButton("Start Browsing", "kifaayat://home")}
  `;

  return { subject, html: emailWrapper(content) };
}

export function orderConfirmationEmail(params: {
  buyerName: string;
  listingTitle: string;
  listingPhotoUrl: string;
  priceDisplay: string;
  orderId: string;
}): { subject: string; html: string } {
  const { buyerName, listingTitle, listingPhotoUrl, priceDisplay, orderId } =
    params;

  const subject = `Your ${listingTitle} is on its way! \u{2728}`;

  const content = `
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">Order confirmed!</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
      Hi ${buyerName}, great taste! We've confirmed your order and notified the seller. They'll ship your beautiful piece soon!
    </p>
    ${listingPhotoCard(listingPhotoUrl, listingTitle, priceDisplay)}
    <p style="margin:16px 0 4px;color:#374151;font-size:15px;line-height:1.6;">
      You can track your order status in the app anytime.
    </p>
    ${ctaButton("View Your Order", `kifaayat://orders/${orderId}`)}
  `;

  return { subject, html: emailWrapper(content) };
}

export function saleNotificationEmail(params: {
  sellerName: string;
  listingTitle: string;
  listingPhotoUrl: string;
  priceDisplay: string;
  orderId: string;
}): { subject: string; html: string } {
  const { sellerName, listingTitle, listingPhotoUrl, priceDisplay, orderId } =
    params;

  const subject = `Congratulations! Your ${listingTitle} just sold! \u{1F38A}`;

  const content = `
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">You made a sale! \u{1F389}</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
      Great news, ${sellerName}! Someone loved your ${listingTitle} and snapped it up.
    </p>
    ${listingPhotoCard(listingPhotoUrl, listingTitle, priceDisplay)}
    <p style="margin:16px 0 4px;color:#374151;font-size:15px;line-height:1.6;">
      Please ship within 3 business days to keep your buyer happy. You can print a shipping label and mark it as shipped from the order page.
    </p>
    ${ctaButton("Ship Now", `kifaayat://orders/${orderId}`)}
  `;

  return { subject, html: emailWrapper(content) };
}

export function listingReviewEmail(params: {
  sellerName: string;
  listingTitle: string;
  listingPhotoUrl: string;
  approved: boolean;
  rejectionReason?: string;
  listingId: string;
}): { subject: string; html: string } {
  const {
    sellerName,
    listingTitle,
    listingPhotoUrl,
    approved,
    rejectionReason,
    listingId,
  } = params;

  if (approved) {
    const subject = `Your listing is live! \u{1F31F}`;

    const content = `
      <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">Your listing is approved!</h2>
      <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
        Hi ${sellerName}, your ${listingTitle} has been approved and is now visible to buyers. Time to celebrate!
      </p>
      ${listingPhotoCard(listingPhotoUrl, listingTitle)}
      <p style="margin:16px 0 4px;color:#374151;font-size:15px;line-height:1.6;">
        Share your listing with friends and family to get more visibility.
      </p>
      ${ctaButton("See Your Listing", `kifaayat://listing/${listingId}`)}
    `;

    return { subject, html: emailWrapper(content) };
  }

  // Rejected
  const subject = `About your listing — ${listingTitle}`;

  const content = `
    <h2 style="margin:0 0 16px;color:#1f2937;font-size:22px;">Listing update</h2>
    <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">
      Hi ${sellerName}, unfortunately your ${listingTitle} didn't meet our listing guidelines.
    </p>
    ${listingPhotoCard(listingPhotoUrl, listingTitle)}
    ${
      rejectionReason
        ? `<div style="margin:16px 0;padding:12px 16px;background-color:#fef2f2;border-left:4px solid #ef4444;border-radius:4px;">
        <p style="margin:0;color:#991b1b;font-size:14px;"><strong>Reason:</strong> ${rejectionReason}</p>
      </div>`
        : ""
    }
    <p style="margin:16px 0 4px;color:#374151;font-size:15px;line-height:1.6;">
      Don't worry — you can edit your listing and resubmit it for review.
    </p>
    ${ctaButton("Edit Listing", `kifaayat://listing/${listingId}/edit`)}
  `;

  return { subject, html: emailWrapper(content) };
}
