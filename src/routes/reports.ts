import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const reports = new Hono();

// Zod validation schema
const createReportSchema = z.object({
  target_type: z.enum(["listing", "user"]),
  target_id: z.string().uuid("target_id must be a valid UUID"),
  category: z.enum([
    "counterfeit",
    "prohibited",
    "misleading",
    "inappropriate",
    "spam",
    "other",
  ]),
  details: z.string().max(500, "Details must be 500 characters or less").optional(),
});

/**
 * POST /api/reports
 * Submit a report for a listing or user.
 * Prevents duplicate pending reports from the same reporter for the same target.
 */
reports.post("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createReportSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { target_type, target_id, category, details } = parsed.data;

  // Resolve clerkUserId to profile.id
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("clerk_id", clerkUserId)
    .single();

  if (profileError || !profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Rate limit: check if reporter already has a pending report for this exact target
  const { data: existingReport } = await supabase
    .from("reports")
    .select("id")
    .eq("reporter_id", profile.id)
    .eq("target_type", target_type)
    .eq("target_id", target_id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingReport) {
    return c.json(
      { error: "You have already reported this. We're reviewing it." },
      409
    );
  }

  // Insert report
  const { data: report, error: insertError } = await supabase
    .from("reports")
    .insert({
      reporter_id: profile.id,
      target_type,
      target_id,
      category,
      details: details || null,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("Error creating report:", insertError);
    return c.json({ error: "Failed to submit report" }, 500);
  }

  return c.json({ success: true, report_id: report.id }, 201);
});

export default reports;
