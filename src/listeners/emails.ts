// ============================================================
// Email listeners (Phase 2.7)
//
// Currently the backend fires transactional emails via Resend from
// a handful of route handlers. Rather than enumerate and port every
// email flow (many live in email-templates.ts and are triggered by
// Clerk/Supabase webhooks, not domain events), we register the
// minimal set of listeners that make sense for events the service
// layer emits today.
//
// Future events can register additional handlers here; each one is
// best-effort and must never throw back to the emitter.
// ============================================================

import { on } from "../lib/events.js";
// Email helpers are fire-and-forget; we import sendEmail lazily only
// when a listener needs it to avoid pulling Resend into modules that
// don't use it.

export function registerEmailListeners(): void {
  // order:created -> buyer receipt. We do not have a stock
  // "order receipt" template in email-templates.ts yet; leaving the
  // handler registered as a no-op so future work can slot in the
  // Resend call without touching route code.
  on("order:created", async (_payload) => {
    // TODO: wire order receipt email once the template exists.
  });

  on("listing:approved", async (_payload) => {
    // TODO: listing approved email (template not yet authored).
  });

  on("listing:rejected", async (_payload) => {
    // TODO: listing rejected email.
  });

  on("user:signed_up", async (_payload) => {
    // Welcome email is currently triggered by the Clerk webhook in
    // routes/email-hooks.ts; nothing to do here yet.
  });
}
