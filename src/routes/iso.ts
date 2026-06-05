import { Hono } from "hono";
import { z } from "zod";
import {
  clerkMiddleware,
  optionalClerkMiddleware,
} from "../middleware/clerk.js";
import { requireProfile } from "../middleware/requireProfile.js";
import { createSupabaseAdmin } from "../lib/supabase.js";
import { matchISOPost } from "./ai.js";
import {
  createNotification,
  isoResponseReceivedNotification,
} from "../lib/notifications.js";

const iso = new Hono();

// ============================================================
// Zod Schemas
// ============================================================

const createISOPostSchema = z.object({
  description: z.string().min(10).max(1000),
  category: z.string(),
  size: z.string().optional(),
  budget_min: z.number().int().nonnegative().optional(),
  budget_max: z.number().int().positive().optional(),
});

const createResponseSchema = z.object({
  listing_id: z.string().uuid(),
  message: z.string().max(500).optional(),
  special_price: z.number().int().positive().optional(),
});

const createCommentSchema = z.object({
  content: z.string().min(1).max(1000),
});

// ============================================================
// Helpers
// ============================================================

/**
 * Auto-generate a title from the first 80 chars of a description.
 */
function generateTitle(description: string): string {
  if (description.length <= 80) return description;
  return description.slice(0, 77) + "...";
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/iso — Browse ISO posts (guest-accessible)
 * Query params: market (default "AU"), category (optional), cursor (optional), limit (default 20, max 50)
 */
iso.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const market = c.req.query("market") || "AU";
  const category = c.req.query("category") || null;
  const cursor = c.req.query("cursor") || null;
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

  let query = supabase
    .from("iso_posts")
    .select(
      "id, title, description, category, size, budget_min, budget_max, status, created_at, author_id, profiles!iso_posts_author_id_fkey(display_name, avatar_url)"
    )
    .eq("market", market)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (category) {
    query = query.eq("category", category);
  }

  // Cursor-based pagination: fetch items older than the cursor row
  if (cursor) {
    const { data: cursorRow } = await supabase
      .from("iso_posts")
      .select("created_at")
      .eq("id", cursor)
      .single();

    if (cursorRow) {
      query = query.lt("created_at", cursorRow.created_at);
    }
  }

  const { data: rows, error } = await query;

  if (error) {
    console.error("Error fetching ISO posts:", error);
    return c.json({ error: "Failed to fetch ISO posts" }, 500);
  }

  const allRows = (rows || []) as Record<string, unknown>[];
  const hasMore = allRows.length > limit;
  const pageRows = hasMore ? allRows.slice(0, limit) : allRows;

  // Fetch aggregate counts for all posts in this page
  const postIds = pageRows.map((r) => r.id as string);
  let responseCounts: Record<string, number> = {};
  let commentCounts: Record<string, number> = {};
  let matchCounts: Record<string, number> = {};

  if (postIds.length > 0) {
    const [respResult, commResult, matchResult] = await Promise.all([
      supabase
        .from("iso_responses")
        .select("iso_post_id")
        .in("iso_post_id", postIds),
      supabase
        .from("iso_comments")
        .select("iso_post_id")
        .in("iso_post_id", postIds),
      supabase
        .from("iso_matches")
        .select("iso_post_id")
        .in("iso_post_id", postIds),
    ]);

    // Count by post ID
    for (const r of (respResult.data || []) as Record<string, unknown>[]) {
      const pid = r.iso_post_id as string;
      responseCounts[pid] = (responseCounts[pid] || 0) + 1;
    }
    for (const r of (commResult.data || []) as Record<string, unknown>[]) {
      const pid = r.iso_post_id as string;
      commentCounts[pid] = (commentCounts[pid] || 0) + 1;
    }
    for (const r of (matchResult.data || []) as Record<string, unknown>[]) {
      const pid = r.iso_post_id as string;
      matchCounts[pid] = (matchCounts[pid] || 0) + 1;
    }
  }

  const posts = pageRows.map((row) => {
    const profiles = row.profiles as Record<string, unknown> | null;
    const id = row.id as string;
    return {
      id,
      title: row.title as string,
      description: row.description as string,
      category: row.category as string,
      size: (row.size as string) || null,
      budget_min: (row.budget_min as number) || null,
      budget_max: (row.budget_max as number) || null,
      author_name: profiles
        ? (profiles.display_name as string | null)
        : null,
      author_avatar: profiles
        ? (profiles.avatar_url as string | null)
        : null,
      response_count: responseCounts[id] || 0,
      comment_count: commentCounts[id] || 0,
      match_count: matchCounts[id] || 0,
      created_at: row.created_at as string,
    };
  });

  const next_cursor = hasMore
    ? (pageRows[pageRows.length - 1].id as string)
    : null;

  return c.json({ posts, next_cursor });
});

/**
 * POST /api/iso — Create an ISO post (auth required)
 */
iso.post("/", clerkMiddleware, requireProfile, async (c) => {
  const supabase = createSupabaseAdmin();
  const profile = c.get("profile");

  const body = await c.req.json();
  const parsed = createISOPostSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      400
    );
  }

  const { description, category, size, budget_min, budget_max } = parsed.data;

  // Derive market from author's profile location
  const { data: authorProfile } = await supabase
    .from("profiles")
    .select("location")
    .eq("id", profile.id)
    .single();

  const market = authorProfile?.location || "AU";
  const title = generateTitle(description);

  const { data: post, error } = await supabase
    .from("iso_posts")
    .insert({
      author_id: profile.id,
      title,
      description,
      category,
      size: size || null,
      budget_min: budget_min ?? null,
      budget_max: budget_max ?? null,
      market,
      status: "active",
    })
    .select()
    .single();

  if (error) {
    console.error("Error creating ISO post:", error);
    return c.json({ error: "Failed to create ISO post" }, 500);
  }

  // Fire-and-forget matching -- don't block the response
  matchISOPost(post.id).catch((err) =>
    console.error("ISO matching failed:", err)
  );

  return c.json(post, 201);
});

/**
 * GET /api/iso/:id — ISO post detail (guest-accessible)
 */
iso.get("/:id", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const id = c.req.param("id");

  const { data: post, error } = await supabase
    .from("iso_posts")
    .select(
      "*, profiles!iso_posts_author_id_fkey(display_name, avatar_url)"
    )
    .eq("id", id)
    .single();

  if (error || !post) {
    return c.json({ error: "ISO post not found" }, 404);
  }

  // Fetch counts in parallel
  const [respCount, commCount, matchCount] = await Promise.all([
    supabase
      .from("iso_responses")
      .select("id", { count: "exact", head: true })
      .eq("iso_post_id", id),
    supabase
      .from("iso_comments")
      .select("id", { count: "exact", head: true })
      .eq("iso_post_id", id),
    supabase
      .from("iso_matches")
      .select("id", { count: "exact", head: true })
      .eq("iso_post_id", id),
  ]);

  const profiles = (post as Record<string, unknown>).profiles as Record<
    string,
    unknown
  > | null;

  return c.json({
    ...post,
    author_name: profiles
      ? (profiles.display_name as string | null)
      : null,
    author_avatar: profiles
      ? (profiles.avatar_url as string | null)
      : null,
    response_count: respCount.count || 0,
    comment_count: commCount.count || 0,
    match_count: matchCount.count || 0,
  });
});

/**
 * POST /api/iso/:id/responses — Create "I Have This!" response (auth required)
 */
iso.post(
  "/:id/responses",
  clerkMiddleware,
  requireProfile,
  async (c) => {
    const supabase = createSupabaseAdmin();
    const profile = c.get("profile");
    const isoPostId = c.req.param("id");

    const body = await c.req.json();
    const parsed = createResponseSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400
      );
    }

    const { listing_id, message, special_price } = parsed.data;

    // Validate ISO post exists and is active
    const { data: isoPost } = await supabase
      .from("iso_posts")
      .select("id, status")
      .eq("id", isoPostId)
      .single();

    if (!isoPost) {
      return c.json({ error: "ISO post not found" }, 404);
    }
    if (isoPost.status !== "active") {
      return c.json({ error: "ISO post is no longer active" }, 400);
    }

    // Validate listing exists, is active, and belongs to the responder
    const { data: listing } = await supabase
      .from("listings")
      .select("id, status, seller_id, price_amount")
      .eq("id", listing_id)
      .single();

    if (!listing) {
      return c.json({ error: "Listing not found" }, 404);
    }
    if (listing.status !== "active") {
      return c.json({ error: "Listing is not active" }, 400);
    }
    if (listing.seller_id !== profile.id) {
      return c.json(
        { error: "You can only respond with your own listings" },
        403
      );
    }

    // Validate special_price is less than listing price
    if (special_price !== undefined && special_price >= listing.price_amount) {
      return c.json(
        { error: "Special price must be less than the listing price" },
        400
      );
    }

    // Prevent duplicate responses for same responder + post + listing
    const { data: existing } = await supabase
      .from("iso_responses")
      .select("id")
      .eq("iso_post_id", isoPostId)
      .eq("responder_id", profile.id)
      .eq("listing_id", listing_id)
      .maybeSingle();

    if (existing) {
      return c.json(
        { error: "You have already responded with this listing" },
        409
      );
    }

    const { data: response, error } = await supabase
      .from("iso_responses")
      .insert({
        iso_post_id: isoPostId,
        responder_id: profile.id,
        listing_id,
        message: message || null,
        special_price: special_price ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating ISO response:", error);
      return c.json({ error: "Failed to create response" }, 500);
    }

    // Notify the ISO post author about the new response
    const { data: isoPostData } = await supabase
      .from("iso_posts")
      .select("author_id, description")
      .eq("id", isoPostId)
      .single();

    if (isoPostData && isoPostData.author_id !== profile.id) {
      const template = isoResponseReceivedNotification(
        profile.display_name || "A seller",
        isoPostData.description || ""
      );
      createNotification({
        user_id: isoPostData.author_id,
        type: "iso_response",
        ...template,
        // ISO author is the prospective buyer; the seller responded to their request.
        data: { iso_post_id: isoPostId, role: "buyer" },
      }).catch(() => {}); // fire-and-forget
    }

    return c.json(response, 201);
  }
);

/**
 * GET /api/iso/:id/responses — List responses for an ISO post (guest-accessible)
 */
iso.get("/:id/responses", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const isoPostId = c.req.param("id");

  const { data: rows, error } = await supabase
    .from("iso_responses")
    .select(
      "id, iso_post_id, responder_id, listing_id, message, special_price, created_at, listings(id, title, price_amount, price_currency, listing_photos(url, position)), profiles!iso_responses_responder_id_fkey(display_name, avatar_url)"
    )
    .eq("iso_post_id", isoPostId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error fetching ISO responses:", error);
    return c.json({ error: "Failed to fetch responses" }, 500);
  }

  const responses = ((rows || []) as Record<string, unknown>[]).map((row) => {
    const listing = row.listings as Record<string, unknown> | null;
    const responder = row.profiles as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id,
      iso_post_id: row.iso_post_id,
      responder_id: row.responder_id,
      listing_id: row.listing_id,
      message: row.message,
      special_price: row.special_price,
      created_at: row.created_at,
      listing_title: listing ? listing.title : null,
      listing_price_amount: listing ? listing.price_amount : null,
      listing_price_currency: listing ? listing.price_currency : null,
      listing_cover_photo: coverUrl,
      responder_name: responder
        ? (responder.display_name as string | null)
        : null,
      responder_avatar: responder
        ? (responder.avatar_url as string | null)
        : null,
    };
  });

  return c.json({ responses });
});

/**
 * POST /api/iso/:id/comments — Create a comment (auth required)
 */
iso.post(
  "/:id/comments",
  clerkMiddleware,
  requireProfile,
  async (c) => {
    const supabase = createSupabaseAdmin();
    const profile = c.get("profile");
    const isoPostId = c.req.param("id");

    const body = await c.req.json();
    const parsed = createCommentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400
      );
    }

    const { content } = parsed.data;

    // Validate ISO post exists and is active
    const { data: isoPost } = await supabase
      .from("iso_posts")
      .select("id, status")
      .eq("id", isoPostId)
      .single();

    if (!isoPost) {
      return c.json({ error: "ISO post not found" }, 404);
    }
    if (isoPost.status !== "active") {
      return c.json({ error: "ISO post is no longer active" }, 400);
    }

    const { data: comment, error } = await supabase
      .from("iso_comments")
      .insert({
        iso_post_id: isoPostId,
        author_id: profile.id,
        content,
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating ISO comment:", error);
      return c.json({ error: "Failed to create comment" }, 500);
    }

    return c.json(comment, 201);
  }
);

/**
 * GET /api/iso/:id/comments — List comments for an ISO post (guest-accessible)
 */
iso.get("/:id/comments", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const isoPostId = c.req.param("id");

  const { data: rows, error } = await supabase
    .from("iso_comments")
    .select(
      "id, iso_post_id, author_id, content, created_at, profiles!iso_comments_author_id_fkey(display_name, avatar_url)"
    )
    .eq("iso_post_id", isoPostId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error fetching ISO comments:", error);
    return c.json({ error: "Failed to fetch comments" }, 500);
  }

  const comments = ((rows || []) as Record<string, unknown>[]).map((row) => {
    const author = row.profiles as Record<string, unknown> | null;
    return {
      id: row.id,
      iso_post_id: row.iso_post_id,
      author_id: row.author_id,
      content: row.content,
      created_at: row.created_at,
      author_name: author
        ? (author.display_name as string | null)
        : null,
      author_avatar: author
        ? (author.avatar_url as string | null)
        : null,
    };
  });

  return c.json({ comments });
});

/**
 * GET /api/iso/:id/matches — List AI matches for an ISO post (guest-accessible)
 */
iso.get("/:id/matches", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();
  const isoPostId = c.req.param("id");

  const { data: rows, error } = await supabase
    .from("iso_matches")
    .select(
      "id, iso_post_id, listing_id, match_score, match_reasons, created_at, listings(id, title, price_amount, price_currency, listing_photos(url, position))"
    )
    .eq("iso_post_id", isoPostId)
    .order("match_score", { ascending: false });

  if (error) {
    console.error("Error fetching ISO matches:", error);
    return c.json({ error: "Failed to fetch matches" }, 500);
  }

  const matches = ((rows || []) as Record<string, unknown>[]).map((row) => {
    const listing = row.listings as Record<string, unknown> | null;
    const photos = listing
      ? (listing.listing_photos as Array<Record<string, unknown>> | null)
      : null;

    let coverUrl: string | null = null;
    if (photos && photos.length > 0) {
      const cover = photos.find((p) => p.position === 0) || photos[0];
      coverUrl = (cover.url as string) || null;
    }

    return {
      id: row.id,
      iso_post_id: row.iso_post_id,
      listing_id: row.listing_id,
      match_score: row.match_score,
      match_reasons: row.match_reasons,
      created_at: row.created_at,
      listing_title: listing ? listing.title : null,
      listing_price_amount: listing ? listing.price_amount : null,
      listing_price_currency: listing ? listing.price_currency : null,
      listing_cover_photo: coverUrl,
    };
  });

  return c.json({ matches });
});

export default iso;
