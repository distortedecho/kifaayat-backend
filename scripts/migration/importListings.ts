// ============================================================
// Listings importer — batched
//
// Drops rental listings (per client). Skips listings whose author
// didn't migrate. Photos NOT migrated here — handled by a separate
// pass against the client's 112GB high-res JSON at final-import time.
// ============================================================

import { logError, type MigrationContext } from "./context.js";
import {
  buildMeasurementsJsonb,
  dollarsToCents,
  dryCleaningApplies,
  extractCurationTags,
  extractItemsIncluded,
  extractLegacyProductType,
  isRentalListing,
  loadDesignerCsv,
  mapCategoryAndSub,
  mapCondition,
  mapColours,
  mapCountryOfOrigin,
  mapDryCleaningStatus,
  mapFabricTypes,
  mapListingState,
  mapOccasionTags,
  mapSize,
  resolveDesigner,
  sanitizeCents,
  DESIGNER_CSV_DEFAULT,
  type DesignerCsvMap,
} from "./mappings.js";
import type { SharetribeListing, SharetribeTransaction } from "./types.js";
import { DEFAULT_BATCH_SIZE, chunk } from "./batch.js";

export async function importListings(
  ctx: MigrationContext,
  listings: SharetribeListing[],
  transactions: SharetribeTransaction[]
): Promise<void> {
  console.log(`[listings] importing ${listings.length} records`);

  // Load the client's canonical designer CSV once (env override or default).
  // If it's missing we still import — designers just come out blank.
  const csvPath = process.env.DESIGNER_CSV ?? DESIGNER_CSV_DEFAULT;
  let designerCsv: DesignerCsvMap | null = null;
  try {
    designerCsv = loadDesignerCsv(csvPath);
    console.log(`[listings] designer CSV loaded (${designerCsv.size} keys) from ${csvPath}`);
  } catch {
    console.warn(`[listings] designer CSV not found at ${csvPath} — designers will be blank`);
  }

  const soldListingIds = new Set<string>(
    transactions
      .filter((t) => (t.attributes.payIns?.length ?? 0) > 0)
      .map((t) => t.attributes.listingId)
  );

  type ListingRow = {
    title: string;
    description: string | null;
    seller_id: string;
    category: string;
    sub_category: string | null;
    condition: string;
    status: string;
    price_amount: number | null;
    price_currency: string;
    original_price_amount: number | null;
    negotiable: boolean;
    size_type: string | null;
    estimated_size: string | null;
    designer_name: string | null;
    designer_origin: string | null;
    country_of_origin: string | null;
    dry_cleaning_status: string | null;
    fabric_types: string[];
    measurements: Record<string, string>; // postgres-js auto-encodes for jsonb
    shipping_cost_amount: number | null;
    free_shipping: boolean;
    pickup_available: boolean;
    pickup_location: string | null;
    alteration_room: string | null;
    items_included: string[];
    view_count: number;
    save_count: number;
    share_count: number;
    curation_tags: string[];
    legacy_product_type: string[];
    occasion_tags: string[];
    colors: string[];
    legacy_sharetribe_id: string;
    legacy_numeric_id: string | null;
    created_at: string;
  };

  const rows: ListingRow[] = [];

  for (const l of listings) {
    try {
      const pub = (l.attributes.publicData ?? {}) as Record<string, unknown>;
      const listingType = pub.listingType as string | undefined;

      if (isRentalListing(listingType)) {
        ctx.stats.listings.skipped_rental += 1;
        continue;
      }
      const sellerId = ctx.userIdMap.get(l.attributes.author);
      if (!sellerId) {
        ctx.stats.listings.skipped_orphan += 1;
        continue;
      }

      const a = l.attributes;
      const meta = a.metadata ?? {};
      const size = mapSize(pub);
      const { category, sub_category } = mapCategoryAndSub(
        pub.categoryLevel2 as string | undefined
      );
      // Canonical designer + origin from the client CSV (blank if unmatched
      // or CSV absent).
      const designer = designerCsv
        ? resolveDesigner(
            designerCsv,
            pub.designer as string | undefined,
            pub.designerID as string | undefined
          )
        : { designer_name: null, designer_origin: null };
      // Sharetribe `price.amount` is in dollars (float). Other fields
      // are nominally in subunits but the data has floats and absurd
      // outliers; sanitizeCents rounds + clamps + returns null for
      // garbage so the INTEGER columns don't overflow. Missing price → null
      // (client: "shouldn't be missing — investigate"); leaves it as an
      // incomplete draft rather than a fake $0 listing.
      const priceCents = dollarsToCents(a.price?.amount ?? null);
      const originalPriceCents = dollarsToCents(
        pub.estimateOriginalPurchasePriceAud as number | undefined
      );
      const shippingCostCents = sanitizeCents(pub.shippingPriceInSubunitsOneItem);
      const legacyNumericId =
        meta.extId !== undefined && meta.extId !== null
          ? String(meta.extId)
          : null;

      const pickupEnabled = pub.pickupEnabled === true;

      // Sharetribe stored `negotiable` as an array of choice values like
      // ["yes_negotiable"] or ["no"]. Treat any presence of "yes_negotiable"
      // as truthy (the seller did opt into negotiation at some point).
      // Boolean-shaped values are handled too in case future data shifts.
      const negotiableRaw = pub.negotiable;
      const isNegotiable =
        negotiableRaw === true ||
        (Array.isArray(negotiableRaw) && negotiableRaw.includes("yes_negotiable"));
      // publicData.building stored a free-text pickup location/area
      // (only useful when the seller offered pickup at all).
      const pickupLocation = pickupEnabled
        ? (pub.building as string | undefined) ?? null
        : null;

      // Sharetribe engagement counters carry over to our existing
      // listing-level counters: numberOfLikes ≈ save_count,
      // openCount ≈ view_count, shareCount ≈ share_count.
      const numberOfLikes = Number(meta.numberOfLikes) || 0;
      const openCount = Number(meta.openCount) || 0;
      const shareCount = Number(meta.shareCount) || 0;

      rows.push({
        title: a.title,
        description: a.description ?? null,
        seller_id: sellerId,
        category,
        sub_category,
        condition: mapCondition(pub.condition as string | undefined),
        status: mapListingState(a.state, soldListingIds.has(l.id)),
        price_amount: priceCents,
        price_currency: a.price?.currency ?? "AUD",
        original_price_amount: originalPriceCents,
        negotiable: isNegotiable,
        size_type: size.size_type,
        estimated_size: size.estimated_size,
        designer_name: designer.designer_name,
        designer_origin: designer.designer_origin,
        // Slug → display-label mapping (see mappings.ts). Was previously
        // stored raw, which surfaced "india" / "net" / camelCase
        // dry-clean slugs in the UI.
        country_of_origin: mapCountryOfOrigin(pub.country),
        // Dry-cleaning doesn't apply to Jewellery / Accessories (client).
        dry_cleaning_status: dryCleaningApplies(category)
          ? mapDryCleaningStatus(pub.dryCleaningStatus)
          : null,
        fabric_types: mapFabricTypes(pub.fabric),
        // Folds loose bustinches/hipsinches/waistinch/lengthinches into
        // the structured measurements JSONB alongside publicData.measurements.
        // Pass the object directly — postgres-js handles JSONB serialization.
        // Pre-stringifying here causes double-encoding (jsonb_typeof = 'string'
        // instead of 'object') which makes the frontend's structured render fail.
        measurements: buildMeasurementsJsonb(pub),
        shipping_cost_amount: shippingCostCents,
        free_shipping: false,
        pickup_available: pickupEnabled,
        pickup_location: pickupLocation,
        alteration_room: (pub.alteration as string | undefined) ?? null,
        // Merged from lehengaitems / salwaritemsincluded / sareeitems —
        // Sharetribe split these per category; our schema is one flat array.
        items_included: extractItemsIncluded(pub),
        view_count: openCount,
        save_count: numberOfLikes,
        share_count: shareCount,
        curation_tags: extractCurationTags(pub),
        legacy_product_type: extractLegacyProductType(pub),
        // Slug → label maps; unmapped values dropped (see mappings.ts).
        occasion_tags: mapOccasionTags(pub.Occasion),
        // `colour` is a single slug in Sharetribe; mapColours title-cases
        // it and returns a one-element array for our TEXT[] column.
        colors: mapColours(pub.colour),
        legacy_sharetribe_id: l.id,
        legacy_numeric_id: legacyNumericId,
        created_at: a.createdAt,
      });
    } catch (err) {
      logError(ctx, "listings", l.id, err);
    }
  }

  if (ctx.dryRun) {
    for (const r of rows) {
      ctx.listingIdMap.set(r.legacy_sharetribe_id, `dry-${r.legacy_sharetribe_id}`);
    }
    ctx.stats.listings.inserted = rows.length;
    console.log(
      `[listings] dry-run — would have inserted ${rows.length}, ` +
        `rentals=${ctx.stats.listings.skipped_rental}, ` +
        `orphans=${ctx.stats.listings.skipped_orphan}`
    );
    return;
  }

  // ---- Batched INSERTs ----
  // measurements goes via raw jsonb cast — postgres-js handles it natively
  // when the value is a JSON string and the column is jsonb. We pre-cast
  // by including it as text and casting in the SQL via ::jsonb won't work
  // with the rows-helper, so we pass measurements as text and rely on the
  // implicit text→jsonb cast Postgres does for json-shaped strings. If
  // any malformed JSON sneaks in this will throw; we cover it via the
  // JSON.stringify above which always produces valid JSON.
  const batches = chunk(rows, DEFAULT_BATCH_SIZE);
  let insertedSoFar = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      await ctx.sql`
        INSERT INTO listings ${ctx.sql(
          batch as unknown as Array<Record<string, unknown>>,
          "title",
          "description",
          "seller_id",
          "category",
          "sub_category",
          "condition",
          "status",
          "price_amount",
          "price_currency",
          "original_price_amount",
          "negotiable",
          "size_type",
          "estimated_size",
          "designer_name",
          "designer_origin",
          "country_of_origin",
          "dry_cleaning_status",
          "fabric_types",
          "measurements",
          "shipping_cost_amount",
          "free_shipping",
          "pickup_available",
          "pickup_location",
          "alteration_room",
          "items_included",
          "view_count",
          "save_count",
          "share_count",
          "curation_tags",
          "legacy_product_type",
          "occasion_tags",
          "colors",
          "legacy_sharetribe_id",
          "legacy_numeric_id",
          "created_at"
        )}
        ON CONFLICT (legacy_sharetribe_id) WHERE legacy_sharetribe_id IS NOT NULL
        DO NOTHING
      `;
      insertedSoFar += batch.length;
      if ((i + 1) % 5 === 0 || i === batches.length - 1) {
        console.log(`[listings] inserted ${insertedSoFar}/${rows.length}`);
      }
    } catch (err) {
      logError(ctx, "listings", `batch[${i}]`, err);
    }
  }

  // ---- Fill listingIdMap from a bulk SELECT ----
  const sharetribeIds = rows.map((r) => r.legacy_sharetribe_id);
  type IdRow = { id: string; legacy_sharetribe_id: string };
  for (const idChunk of chunk(sharetribeIds, 2000)) {
    const found = (await ctx.sql`
      SELECT id, legacy_sharetribe_id FROM listings
      WHERE legacy_sharetribe_id = ANY(${idChunk})
    `) as unknown as IdRow[];
    for (const r of found) {
      ctx.listingIdMap.set(r.legacy_sharetribe_id, r.id);
    }
  }
  ctx.stats.listings.inserted = ctx.listingIdMap.size;

  console.log(
    `[listings] done — inserted/mapped=${ctx.stats.listings.inserted}, ` +
      `rentals=${ctx.stats.listings.skipped_rental}, ` +
      `orphans=${ctx.stats.listings.skipped_orphan}`
  );
}
