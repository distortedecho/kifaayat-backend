import { Hono } from "hono";
import { z } from "zod";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import {
  LISTING_CATEGORIES,
  LISTING_CONDITIONS,
  OCCASION_TAGS,
  REQUIRED_MEASUREMENTS,
  type ListingCategory,
  type Measurements,
} from "../types/listings.js";

const listings = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createListingSchema = z.object({
  title: z.string().min(1, "Title is required").max(200, "Title must be 200 characters or less"),
  description: z.string().max(2000, "Description must be 2000 characters or less").optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]]))
    .optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().positive("Price must be a positive integer (in cents)"),
  price_currency: z.enum(["AUD", "USD", "NZD"]).optional(),
  original_price_amount: z.number().int().positive().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).optional(),
  status: z.enum(["draft", "active"]).optional().default("draft"),
});

const updateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum(LISTING_CATEGORIES as unknown as [string, ...string[]]).optional(),
  condition: z.enum(LISTING_CONDITIONS as unknown as [string, ...string[]]).optional(),
  measurements: z
    .object({
      bust: z.string().optional(),
      waist: z.string().optional(),
      hip: z.string().optional(),
      length: z.string().optional(),
      sleeve_length: z.string().optional(),
      chest: z.string().optional(),
      age_range: z.string().optional(),
    })
    .optional(),
  occasion_tags: z
    .array(z.enum(OCCASION_TAGS as unknown as [string, ...string[]]))
    .optional(),
  colors: z.array(z.string()).optional(),
  price_amount: z.number().int().positive().optional(),
  price_currency: z.enum(["AUD", "USD", "NZD"]).optional(),
  original_price_amount: z.number().int().positive().nullable().optional(),
  negotiable: z.boolean().optional(),
  shipping_info: z.string().max(500).nullable().optional(),
  // Status restricted — cannot set to 'reserved' or 'sold' via update
  status: z.enum(["draft", "pending_review", "active", "deactivated"]).optional(),
});

const statusUpdateSchema = z.object({
  status: z.enum(["draft", "active", "pending_review", "deactivated", "reserved", "sold"]),
  rejection_reason: z.string().max(1000).optional(),
});

const photoReorderSchema = z.object({
  photo_ids: z.array(z.string().uuid()),
});

// ============================================================
// Helpers
// ============================================================

/**
 * Look up the profile UUID for a given Clerk user ID.
 * Returns null if no profile exists.
 */
async function getProfileByClerkId(
  clerkUserId: string
): Promise<{ id: string; profile_complete: boolean } | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, profile_complete")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Validate that required measurements for a category are present.
 * Returns array of missing field names, or empty array if valid.
 */
function validateMeasurements(
  category: ListingCategory,
  measurements: Measurements | undefined
): string[] {
  const required = REQUIRED_MEASUREMENTS[category];
  if (required.length === 0) return [];
  if (!measurements) return [...required];
  return required.filter((field) => !measurements[field]);
}

/**
 * Check if a listing has all required fields to go active.
 * Returns an error message string if incomplete, or null if ready.
 */
async function validateListingCompleteness(
  listingId: string,
  listingData: {
    title?: string | null;
    description?: string | null;
    category?: string | null;
    condition?: string | null;
    price_amount?: number | null;
  }
): Promise<string | null> {
  const missing: string[] = [];

  if (!listingData.title) missing.push("title");
  if (!listingData.category) missing.push("category");
  if (!listingData.condition) missing.push("condition");
  if (!listingData.price_amount) missing.push("price_amount");

  // Check photo count
  const supabase = createSupabaseAdmin();
  const { count } = await supabase
    .from("listing_photos")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId);

  if (!count || count < 3) {
    missing.push(`photos (need at least 3, have ${count || 0})`);
  }

  if (missing.length > 0) {
    return `Listing is incomplete. Missing: ${missing.join(", ")}`;
  }

  return null;
}

// Valid status transitions (Phase 3: draft -> pending_review for admin moderation)
const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_review"],           // was ["active"] — now goes through review
  pending_review: ["active", "draft"], // admin approves to active, or rejects back to draft
  active: ["reserved", "deactivated"],
  reserved: ["active", "sold"],
  deactivated: ["active"],             // re-activated listings skip re-review for now
  sold: [],
};

/**
 * Check if a Clerk user has admin privileges.
 * Queries the profiles table for the is_admin flag.
 */
async function isAdmin(clerkUserId: string): Promise<boolean> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return false;
  return data.is_admin === true;
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/listings/me
 * Return all listings by the current seller, ordered by updated_at DESC.
 */
listings.get("/me", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 404);
  }

  const statusFilter = c.req.query("status");

  let query = supabase
    .from("listings")
    .select("*, listing_photos(*)")
    .eq("seller_id", profile.id)
    .order("updated_at", { ascending: false });

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  const { data: listingsData, error } = await query;

  if (error) {
    console.error("Error fetching seller listings:", error);
    return c.json({ error: "Failed to fetch listings" }, 500);
  }

  // Sort photos by position for each listing
  const result = (listingsData || []).map((listing) => ({
    ...listing,
    photos: (listing.listing_photos || []).sort(
      (a: { position: number }, b: { position: number }) => a.position - b.position
    ),
    listing_photos: undefined,
  }));

  return c.json({ listings: result });
});

/**
 * POST /api/listings
 * Create a new listing.
 */
listings.post("/", clerkMiddleware, async (c) => {
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Look up profile
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found. Please complete your profile first." }, 403);
  }
  if (!profile.profile_complete) {
    return c.json({ error: "Profile must be complete before creating listings." }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = createListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const input = parsed.data;

  // Validate category-dependent measurements
  const missingMeasurements = validateMeasurements(
    input.category as ListingCategory,
    input.measurements as Measurements | undefined
  );
  if (missingMeasurements.length > 0) {
    return c.json(
      {
        error: "Missing required measurements for this category",
        details: { measurements: missingMeasurements },
      },
      400
    );
  }

  // Insert listing
  const { data: listing, error: insertError } = await supabase
    .from("listings")
    .insert({
      seller_id: profile.id,
      title: input.title,
      description: input.description || null,
      category: input.category,
      condition: input.condition,
      measurements: input.measurements || {},
      occasion_tags: input.occasion_tags || [],
      colors: input.colors || [],
      price_amount: input.price_amount,
      price_currency: input.price_currency || "AUD",
      original_price_amount: input.original_price_amount || null,
      negotiable: input.negotiable || false,
      status: input.status,
      shipping_info: input.shipping_info || null,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating listing:", insertError);
    return c.json({ error: "Failed to create listing" }, 500);
  }

  return c.json({ listing }, 201);
});

/**
 * GET /api/listings/:id
 * Fetch a single listing with photos and seller info.
 */
listings.get("/:id", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  const { data: listing, error } = await supabase
    .from("listings")
    .select("*, listing_photos(*), profiles!listings_seller_id_fkey(id, display_name, avatar_url, location)")
    .eq("id", listingId)
    .single();

  if (error || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  // If listing is not active, only the seller can view it
  if (listing.status !== "active") {
    const clerkUserId = c.get("clerkUserId");
    if (!clerkUserId) {
      return c.json({ error: "Listing not found" }, 404);
    }
    const profile = await getProfileByClerkId(clerkUserId);
    if (!profile || profile.id !== listing.seller_id) {
      return c.json({ error: "Listing not found" }, 404);
    }
  }

  // Shape response
  const photos = (listing.listing_photos || []).sort(
    (a: { position: number }, b: { position: number }) => a.position - b.position
  );
  const seller = listing.profiles || null;

  const result = {
    ...listing,
    photos,
    seller,
    listing_photos: undefined,
    profiles: undefined,
  };

  return c.json({ listing: result });
});

/**
 * PUT /api/listings/:id
 * Update a listing (seller only).
 */
listings.put("/:id", clerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Verify requester is the seller
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to update this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = updateListingSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const input = parsed.data;

  // If status change to 'active', validate completeness
  if (input.status === "active" && existing.status !== "active") {
    const merged = { ...existing, ...input };
    const completenessError = await validateListingCompleteness(listingId, merged);
    if (completenessError) {
      return c.json({ error: completenessError }, 400);
    }
  }

  // Validate measurements if category is being changed or measurements are provided
  const effectiveCategory = (input.category || existing.category) as ListingCategory;
  const effectiveMeasurements = (input.measurements || existing.measurements) as Measurements;
  if (input.category || input.measurements) {
    const missingMeasurements = validateMeasurements(effectiveCategory, effectiveMeasurements);
    if (missingMeasurements.length > 0) {
      return c.json(
        {
          error: "Missing required measurements for this category",
          details: { measurements: missingMeasurements },
        },
        400
      );
    }
  }

  // Build update data (only include provided fields)
  const updateData: Record<string, unknown> = {};
  if (input.title !== undefined) updateData.title = input.title;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.category !== undefined) updateData.category = input.category;
  if (input.condition !== undefined) updateData.condition = input.condition;
  if (input.measurements !== undefined) updateData.measurements = input.measurements;
  if (input.occasion_tags !== undefined) updateData.occasion_tags = input.occasion_tags;
  if (input.colors !== undefined) updateData.colors = input.colors;
  if (input.price_amount !== undefined) updateData.price_amount = input.price_amount;
  if (input.price_currency !== undefined) updateData.price_currency = input.price_currency;
  if (input.original_price_amount !== undefined) updateData.original_price_amount = input.original_price_amount;
  if (input.negotiable !== undefined) updateData.negotiable = input.negotiable;
  if (input.shipping_info !== undefined) updateData.shipping_info = input.shipping_info;
  if (input.status !== undefined) updateData.status = input.status;

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updateData)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing:", updateError);
    return c.json({ error: "Failed to update listing" }, 500);
  }

  return c.json({ listing: updated });
});

/**
 * PATCH /api/listings/:id/status
 * Update listing status with transition validation.
 */
listings.patch("/:id/status", clerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Verify requester is the seller
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to update this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = statusUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { status: newStatus, rejection_reason: rejectionReason } = parsed.data;

  // Enforce valid transitions
  const allowedTransitions = VALID_TRANSITIONS[existing.status] || [];
  if (!allowedTransitions.includes(newStatus)) {
    return c.json(
      {
        error: `Invalid status transition from '${existing.status}' to '${newStatus}'`,
        allowed: allowedTransitions,
      },
      400
    );
  }

  // If transitioning draft -> pending_review, validate completeness
  if (newStatus === "pending_review" && existing.status === "draft") {
    const completenessError = await validateListingCompleteness(listingId, existing);
    if (completenessError) {
      return c.json({ error: completenessError }, 400);
    }
  }

  // If transitioning pending_review -> active, require admin role
  if (newStatus === "active" && existing.status === "pending_review") {
    const adminCheck = await isAdmin(clerkUserId);
    if (!adminCheck) {
      return c.json({ error: "Only admins can approve listings" }, 403);
    }
  }

  // If transitioning pending_review -> draft (rejection), require admin role and rejection_reason
  if (newStatus === "draft" && existing.status === "pending_review") {
    const adminCheck = await isAdmin(clerkUserId);
    if (!adminCheck) {
      return c.json({ error: "Only admins can reject listings" }, 403);
    }
  }

  // Build update payload
  const updatePayload: Record<string, unknown> = { status: newStatus };

  // Set rejection_reason when rejecting (pending_review -> draft)
  if (newStatus === "draft" && existing.status === "pending_review" && rejectionReason) {
    updatePayload.rejection_reason = rejectionReason;
  }

  // Clear rejection_reason when re-submitting for review (draft -> pending_review)
  if (newStatus === "pending_review") {
    updatePayload.rejection_reason = null;
  }

  const { data: updated, error: updateError } = await supabase
    .from("listings")
    .update(updatePayload)
    .eq("id", listingId)
    .select()
    .single();

  if (updateError) {
    console.error("Error updating listing status:", updateError);
    return c.json({ error: "Failed to update listing status" }, 500);
  }

  return c.json({ listing: updated });
});

/**
 * POST /api/listings/:id/photos
 * Upload a photo for a listing (seller only).
 */
listings.post("/:id/photos", clerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Verify requester is the seller
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }

  const { data: existing, error: fetchError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (existing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to upload photos for this listing" }, 403);
  }

  // Check photo count limit
  const { count: existingCount } = await supabase
    .from("listing_photos")
    .select("id", { count: "exact", head: true })
    .eq("listing_id", listingId);

  if (existingCount !== null && existingCount >= 15) {
    return c.json({ error: "Maximum 15 photos per listing" }, 400);
  }

  // Parse multipart form data
  const formData = await c.req.formData();
  const photo = formData.get("photo");

  if (!photo || !(photo instanceof File)) {
    return c.json({ error: "Photo file is required" }, 400);
  }

  // Validate file type
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
  if (!allowedTypes.includes(photo.type)) {
    return c.json(
      { error: "Invalid file type. Allowed: JPEG, PNG, WebP, HEIC" },
      400
    );
  }

  // Validate file size (10MB max)
  const maxSize = 10 * 1024 * 1024;
  if (photo.size > maxSize) {
    return c.json({ error: "File too large. Maximum 10MB" }, 400);
  }

  // Generate unique filename
  const ext = photo.name.split(".").pop() || "jpg";
  const fileId = crypto.randomUUID();
  const storagePath = `${profile.id}/${listingId}/${fileId}.${ext}`;

  // Upload to Supabase Storage
  const fileBuffer = await photo.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from("listing-photos")
    .upload(storagePath, fileBuffer, {
      contentType: photo.type,
      upsert: false,
    });

  if (uploadError) {
    console.error("Error uploading photo:", uploadError);
    return c.json({ error: "Failed to upload photo" }, 500);
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from("listing-photos")
    .getPublicUrl(storagePath);

  // Determine next position
  const nextPosition = existingCount ?? 0;

  // Insert photo record
  const { data: photoRecord, error: insertError } = await supabase
    .from("listing_photos")
    .insert({
      listing_id: listingId,
      storage_path: storagePath,
      url: urlData.publicUrl,
      position: nextPosition,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error inserting photo record:", insertError);
    // Try to clean up uploaded file
    await supabase.storage.from("listing-photos").remove([storagePath]);
    return c.json({ error: "Failed to save photo record" }, 500);
  }

  return c.json({ photo: photoRecord }, 201);
});

/**
 * DELETE /api/listings/:id/photos/:photoId
 * Delete a photo from a listing (seller only).
 */
listings.delete("/:id/photos/:photoId", clerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const photoId = c.req.param("photoId");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId) || !uuidRegex.test(photoId)) {
    return c.json({ error: "Invalid ID format" }, 400);
  }

  // Verify requester is the seller
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id, status")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to delete photos from this listing" }, 403);
  }

  // Get photo record
  const { data: photoRecord, error: photoError } = await supabase
    .from("listing_photos")
    .select("*")
    .eq("id", photoId)
    .eq("listing_id", listingId)
    .single();

  if (photoError || !photoRecord) {
    return c.json({ error: "Photo not found" }, 404);
  }

  // Enforce min 3 photos if listing is active
  if (listing.status === "active") {
    const { count } = await supabase
      .from("listing_photos")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", listingId);

    if (count !== null && count <= 3) {
      return c.json(
        { error: "Active listings must have at least 3 photos" },
        400
      );
    }
  }

  // Delete from Supabase storage
  const { error: storageError } = await supabase.storage
    .from("listing-photos")
    .remove([photoRecord.storage_path]);

  if (storageError) {
    console.error("Error deleting photo from storage:", storageError);
    // Continue with DB deletion even if storage delete fails
  }

  // Delete from database
  const { error: deleteError } = await supabase
    .from("listing_photos")
    .delete()
    .eq("id", photoId);

  if (deleteError) {
    console.error("Error deleting photo record:", deleteError);
    return c.json({ error: "Failed to delete photo" }, 500);
  }

  return c.body(null, 204);
});

/**
 * PUT /api/listings/:id/photos/reorder
 * Reorder photos for a listing (seller only).
 */
listings.put("/:id/photos/reorder", clerkMiddleware, async (c) => {
  const listingId = c.req.param("id");
  const clerkUserId = c.get("clerkUserId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Verify requester is the seller
  const profile = await getProfileByClerkId(clerkUserId);
  if (!profile) {
    return c.json({ error: "Profile not found" }, 403);
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, seller_id")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.seller_id !== profile.id) {
    return c.json({ error: "Not authorized to reorder photos for this listing" }, 403);
  }

  // Parse and validate body
  const body = await c.req.json();
  const parsed = photoReorderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { photo_ids } = parsed.data;

  // Verify all photo IDs belong to this listing
  const { data: existingPhotos, error: photosError } = await supabase
    .from("listing_photos")
    .select("id")
    .eq("listing_id", listingId);

  if (photosError) {
    return c.json({ error: "Failed to fetch photos" }, 500);
  }

  const existingIds = new Set((existingPhotos || []).map((p) => p.id));
  const invalidIds = photo_ids.filter((id) => !existingIds.has(id));
  if (invalidIds.length > 0) {
    return c.json(
      { error: "Some photo IDs do not belong to this listing", invalid: invalidIds },
      400
    );
  }

  // Update positions
  const updates = photo_ids.map((id, index) =>
    supabase
      .from("listing_photos")
      .update({ position: index })
      .eq("id", id)
  );

  await Promise.all(updates);

  // Fetch updated photos
  const { data: updatedPhotos, error: fetchError } = await supabase
    .from("listing_photos")
    .select("*")
    .eq("listing_id", listingId)
    .order("position", { ascending: true });

  if (fetchError) {
    return c.json({ error: "Failed to fetch updated photos" }, 500);
  }

  return c.json({ photos: updatedPhotos });
});

export default listings;
