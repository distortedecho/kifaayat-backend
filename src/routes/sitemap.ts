import { Hono } from "hono";
import { stream } from "hono/streaming";
import { createSupabaseAdmin } from "../lib/supabase.js";

const sitemap = new Hono();

const SITE_URL = process.env.SITE_URL || "https://kifaayat.com";

// Hard caps — Google's per-sitemap limit is 50,000 URLs / 50 MB. We cap well
// below that to keep memory + response size predictable.
const MAX_LISTINGS = 10_000;
const MAX_SELLERS = 5_000;
const LISTING_BATCH_SIZE = 1_000;
const SELLER_BATCH_SIZE = 1_000;

sitemap.get("/", async (c) => {
  c.header("Content-Type", "application/xml");
  c.header("Cache-Control", "public, max-age=3600");

  return stream(c, async (s) => {
    const supabase = createSupabaseAdmin();

    // XML header + static pages
    await s.write(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url>\n    <loc>${SITE_URL}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n` +
        `  <url>\n    <loc>${SITE_URL}/search</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>\n`
    );

    // Stream active listings in batches up to the hard cap.
    let listingsWritten = 0;
    while (listingsWritten < MAX_LISTINGS) {
      const remaining = MAX_LISTINGS - listingsWritten;
      const take = Math.min(LISTING_BATCH_SIZE, remaining);
      const { data: batch, error } = await supabase
        .from("listings")
        .select("id, updated_at")
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .range(listingsWritten, listingsWritten + take - 1);

      if (error || !batch || batch.length === 0) break;

      for (const l of batch) {
        const lastmod = new Date(l.updated_at as string)
          .toISOString()
          .split("T")[0];
        await s.write(
          `  <url>\n    <loc>${SITE_URL}/listing/${l.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`
        );
      }

      listingsWritten += batch.length;
      if (batch.length < take) break;
    }

    // Stream distinct seller profiles derived from active listings.
    // We scan listing rows in batches and maintain a Set of seller IDs we've
    // already emitted until we hit the cap.
    const seenSellers = new Set<string>();
    let scanned = 0;
    while (seenSellers.size < MAX_SELLERS) {
      const { data: batch, error } = await supabase
        .from("listings")
        .select("seller_id")
        .eq("status", "active")
        .range(scanned, scanned + SELLER_BATCH_SIZE - 1);

      if (error || !batch || batch.length === 0) break;

      for (const row of batch) {
        const sid = row.seller_id as string | null;
        if (!sid || seenSellers.has(sid)) continue;
        seenSellers.add(sid);
        await s.write(
          `  <url>\n    <loc>${SITE_URL}/seller/${sid}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>\n`
        );
        if (seenSellers.size >= MAX_SELLERS) break;
      }

      scanned += batch.length;
      if (batch.length < SELLER_BATCH_SIZE) break;
    }

    await s.write(`</urlset>\n`);
  });
});

export default sitemap;
