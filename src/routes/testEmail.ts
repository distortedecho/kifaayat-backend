import { Hono } from "hono";
import { Resend } from "resend";

// ============================================================
// TEMPORARY diagnostic — verify the Resend email setup end-to-end.
// GET /api/test-email  → sends one email and returns the Resend result
// (id on success, or the real error object so 403 "domain not verified"
// etc. is visible). Recipient is HARD-CODED so this can't be abused to
// spam arbitrary addresses. Remove once email is confirmed working.
// ============================================================

const testEmail = new Hono();

const TEST_RECIPIENT = "arathi481@gmail.com";

testEmail.get("/", async (c) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "noreply@kifaayat.shop";
  if (!apiKey) {
    return c.json({ ok: false, error: "RESEND_API_KEY not set" }, 500);
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: TEST_RECIPIENT,
      subject: "Kifaayat test email ✅",
      html:
        `<p>This is a test email from the Kifaayat backend.</p>` +
        `<p>Sent from <b>${from}</b> at ${new Date().toISOString()}.</p>` +
        `<p>If you can read this, DKIM + SPF + DMARC on kifaayat.shop are working.</p>`,
    });

    if (error) {
      // Surface the real Resend error (e.g. 403 domain-not-verified).
      return c.json({ ok: false, from, to: TEST_RECIPIENT, error }, 502);
    }
    return c.json({ ok: true, from, to: TEST_RECIPIENT, id: data?.id });
  } catch (err) {
    return c.json(
      { ok: false, from, to: TEST_RECIPIENT, error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

export default testEmail;
