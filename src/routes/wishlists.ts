import { Hono } from "hono";
import { z } from "zod";
import { Context } from "hono";
import { clerkMiddleware, optionalClerkMiddleware } from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { getProfileByClerkId } from "../lib/profiles.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const wishlists = new Hono();

// ============================================================
// Types
// ============================================================

interface WishlistIdentifier {
  user_id?: string;
  guest_token?: string;
}

interface ListingSummaryWithSavedAt {
  id: string;
  title: string;
  price_amount: number;
  price_currency: string;
  original_price_amount: number | null;
  category: string;
  condition: string;
  estimated_size: string | null;
  size_type: string | null;
  designer_name: string | null;
  cover_photo_url: string | null;
  seller_name: string | null;
  seller_location: string | null;
  saved_at: string;
  folder_id: string | null;
}

// ============================================================
// Zod Schemas
// ============================================================

const saveListingSchema = z.object({
  listing_id: z.string().uuid("listing_id must be a valid UUID"),
  folder_id: z.string().uuid("folder_id must be a valid UUID").optional(),
});

const createFolderSchema = z.object({
  name: z.string().min(1, "Folder name is required").max(50, "Folder name must be 50 characters or less"),
});

const updateFolderSchema = z.object({
  name: z.string().min(1, "Folder name is required").max(50, "Folder name must be 50 characters or less"),
});

const moveToFolderSchema = z.object({
  folder_id: z.string().uuid("folder_id must be a valid UUID").nullable(),
});

const mergeSchema = z.object({
  guest_token: z.string().uuid("guest_token must be a valid UUID"),
});

// ============================================================
// Helpers
// ============================================================

/**
 * Determines the wishlist identifier (user_id or guest_token) from the request context.
 * Returns the identifier or null if neither is available.
 */
async function getWishlistIdentifier(
  c: Context
): Promise<{ identifier: WishlistIdentifier } | { error: string; status: 400 }> {
  const clerkUserId = c.get("clerkUserId");

  if (clerkUserId) {
    const profile = await getProfileByClerkId(clerkUserId);
    if (profile) {
      return { identifier: { user_id: profile.id } };
    }
    return { error: "Profile not found", status: 400 };
  }

  // Check for guest token
  const guestToken = c.req.header("x-guest-token");
  if (guestToken) {
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(guestToken)) {
      return { error: "Invalid guest token format", status: 400 };
    }
    return { identifier: { guest_token: guestToken } };
  }

  return { error: "Authentication or x-guest-token header required", status: 400 };
}


// ============================================================
// Routes — Guest-accessible (optionalClerkMiddleware)
// ============================================================

/**
 * POST /api/wishlists
 * Save a listing to wishlist.
 */
wishlists.post("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();

  // Parse body
  const body = await c.req.json();
  const parsed = saveListingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { listing_id, folder_id } = parsed.data;

  // Get identifier
  const result = await getWishlistIdentifier(c);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  const { identifier } = result;

  // Validate listing exists and is active
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, status")
    .eq("id", listing_id)
    .single();

  if (listingError || !listing) {
    return c.json({ error: "Listing not found" }, 404);
  }

  if (listing.status !== "active") {
    return c.json({ error: "Listing is not available" }, 400);
  }

  // If folder_id is provided, validate it belongs to the user (folders require auth)
  if (folder_id && identifier.user_id) {
    const { data: folder, error: folderError } = await supabase
      .from("wishlist_folders")
      .select("id")
      .eq("id", folder_id)
      .eq("user_id", identifier.user_id)
      .single();

    if (folderError || !folder) {
      return c.json({ error: "Folder not found" }, 404);
    }
  }

  // Insert wishlist entry
  const insertData: Record<string, unknown> = {
    listing_id,
    ...(identifier.user_id ? { user_id: identifier.user_id } : {}),
    ...(identifier.guest_token ? { guest_token: identifier.guest_token } : {}),
    ...(folder_id ? { folder_id } : {}),
  };

  const { data: wishlistEntry, error: insertError } = await supabase
    .from("wishlists")
    .insert(insertData)
    .select()
    .single();

  if (insertError) {
    // Handle unique constraint violation (already saved)
    if (
      insertError.code === "23505" ||
      insertError.message?.includes("unique") ||
      insertError.message?.includes("duplicate")
    ) {
      return c.json({ error: "Listing already saved to wishlist" }, 409);
    }
    console.error("Error saving to wishlist:", insertError);
    return c.json({ error: "Failed to save to wishlist" }, 500);
  }

  return c.json({ wishlist: wishlistEntry }, 201);
});

/**
 * DELETE /api/wishlists/:listingId
 * Unsave a listing from wishlist.
 */
wishlists.delete("/:listingId", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("listingId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Get identifier
  const result = await getWishlistIdentifier(c);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  const { identifier } = result;

  // Delete the wishlist entry
  let query = supabase.from("wishlists").delete().eq("listing_id", listingId);

  if (identifier.user_id) {
    query = query.eq("user_id", identifier.user_id);
  } else {
    query = query.eq("guest_token", identifier.guest_token!);
  }

  const { error: deleteError } = await query;

  if (deleteError) {
    console.error("Error removing from wishlist:", deleteError);
    return c.json({ error: "Failed to remove from wishlist" }, 500);
  }

  return c.body(null, 204);
});

/**
 * GET /api/wishlists
 * Get wishlist items with optional folder filter. Page-paginated.
 * Query params: ?page=<n>&limit=<n>&folder_id=<uuid> (default page=1, limit=50)
 */
wishlists.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const folderId = c.req.query("folder_id");

  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const page = Math.max(parseInt(pageParam || "1", 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(limitParam || "50", 10) || 50, 1),
    100
  );
  const offset = (page - 1) * limit;

  // Get identifier
  const result = await getWishlistIdentifier(c);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  const { identifier } = result;

  // Build query: wishlists joined with listings and photos
  let query = supabase
    .from("wishlists")
    .select(
      "id, listing_id, folder_id, created_at, listings!wishlists_listing_id_fkey(id, title, price_amount, price_currency, original_price_amount, category, condition, estimated_size, size_type, designer_name, status, listing_photos(url, position), profiles!listings_seller_id_fkey(display_name, location))",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Apply identifier filter
  if (identifier.user_id) {
    query = query.eq("user_id", identifier.user_id);
  } else {
    query = query.eq("guest_token", identifier.guest_token!);
  }

  // Apply folder filter
  if (folderId) {
    query = query.eq("folder_id", folderId);
  }

  const { data: wishlistRows, error, count: totalCount } = await query;

  if (error) {
    console.error("Error fetching wishlist:", error);
    return c.json({ error: "Failed to fetch wishlist" }, 500);
  }

  // Filter out items where listing is no longer active
  const items: ListingSummaryWithSavedAt[] = (wishlistRows || [])
    .filter((row: Record<string, unknown>) => {
      const listing = row.listings as Record<string, unknown> | null;
      return listing && listing.status === "active";
    })
    .map((row: Record<string, unknown>) => {
      const listing = row.listings as Record<string, unknown>;
      const profiles = listing.profiles as Record<string, unknown> | null;
      const photos = listing.listing_photos as Array<Record<string, unknown>> | null;

      let coverUrl: string | null = null;
      if (photos && photos.length > 0) {
        const cover = photos.find((p) => p.position === 0) || photos[0];
        coverUrl = (cover.url as string) || null;
      }

      return {
        id: listing.id as string,
        title: listing.title as string,
        price_amount: listing.price_amount as number,
        price_currency: listing.price_currency as string,
        original_price_amount: (listing.original_price_amount as number) || null,
        category: listing.category as string,
        condition: listing.condition as string,
        estimated_size: (listing.estimated_size as string) || null,
        size_type: (listing.size_type as string) || null,
        designer_name: (listing.designer_name as string) || null,
        cover_photo_url: coverUrl,
        seller_name: profiles ? (profiles.display_name as string | null) : null,
        seller_location: profiles ? (profiles.location as string | null) : null,
        saved_at: row.created_at as string,
        folder_id: (row.folder_id as string) || null,
      };
    });

  return c.json({
    items,
    count: items.length,
    page,
    limit,
    total: totalCount || 0,
  });
});

/**
 * GET /api/wishlists/summary
 * Returns total saved count and per-category breakdown.
 */
wishlists.get("/summary", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  const { data, error } = await supabase
    .from("wishlists")
    .select("listings!wishlists_listing_id_fkey(category, status)")
    .eq("user_id", profile.id);

  if (error) {
    console.error("Error fetching wishlist summary:", error);
    return c.json({ error: "Failed to fetch summary" }, 500);
  }

  const categoryCounts: Record<string, number> = {};
  let total = 0;

  for (const row of data || []) {
    const listing = (Array.isArray(row.listings) ? row.listings[0] : row.listings) as
      | { category: string; status: string }
      | null;
    if (!listing || listing.status !== "active") continue;
    categoryCounts[listing.category] = (categoryCounts[listing.category] || 0) + 1;
    total++;
  }

  return c.json({ total, categories: categoryCounts });
});

/**
 * GET /api/wishlists/check
 * Check if listings are wishlisted (for heart icon state).
 */
wishlists.get("/check", optionalClerkMiddleware, async (c) => {
  const listingIdsParam = c.req.query("listing_ids");
  const supabase = createSupabaseAdmin();

  if (!listingIdsParam) {
    return c.json({ error: "listing_ids query parameter is required" }, 400);
  }

  const listingIds = listingIdsParam.split(",").map((id) => id.trim()).filter(Boolean);

  if (listingIds.length === 0) {
    return c.json({ wishlisted: {} });
  }

  if (listingIds.length > 50) {
    return c.json({ error: "Maximum 50 listing IDs per request" }, 400);
  }

  // Validate UUID formats
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalidIds = listingIds.filter((id) => !uuidRegex.test(id));
  if (invalidIds.length > 0) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Get identifier
  const result = await getWishlistIdentifier(c);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  const { identifier } = result;

  // Query wishlists for these listing IDs
  let query = supabase
    .from("wishlists")
    .select("listing_id")
    .in("listing_id", listingIds);

  if (identifier.user_id) {
    query = query.eq("user_id", identifier.user_id);
  } else {
    query = query.eq("guest_token", identifier.guest_token!);
  }

  const { data: wishlisted, error } = await query;

  if (error) {
    console.error("Error checking wishlist:", error);
    return c.json({ error: "Failed to check wishlist" }, 500);
  }

  // Build boolean map
  const wishlistedSet = new Set(
    (wishlisted || []).map((w: Record<string, unknown>) => w.listing_id as string)
  );

  const wishlistedMap: Record<string, boolean> = {};
  for (const id of listingIds) {
    wishlistedMap[id] = wishlistedSet.has(id);
  }

  return c.json({ wishlisted: wishlistedMap });
});

// ============================================================
// Routes — Folder Management (clerkMiddleware — auth required)
// ============================================================

/**
 * POST /api/wishlists/folders
 * Create a wishlist folder.
 */
wishlists.post("/folders", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Parse body
  const body = await c.req.json();
  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { name } = parsed.data;

  // Insert folder
  const { data: folder, error: insertError } = await supabase
    .from("wishlist_folders")
    .insert({
      user_id: profile.id,
      name,
    })
    .select()
    .single();

  if (insertError) {
    console.error("Error creating folder:", insertError);
    return c.json({ error: "Failed to create folder" }, 500);
  }

  return c.json({ folder }, 201);
});

/**
 * GET /api/wishlists/folders
 * Get all folders with item counts and cover photos.
 */
wishlists.get("/folders", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Get all folders
  const { data: folders, error: foldersError } = await supabase
    .from("wishlist_folders")
    .select("id, name, created_at")
    .eq("user_id", profile.id)
    .order("created_at", { ascending: false });

  if (foldersError) {
    console.error("Error fetching folders:", foldersError);
    return c.json({ error: "Failed to fetch folders" }, 500);
  }

  // For each folder, get item count and cover photo
  const foldersWithMeta = await Promise.all(
    (folders || []).map(async (folder: Record<string, unknown>) => {
      // Get item count
      const { count } = await supabase
        .from("wishlists")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", folder.id)
        .eq("user_id", profile.id);

      // Get first item's cover photo
      let coverPhotoUrl: string | null = null;
      const { data: firstItem } = await supabase
        .from("wishlists")
        .select(
          "listings!wishlists_listing_id_fkey(listing_photos(url, position))"
        )
        .eq("folder_id", folder.id)
        .eq("user_id", profile.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (firstItem) {
        const listing = (firstItem as Record<string, unknown>)
          .listings as Record<string, unknown> | null;
        if (listing) {
          const photos = listing.listing_photos as
            | Array<Record<string, unknown>>
            | null;
          if (photos && photos.length > 0) {
            const cover = photos.find((p) => p.position === 0) || photos[0];
            coverPhotoUrl = (cover.url as string) || null;
          }
        }
      }

      return {
        id: folder.id,
        name: folder.name,
        item_count: count || 0,
        cover_photo_url: coverPhotoUrl,
        created_at: folder.created_at,
      };
    })
  );

  return c.json({ folders: foldersWithMeta });
});

/**
 * PUT /api/wishlists/folders/:folderId
 * Update a folder name.
 */
wishlists.put("/folders/:folderId", clerkMiddleware, requireProfile, async (c) => {
  const folderId = c.req.param("folderId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(folderId)) {
    return c.json({ error: "Invalid folder ID format" }, 400);
  }

  // Parse body
  const body = await c.req.json();
  const parsed = updateFolderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { name } = parsed.data;

  // Verify ownership and update
  const { data: folder, error: updateError } = await supabase
    .from("wishlist_folders")
    .update({ name })
    .eq("id", folderId)
    .eq("user_id", profile.id)
    .select()
    .single();

  if (updateError || !folder) {
    return c.json({ error: "Folder not found or not authorized" }, 404);
  }

  return c.json({ folder });
});

/**
 * DELETE /api/wishlists/folders/:folderId
 * Delete a folder. Items in folder get folder_id set to NULL (they stay in "All Saved").
 */
wishlists.delete("/folders/:folderId", clerkMiddleware, requireProfile, async (c) => {
  const folderId = c.req.param("folderId");
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(folderId)) {
    return c.json({ error: "Invalid folder ID format" }, 400);
  }

  // Verify ownership
  const { data: folder, error: fetchError } = await supabase
    .from("wishlist_folders")
    .select("id")
    .eq("id", folderId)
    .eq("user_id", profile.id)
    .single();

  if (fetchError || !folder) {
    return c.json({ error: "Folder not found or not authorized" }, 404);
  }

  // Items in folder get folder_id set to NULL (ON DELETE SET NULL handles this via FK)
  // Delete the folder
  const { error: deleteError } = await supabase
    .from("wishlist_folders")
    .delete()
    .eq("id", folderId)
    .eq("user_id", profile.id);

  if (deleteError) {
    console.error("Error deleting folder:", deleteError);
    return c.json({ error: "Failed to delete folder" }, 500);
  }

  return c.body(null, 204);
});

// ============================================================
// Routes — Item folder management
// ============================================================

/**
 * PUT /api/wishlists/:listingId/folder
 * Move a wishlist item to a folder (or remove from folder).
 */
wishlists.put("/:listingId/folder", optionalClerkMiddleware, async (c) => {
  const listingId = c.req.param("listingId");
  const supabase = createSupabaseAdmin();

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(listingId)) {
    return c.json({ error: "Invalid listing ID format" }, 400);
  }

  // Parse body
  const body = await c.req.json();
  const parsed = moveToFolderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { folder_id } = parsed.data;

  // Get identifier
  const result = await getWishlistIdentifier(c);
  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  const { identifier } = result;

  // If folder_id is provided, validate it belongs to the user (folders require auth)
  if (folder_id && identifier.user_id) {
    const { data: folder, error: folderError } = await supabase
      .from("wishlist_folders")
      .select("id")
      .eq("id", folder_id)
      .eq("user_id", identifier.user_id)
      .single();

    if (folderError || !folder) {
      return c.json({ error: "Folder not found" }, 404);
    }
  }

  // Update the wishlist entry
  let query = supabase
    .from("wishlists")
    .update({ folder_id })
    .eq("listing_id", listingId);

  if (identifier.user_id) {
    query = query.eq("user_id", identifier.user_id);
  } else {
    query = query.eq("guest_token", identifier.guest_token!);
  }

  const { data: updated, error: updateError } = await query.select().single();

  if (updateError || !updated) {
    return c.json({ error: "Wishlist item not found" }, 404);
  }

  return c.json({ wishlist: updated });
});

// ============================================================
// Routes — Guest merge (clerkMiddleware — auth required)
// ============================================================

/**
 * POST /api/wishlists/merge
 * Merge guest wishlist items to authenticated user on sign-up.
 */
wishlists.post("/merge", clerkMiddleware, requireProfile, async (c) => {
  const profile = c.get("profile");
  const supabase = createSupabaseAdmin();

  // Parse body
  const body = await c.req.json();
  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      400
    );
  }

  const { guest_token } = parsed.data;

  // Get guest wishlist items
  const { data: guestItems, error: fetchError } = await supabase
    .from("wishlists")
    .select("id, listing_id")
    .eq("guest_token", guest_token);

  if (fetchError) {
    console.error("Error fetching guest wishlist:", fetchError);
    return c.json({ error: "Failed to merge wishlist" }, 500);
  }

  if (!guestItems || guestItems.length === 0) {
    return c.json({ merged_count: 0 });
  }

  // Get user's existing wishlist listing IDs to avoid duplicates
  const { data: existingItems } = await supabase
    .from("wishlists")
    .select("listing_id")
    .eq("user_id", profile.id);

  const existingListingIds = new Set(
    (existingItems || []).map((item: Record<string, unknown>) => item.listing_id as string)
  );

  // Filter out duplicates
  const itemsToMerge = guestItems.filter(
    (item: Record<string, unknown>) => !existingListingIds.has(item.listing_id as string)
  );
  const duplicateIds = guestItems
    .filter((item: Record<string, unknown>) => existingListingIds.has(item.listing_id as string))
    .map((item: Record<string, unknown>) => item.id as string);

  // Update non-duplicate items: set user_id and clear guest_token
  if (itemsToMerge.length > 0) {
    const mergeIds = itemsToMerge.map((item: Record<string, unknown>) => item.id as string);
    const { error: updateError } = await supabase
      .from("wishlists")
      .update({ user_id: profile.id, guest_token: null })
      .in("id", mergeIds);

    if (updateError) {
      console.error("Error merging wishlist items:", updateError);
      return c.json({ error: "Failed to merge wishlist" }, 500);
    }
  }

  // Delete duplicate guest items
  if (duplicateIds.length > 0) {
    await supabase.from("wishlists").delete().in("id", duplicateIds);
  }

  return c.json({ merged_count: itemsToMerge.length });
});

export default wishlists;
