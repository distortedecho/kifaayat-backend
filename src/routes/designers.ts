import { Hono } from "hono";
import { hasDirectDb, getSql } from "../lib/db.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const designers = new Hono();

// Typeahead needs at least this many chars — keeps result sets small and
// avoids scanning the whole table on a 1-char query. The app should call
// after ~3 chars anyway; this is the server-side floor.
const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 25;

/**
 * GET /api/designers?q=<query>
 *
 * Typeahead against the canonical designer list (~5.5k names). Returns
 * matches ordered prefix-first, then alphabetical. Public — taxonomy isn't
 * secret. Returns [] for queries shorter than MIN_QUERY_LEN.
 *
 * Response: { designers: [{ name, origin }] }  (origin: "Indian" | "Pakistani" | null)
 */
designers.get("/", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < MIN_QUERY_LEN) {
    return c.json({ designers: [] });
  }

  // Prefer direct SQL for prefix-priority ordering; fall back to Supabase
  // ilike (alphabetical only) if the direct pool isn't configured.
  if (hasDirectDb()) {
    try {
      const sql = getSql();
      const like = `%${q}%`;
      const prefix = `${q}%`;
      const rows = await sql<{ name: string; origin: string | null }[]>`
        SELECT name, origin
        FROM designers
        WHERE name ILIKE ${like}
        ORDER BY (name ILIKE ${prefix}) DESC, name ASC
        LIMIT ${MAX_RESULTS}
      `;
      return c.json({ designers: rows });
    } catch (err) {
      console.error("[designers] search failed:", err);
      // fall through to Supabase
    }
  }

  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("designers")
    .select("name, origin")
    .ilike("name", `%${q}%`)
    .order("name", { ascending: true })
    .limit(MAX_RESULTS);
  if (error) {
    console.error("[designers] supabase search failed:", error);
    return c.json({ designers: [] });
  }
  return c.json({ designers: data ?? [] });
});

export default designers;
