import { Resend } from "resend";

let resend: Resend | null = null;

function getResendClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "[email] RESEND_API_KEY not set — emails will not be sent (dev mode)"
    );
    return null;
  }
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email via Resend.
 * Fire-and-forget: logs errors but never throws. Returns null on failure.
 */
export async function sendEmail(
  params: SendEmailParams
): Promise<{ id: string } | null> {
  const client = getResendClient();
  if (!client) {
    return null;
  }

  const from =
    process.env.RESEND_FROM_EMAIL || "Kifaayat <hello@kifaayat.app>";

  try {
    const { data, error } = await client.emails.send({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });

    if (error) {
      console.error("[email] Resend API error:", error);
      return null;
    }

    console.log(`[email] Sent to ${params.to}: ${params.subject} (${data?.id})`);
    return data ? { id: data.id } : null;
  } catch (err) {
    console.error("[email] Failed to send email:", err);
    return null;
  }
}
