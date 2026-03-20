import { Hono } from "hono";
import { createSupabaseAdmin } from "../lib/supabase.js";

const sitemap = new Hono();

const SITE_URL = process.env.SITE_URL || "https://kifaayat.com";

sitemap.get("/", async (c) => {
  const supabase = createSupabaseAdmin();

  // Fetch active listings
  const { data: listings } = await supabase
    .from("listings")
    .select("id, updated_at")
    .eq("status", "active")
    .order("updated_at", { ascending: false });

  // Fetch sellers with active listings (distinct seller profiles)
  const { data: sellers } = await supabase
    .from("listings")
    .select("seller_id")
    .eq("status", "active");

  const uniqueSellerIds = [
    ...new Set((sellers ?? []).map((s) => s.seller_id)),
  ];

  // Build XML
  const listingUrls = (listings ?? [])
    .map(
      (l) =>
        `  <url>
    <loc>${SITE_URL}/listing/${l.id}</loc>
    <lastmod>${new Date(l.updated_at).toISOString().split("T")[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`
    )
    .join("\n");

  const sellerUrls = uniqueSellerIds
    .map(
      (id) =>
        `  <url>
    <loc>${SITE_URL}/seller/${id}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`
    )
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/search</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
  </url>
${listingUrls}
${sellerUrls}
</urlset>`;

  c.header("Content-Type", "application/xml");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(xml);
});

export default sitemap;
