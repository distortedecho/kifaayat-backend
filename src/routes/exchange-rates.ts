import { Hono } from "hono";
import { optionalClerkMiddleware } from "../middleware/clerk.js";
import { createSupabaseAdmin } from "../lib/supabase.js";

const exchangeRates = new Hono();

const SUPPORTED_CURRENCIES = ["AUD", "USD", "NZD"] as const;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ExternalRateResponse {
  base: string;
  rates: Record<string, number>;
}

/**
 * GET /api/exchange-rates
 * Returns cached exchange rates for AUD/USD/NZD pairs.
 * Refreshes from external API when cache is stale (>1 hour).
 * No auth required — public endpoint with read-only cached data.
 */
exchangeRates.get("/", optionalClerkMiddleware, async (c) => {
  const supabase = createSupabaseAdmin();

  try {
    // 1. Check cache freshness
    const { data: cachedRates, error: cacheError } = await supabase
      .from("exchange_rates")
      .select("*")
      .order("fetched_at", { ascending: false })
      .limit(1);

    if (cacheError) {
      console.error("Error reading exchange rates cache:", cacheError);
    }

    const now = Date.now();
    const isStale =
      !cachedRates ||
      cachedRates.length === 0 ||
      now - new Date(cachedRates[0].fetched_at).getTime() > CACHE_TTL_MS;

    if (isStale) {
      // 2. Fetch fresh rates from external API
      try {
        const freshRates: Record<string, Record<string, number>> = {};

        for (const base of SUPPORTED_CURRENCIES) {
          const res = await fetch(
            `https://api.exchangerate-api.com/v4/latest/${base}`
          );

          if (!res.ok) {
            throw new Error(
              `External API returned ${res.status} for ${base}`
            );
          }

          const data: ExternalRateResponse = await res.json();
          freshRates[base] = {};

          for (const target of SUPPORTED_CURRENCIES) {
            if (target !== base) {
              freshRates[base][target] = data.rates[target];
            }
          }
        }

        // 3. Upsert into cache table
        const upsertRows = [];
        for (const base of SUPPORTED_CURRENCIES) {
          for (const target of SUPPORTED_CURRENCIES) {
            if (target !== base) {
              upsertRows.push({
                base_currency: base,
                target_currency: target,
                rate: freshRates[base][target],
                fetched_at: new Date().toISOString(),
              });
            }
          }
        }

        const { error: upsertError } = await supabase
          .from("exchange_rates")
          .upsert(upsertRows, {
            onConflict: "base_currency,target_currency",
          });

        if (upsertError) {
          console.error("Error upserting exchange rates:", upsertError);
        }

        // Return fresh rates
        return c.json({
          rates: freshRates,
          updated_at: new Date().toISOString(),
        });
      } catch (fetchError) {
        console.error("Error fetching external rates:", fetchError);

        // Fall back to stale cache if available
        if (cachedRates && cachedRates.length > 0) {
          return c.json({
            rates: buildRatesObject(cachedRates),
            updated_at: cachedRates[0].fetched_at,
          });
        }

        return c.json({ error: "Failed to fetch exchange rates" }, 503);
      }
    }

    // 4. Return cached rates
    const { data: allRates, error: allError } = await supabase
      .from("exchange_rates")
      .select("*");

    if (allError || !allRates) {
      return c.json({ error: "Failed to read exchange rates" }, 500);
    }

    return c.json({
      rates: buildRatesObject(allRates),
      updated_at: allRates[0]?.fetched_at || new Date().toISOString(),
    });
  } catch (error) {
    console.error("Exchange rates error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Transforms flat DB rows into nested rates object.
 * e.g., { AUD: { USD: 0.65, NZD: 1.08 }, USD: { AUD: 1.54, NZD: 1.66 }, ... }
 */
function buildRatesObject(
  rows: Array<{
    base_currency: string;
    target_currency: string;
    rate: number;
  }>
): Record<string, Record<string, number>> {
  const rates: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    if (!rates[row.base_currency]) {
      rates[row.base_currency] = {};
    }
    rates[row.base_currency][row.target_currency] = Number(row.rate);
  }

  return rates;
}

export default exchangeRates;
