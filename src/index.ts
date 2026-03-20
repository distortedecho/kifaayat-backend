import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import health from "./routes/health.js";
import listings from "./routes/listings.js";
import profiles from "./routes/profiles.js";
import feed from "./routes/feed.js";
import search from "./routes/search.js";
import wishlists from "./routes/wishlists.js";
import ai from "./routes/ai.js";
import stripe from "./routes/stripe.js";
import offers from "./routes/offers.js";
import orders from "./routes/orders.js";
import notifications from "./routes/notifications.js";
import conversations from "./routes/conversations.js";
import exchangeRates from "./routes/exchange-rates.js";
import sellers from "./routes/sellers.js";
import reports from "./routes/reports.js";
import emailHooks from "./routes/email-hooks.js";
import reviews from "./routes/reviews.js";
import admin from "./routes/admin.js";
import cart from "./routes/cart.js";
import referrals from "./routes/referrals.js";
import rentals from "./routes/rentals.js";
import iso from "./routes/iso.js";
import sitemap from "./routes/sitemap.js";
import { initCronJobs } from "./lib/cron.js";

const app = new Hono();

const allowedOrigins = [
  "http://localhost:19006",
  "http://localhost:8081",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
  "https://kifaayat-admin.vercel.app",
  ...(process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
];

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.endsWith(".vercel.app")) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-guest-token"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })
);

// Sitemap (root-level, before /api routes)
app.route("/sitemap.xml", sitemap);

// Routes
app.route("/health", health);
app.route("/api/listings", listings);
app.route("/api/profiles", profiles);
app.route("/api/feed", feed);
app.route("/api/search", search);
app.route("/api/wishlists", wishlists);
app.route("/api/ai", ai);
app.route("/api/stripe", stripe);
app.route("/api/offers", offers);
app.route("/api/orders", orders);
app.route("/api/notifications", notifications);
app.route("/api/conversations", conversations);
app.route("/api/exchange-rates", exchangeRates);
app.route("/api/sellers", sellers);
app.route("/api/reviews", reviews);
app.route("/api/reports", reports);
app.route("/api/email-hooks", emailHooks);
app.route("/api/admin", admin);
app.route("/api/cart", cart);
app.route("/api/referrals", referrals);
app.route("/api/rentals", rentals);
app.route("/api/iso", iso);

// Root route
app.get("/", (c) => {
  return c.json({ name: "Kifaayat API", version: "1.0.0" });
});

const port = parseInt(process.env.PORT || "3001", 10);

console.log(`Server running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

// Initialize scheduled cron jobs (auto-complete, etc.)
initCronJobs();

export default app;
