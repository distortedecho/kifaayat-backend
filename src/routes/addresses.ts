import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const addresses = new Hono();

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COUNTRY_CODES = ["AU", "US", "NZ", "CA", "GB"] as const;

const createAddressSchema = z.object({
  label: z.string().max(50).nullish(),
  recipient_name: z.string().max(200).nullish(),
  street_line1: z.string().min(1).max(200),
  street_line2: z.string().max(200).nullish(),
  city: z.string().min(1).max(100),
  // UK addresses don't have a "state" — they go straight from city to
  // postcode. Keep the column but allow it to be empty / omitted so
  // non-AU/US users can save without a fake placeholder value.
  state: z.string().max(100).nullish(),
  postal_code: z.string().min(1).max(20),
  country: z.enum(COUNTRY_CODES),
  phone: z.string().max(30).nullish(),
  is_default: z.boolean().optional(),
});

const updateAddressSchema = createAddressSchema.partial();

/**
 * GET /api/addresses
 * List the caller's saved addresses, default first then most recent.
 */
addresses.get("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("user_addresses")
    .select("*")
    .eq("user_id", profile.id)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching addresses:", error);
    return c.json({ error: "Failed to fetch addresses" }, 500);
  }

  return c.json({ addresses: data || [] });
});

/**
 * POST /api/addresses
 * Create a new address. The first address ever saved auto-becomes default.
 * If `is_default: true` is passed, demote any existing default first.
 */
addresses.post("/", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const body = await c.req.json();
  const parsed = createAddressSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    console.warn("[addresses] Validation failed:", JSON.stringify(fieldErrors));
    return c.json(
      { error: "Validation failed", details: fieldErrors },
      400
    );
  }

  // Auto-default if this is the user's first address.
  const { count: existingCount } = await supabase
    .from("user_addresses")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id);

  const makeDefault =
    parsed.data.is_default === true || (existingCount ?? 0) === 0;

  // If we're making this the default, clear any existing default first.
  if (makeDefault) {
    await supabase
      .from("user_addresses")
      .update({ is_default: false })
      .eq("user_id", profile.id)
      .eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("user_addresses")
    .insert({
      ...parsed.data,
      user_id: profile.id,
      is_default: makeDefault,
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating address:", error);
    return c.json({ error: "Failed to create address" }, 500);
  }

  return c.json({ address: data }, 201);
});

/**
 * PATCH /api/addresses/:id
 * Update an address. Pass `is_default: true` to promote it to default.
 */
addresses.patch("/:id", clerkMiddleware, requireProfile, async (c) => {
  const id = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(id)) {
    return c.json({ error: "Invalid address ID format" }, 400);
  }

  const body = await c.req.json();
  const parsed = updateAddressSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors;
    console.warn("[addresses] Validation failed:", JSON.stringify(fieldErrors));
    return c.json(
      { error: "Validation failed", details: fieldErrors },
      400
    );
  }

  // Confirm ownership before any mutation (RLS would also block, but a 404
  // is a clearer error than a silent no-op).
  const { data: existing } = await supabase
    .from("user_addresses")
    .select("id, is_default")
    .eq("id", id)
    .eq("user_id", profile.id)
    .single();

  if (!existing) {
    return c.json({ error: "Address not found" }, 404);
  }

  // Promoting to default — demote whatever's currently default first.
  if (parsed.data.is_default === true && !existing.is_default) {
    await supabase
      .from("user_addresses")
      .update({ is_default: false })
      .eq("user_id", profile.id)
      .eq("is_default", true);
  }

  // Can't demote the current default without promoting another — would leave
  // the user with no default. Reject so the frontend stays explicit.
  if (parsed.data.is_default === false && existing.is_default) {
    return c.json(
      { error: "Cannot unset the default address. Promote another address to default instead." },
      400
    );
  }

  const { data, error } = await supabase
    .from("user_addresses")
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", profile.id)
    .select()
    .single();

  if (error) {
    console.error("Error updating address:", error);
    return c.json({ error: "Failed to update address" }, 500);
  }

  return c.json({ address: data });
});

/**
 * DELETE /api/addresses/:id
 * Delete an address. If it was the default and other addresses remain,
 * promote the most recently created remaining address to default.
 */
addresses.delete("/:id", clerkMiddleware, requireProfile, async (c) => {
  const id = c.req.param("id");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  if (!UUID_REGEX.test(id)) {
    return c.json({ error: "Invalid address ID format" }, 400);
  }

  const { data: existing } = await supabase
    .from("user_addresses")
    .select("id, is_default")
    .eq("id", id)
    .eq("user_id", profile.id)
    .single();

  if (!existing) {
    return c.json({ error: "Address not found" }, 404);
  }

  const { error: deleteError } = await supabase
    .from("user_addresses")
    .delete()
    .eq("id", id)
    .eq("user_id", profile.id);

  if (deleteError) {
    console.error("Error deleting address:", deleteError);
    return c.json({ error: "Failed to delete address" }, 500);
  }

  // If we deleted the default, auto-promote the most recent remaining one.
  if (existing.is_default) {
    const { data: next } = await supabase
      .from("user_addresses")
      .select("id")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (next) {
      await supabase
        .from("user_addresses")
        .update({ is_default: true, updated_at: new Date().toISOString() })
        .eq("id", next.id);
    }
  }

  return c.body(null, 204);
});

export default addresses;
