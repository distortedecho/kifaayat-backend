import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const profiles = new Hono();

// Zod schema for profile updates
const updateProfileSchema = z.object({
  display_name: z
    .string()
    .max(50, "Display name must be 50 characters or less")
    .optional(),
  avatar_url: z.string().url("Must be a valid URL").optional(),
  location: z.enum(["AU", "US", "NZ"]).optional(),
  currency: z.enum(["AUD", "USD", "NZD"]).optional(),
  size_preferences: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      garment_length: z.string().optional(),
      sleeve_length: z.string().optional(),
      clothing_size: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(
      z.enum([
        "Wedding",
        "Mehendi",
        "Sangeet",
        "Festive",
        "Party",
        "Formal",
        "Casual",
      ])
    )
    .optional(),
  onesignal_player_id: z.string().optional(),
});

/**
 * GET /api/profiles/me
 * Returns the current user's profile. Creates one if it doesn't exist.
 */
profiles.get("/me", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Try to find existing profile
  const { data: profile, error: selectError } = await supabase
    .from("profiles")
    .select("*")
    .eq("clerk_id", clerkUserId)
    .single();

  if (selectError && selectError.code !== "PGRST116") {
    // PGRST116 = "not found" — any other error is unexpected
    console.error("Error fetching profile:", selectError);
    return c.json({ error: "Failed to fetch profile" }, 500);
  }

  if (profile) {
    return c.json({ profile });
  }

  // Profile doesn't exist — create one
  const { data: newProfile, error: insertError } = await supabase
    .from("profiles")
    .insert({ clerk_id: clerkUserId })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating profile:", insertError);
    return c.json({ error: "Failed to create profile" }, 500);
  }

  // Fire-and-forget welcome email (don't await, don't block profile creation)
  // The welcome hook looks up the user's email via Clerk backend SDK
  fetch(`http://localhost:${process.env.PORT || 3001}/api/email-hooks/welcome`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
    },
    body: JSON.stringify({
      clerk_user_id: clerkUserId,
    }),
  }).catch(() => {
    // Intentionally swallowed — welcome email is best-effort
  });

  return c.json({ profile: newProfile }, 201);
});

/**
 * PUT /api/profiles/me
 * Updates the current user's profile fields.
 */
profiles.put("/me", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Parse and validate request body
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        error: "Validation failed",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const updateData = parsed.data;

  // Check if profile is complete (all required fields present)
  // Required for selling: display_name, avatar_url, location, size_preferences
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("*")
    .eq("clerk_id", clerkUserId)
    .single();

  if (!existingProfile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  // Merge existing data with updates to check completeness
  const merged = { ...existingProfile, ...updateData };
  const profileComplete =
    !!merged.display_name &&
    !!merged.avatar_url &&
    !!merged.location &&
    merged.size_preferences !== null &&
    Object.keys(merged.size_preferences as Record<string, unknown>).length > 0;

  const { data: updatedProfile, error: updateError } = await supabase
    .from("profiles")
    .update({
      ...updateData,
      profile_complete: profileComplete,
    })
    .eq("clerk_id", clerkUserId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating profile:", updateError);
    return c.json({ error: "Failed to update profile" }, 500);
  }

  return c.json({ profile: updatedProfile });
});

/**
 * GET /api/profiles/:id
 * Returns a public profile by UUID. Only visible if profile_complete is true.
 * Optionally authenticated (guests can view public profiles).
 */
profiles.get("/:id", optionalClerkMiddleware, async (c) => {
  const profileId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(profileId)) {
    return c.json({ error: "Invalid profile ID format" }, 400);
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(
      "id, display_name, avatar_url, location, created_at, profile_complete"
    )
    .eq("id", profileId)
    .eq("profile_complete", true)
    .single();

  if (error || !profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  return c.json({ profile });
});

export default profiles;
