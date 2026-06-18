// ============================================================
// Sharetribe → Supabase field mappings
//
// Every field-level decision from MIGRATION.md lives here so the
// per-entity importers stay readable. Anything questionable should
// be a single map / function in this file, not inlined logic.
// ============================================================

// Note: We deliberately use `string` rather than the app's narrower
// `ListingCategory` type for these maps — the DB schema's CHECK
// constraint allows additional values (Jewellery, Anarkali, Sharara,
// Dupatta) that the app's TS enum doesn't list. The DB constraint is
// what matters at insert time.

// ============================================================
// Category (Sharetribe categoryLevel2 → our LISTING_CATEGORIES)
// ============================================================
//
// Distribution in the export:
//   salwarsuits      3,505     →  Salwar Kameez
//   lehengas         3,397     →  Lehenga
//   sarees             884     →  Saree
//   otherclothing      697     →  Other
//   indowestern        621     →  Indo-Western
//   kids               272     →  Kidswear
//   menswear           136     →  Menswear
//   blouses             97     →  Blouse
//   womensfootwear / mensfootwear / otherfootwear   82  →  Footwear
//   necklace / earrings / bangles / earringtika /
//     otherjewellery / jewelleryother              576  →  Jewellery
//   bags / belts / otheraccessories               103   →  Accessories

// The schema's `listings_category_check` constraint allows:
//   Lehenga, Saree, Suit/Salwar, Anarkali, Indowestern, Sharara,
//   Jewellery, Dupatta, Blouse, Menswear, Kidswear, Other
// (Footwear is added via schema-09.sql so 82 Sharetribe shoe listings
// don't collapse into Other.)
//
// We map to the schema values, not the narrower app-level enum.
export const SHARETRIBE_CATEGORY_MAP: Record<string, string> = {
  salwarsuits: "Suit/Salwar",
  lehengas: "Lehenga",
  sarees: "Saree",
  otherclothing: "Other",
  indowestern: "Indowestern",
  kids: "Kidswear",
  menswear: "Menswear",
  blouses: "Blouse",
  womensfootwear: "Footwear",
  mensfootwear: "Footwear",
  otherfootwear: "Footwear",
  necklace: "Jewellery",
  earrings: "Jewellery",
  bangles: "Jewellery",
  earringtika: "Jewellery",
  otherjewellery: "Jewellery",
  jewelleryother: "Jewellery",
  bags: "Other",
  belts: "Other",
  otheraccessories: "Other",
};

export function mapCategory(sharetribeCat: string | null | undefined): string | null {
  if (!sharetribeCat) return null;
  return SHARETRIBE_CATEGORY_MAP[sharetribeCat] ?? null;
}

// ============================================================
// Listing condition (Sharetribe → our LISTING_CONDITIONS)
// ============================================================
//
// Sharetribe stores condition as a camelCase enum value. Our schema's
// CHECK constraint allows the display-style values like "Pre-loved",
// "New without tags", etc. Map between them. The `rental` value
// shouldn't show up because rental listings are filtered before this
// runs, but we map it defensively just in case.

const SHARETRIBE_CONDITION_MAP: Record<string, string> = {
  preOwned: "Pre-loved",
  newWithoutTags: "New without tags",
  newWithTags: "New with tags",
  newWithDefects: "New with defects",
  rental: "Pre-loved",
};

export function mapCondition(value: string | null | undefined): string {
  if (!value) return "Pre-loved";
  return SHARETRIBE_CONDITION_MAP[value] ?? "Pre-loved";
}

// ============================================================
// Listing state (Sharetribe state → our status)
// ============================================================
//
// Sharetribe states: draft, pendingApproval, published, closed.
// Per client decision: import ALL closed listings (most are
// seller-delisted, not actually sold; only ~43 of 3,640 closed
// listings tie back to a real paid transaction).

// Schema's CHECK constraint allows: draft, pending_review, active,
// reserved, sold, deactivated. There's no `archived` — closed-by-seller
// (not sold) maps to `deactivated`.
export type ImportedListingStatus =
  | "draft"
  | "pending_review"
  | "active"
  | "sold"
  | "deactivated";

export function mapListingState(
  state: string,
  hasPaidTransaction: boolean
): ImportedListingStatus {
  switch (state) {
    case "draft":
      return "draft";
    case "pendingApproval":
      return "pending_review";
    case "published":
      return "active";
    case "closed":
      return hasPaidTransaction ? "sold" : "deactivated";
    default:
      return "draft";
  }
}

// ============================================================
// listingType filter — drop rentals
// ============================================================
//
// Per client: drop entirely. Affects 217 listings:
//   rent                  193
//   donate                 18
//   securitydepositrental   5
//   daily-rental            1
// Sell + sell-new-products go through.

const RENTAL_LISTING_TYPES = new Set([
  "rent",
  "donate",
  "securitydepositrental",
  "daily-rental",
]);

export function isRentalListing(listingType: string | null | undefined): boolean {
  if (!listingType) return false;
  return RENTAL_LISTING_TYPES.has(listingType);
}

// ============================================================
// Size fields — three Sharetribe fields → one (estimated_size, size_type)
// ============================================================
//
// estimateWomenSSizeAu     numeric AU sizes (10, 12, ... 24)   women's clothing
// estimateMensSizeAu       lettered (xs, s, m, l, ...)         menswear + kidswear
// estimateMenSSizeAu       same as above (capital S typo)      menswear + kidswear
// footwearSizeAu           numeric (4..13)                     footwear
//
// Output size_type values are the same enum as schema-07.sql line 35.

export type SizeType = "womens" | "menswear_kidswear" | "footwear";

export interface MappedSize {
  size_type: SizeType | null;
  estimated_size: string | null;
}

export function mapSize(publicData: Record<string, unknown>): MappedSize {
  const womens = publicData.estimateWomenSSizeAu as string | undefined;
  const mensA = publicData.estimateMensSizeAu as string | undefined;
  const mensB = publicData.estimateMenSSizeAu as string | undefined; // typo'd field
  const footwear = publicData.footwearSizeAu as string | undefined;

  if (footwear) {
    return { size_type: "footwear", estimated_size: footwear };
  }
  // Merge both menswear keys — the typo'd field stored the same thing.
  if (mensA || mensB) {
    return { size_type: "menswear_kidswear", estimated_size: mensA ?? mensB ?? null };
  }
  if (womens) {
    return { size_type: "womens", estimated_size: womens };
  }
  return { size_type: null, estimated_size: null };
}

// ============================================================
// Designer field cleanup
// ============================================================
//
// Two source fields:
//   designerID    dropdown slug (646 listings)
//   designer      free text     (3,299 listings — TONS of junk)
//
// Junk values (empty, n/a, na, none, etc) get normalised to null.
// Known slugs map to canonical display names. Free-text values are
// trimmed + case-corrected against the known list; unknown free-text
// passes through as-is (best-effort).
//
// Final dropdown list lives in MIGRATION.md section 10. The client
// will sign off on the canonical set; this map is the seed.

const JUNK_DESIGNER_VALUES = new Set([
  "",
  "-",
  "n/a",
  "na",
  "none",
  "nil",
  "no",
  "yes",
  "test",
  "home",
  "unknown",
  "not known",
  "not sure",
  "no name",
  "no designer",
  "non designer",
  "not designer",
  "local",
  "boutique",
  "self",
  "designer",
  "indian",
  "india",
  "pakistan",
  "pakistani",
  "ethnic",
  "indian designer",
  "pakistani designer",
  "customised",
  "customized",
  "custom",
  "custome made",
  "j.",
  "ssdesigners",
]);

// Slug → canonical display name (from designerID dropdown).
const DESIGNER_SLUG_MAP: Record<string, string> = {
  "seema-gujral": "Seema Gujral",
  maria: "Maria B",
  sana: "Sana Safinaz",
  "anita-dogre": "Anita Dongre",
  papadontpreach: "Papa Don't Preach",
  mohsin: "Mohsin Naveed Ranjha",
  faraz: "Faraz Manan",
  suffuse: "Suffuse by Sana Yasir",
  "sobia-nazir": "Sobia Nazir",
  sabyasachi: "Sabyasachi",
  gauravgupta: "Gaurav Gupta",
  faiza: "Faiza Saqlain",
  aghaoor: "Agha Noor",
  abhinavmishra: "Abhinav Mishra",
  vvani: "Vvani",
  tarun: "Tarun Tahiliani",
  ritukumar: "Ritu Kumar",
  payalsinghal: "Payal Singhal",
  masaba_gupta: "Masaba Gupta",
  manishmalhotra: "Manish Malhotra",
  "mahima-mahajan": "Mahima Mahajan",
  dollyj: "Dolly J",
  asim: "Asim Jofa",
  anushree: "Anushree Reddy",
  "hussain-rehar": "Hussain Rehar",
  others: "Other",
};

// Free-text → canonical (normalised for common typos / case).
// Anything not here passes through trimmed-as-is if not junk.
const DESIGNER_FREE_TEXT_MAP: Record<string, string> = {
  arivaah: "Arivaah",
  "maria b": "Maria B",
  pakistani: "", // junk
  "custom made": "Custom Made",
  "no designer": "",
  "sana safinaz": "Sana Safinaz",
  "sana safina": "Sana Safinaz", // common typo
  "agha noor": "Agha Noor",
  "seema gujral": "Seema Gujral",
  limelight: "Limelight",
  "royal threads": "Royal Threads",
  kalki: "Kalki Fashion",
  "kalki fashion": "Kalki Fashion",
  lashkaraa: "Lashkaraa",
  lashkara: "Lashkaraa",
  "asim jofa": "Asim Jofa",
  "meena bazaar": "Meena Bazaar",
  "faiza saqlain": "Faiza Saqlain",
  sabyasachi: "Sabyasachi",
  "manish malhotra": "Manish Malhotra",
  "anita dongre": "Anita Dongre",
  khaadi: "Khaadi",
  baroque: "Baroque",
  "frontier raas": "Frontier Raas",
  biba: "Biba",
  lulusar: "Lulusar",
  indya: "Indya",
  w: "W (Indian)",
  "saira shakira": "Saira Shakira",
  sapphire: "Sapphire",
  "suffuse by sana yasir": "Suffuse by Sana Yasir",
  "papa don't preach": "Papa Don't Preach",
  "papa dont preach": "Papa Don't Preach",
};

export function cleanDesigner(
  designerFree: string | null | undefined,
  designerID: string | null | undefined
): string | null {
  // designerID (slug) wins when present and resolves to a known name.
  if (designerID) {
    const slugMatch = DESIGNER_SLUG_MAP[designerID.toLowerCase()];
    if (slugMatch && slugMatch !== "Other") {
      return slugMatch;
    }
    // "others" or unknown slug falls through to the free-text field.
  }

  if (!designerFree) return null;

  const normalised = designerFree.toString().trim().toLowerCase();
  if (!normalised || JUNK_DESIGNER_VALUES.has(normalised)) return null;

  const mapped = DESIGNER_FREE_TEXT_MAP[normalised];
  if (mapped === "") return null; // junk-flagged via map
  if (mapped) return mapped;

  // Unknown free-text — pass through with title-case attempt.
  return designerFree
    .toString()
    .trim()
    .replace(/\s+/g, " ");
}

// ============================================================
// Curation tags & legacy product type — keep SEPARATE
// ============================================================
//
// kifaayatonly is the "current" editorial curation field in the
// Sharetribe app — values like:
//   bridal-edit / popular_brands / designer-edit / top-picks /
//   petite / plussize / maternity
// Maps to our existing listings.curation_tags TEXT[].
//
// productTypeOptional is an OLD field that's no longer surfaced in
// the listing form. Values like: wedding / bridal / groomswear /
// vintagePre2000. Per client (Q13), we preserve these in their own
// column (legacy_product_type) in case they want to bring the
// field back later. We do NOT merge into curation_tags — keeping
// them separate means an admin can tell at a glance which came
// from where, and the data stays "revivable" cleanly.

export function extractCurationTags(publicData: Record<string, unknown>): string[] {
  return coerceToStringArray(publicData.kifaayatonly);
}

export function extractLegacyProductType(publicData: Record<string, unknown>): string[] {
  return coerceToStringArray(publicData.productTypeOptional);
}

/**
 * Builds the merged measurements JSONB for a migrated listing.
 *
 * Sharetribe stored measurements in TWO formats over its lifetime:
 *   1. publicData.measurements — actually a free-text STRING
 *      (e.g. "Bust 38 inches Length 40 inches"). Despite the name,
 *      it's not structured. We preserve it as `notes`.
 *   2. Loose NUMERIC keys at publicData root: bustinches, hipsinches,
 *      waistinch (note: singular), lengthinches. ~67-200 listings.
 *
 * Output: a flat string-valued JSONB matching what the new app's
 * MeasurementBox expects (Record<string, string>). All values are
 * coerced to strings via String() because the frontend calls
 * .trim() on them, and numeric values would crash.
 */
export function buildMeasurementsJsonb(
  publicData: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};

  const raw = publicData.measurements;
  if (typeof raw === "string" && raw.trim().length > 0) {
    out.notes = raw.trim();
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    // Defensive — if a future Sharetribe export actually has structured
    // measurements (newer schema or partial migration), preserve them
    // with string-coerced values.
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== null && v !== undefined && v !== "") {
        out[k] = String(v).trim();
      }
    }
  }

  const looseKeys: Record<string, string> = {
    bustinches: "bust",
    hipsinches: "hips",
    waistinch: "waist",
    lengthinches: "length",
  };

  for (const [sharetribeKey, ourKey] of Object.entries(looseKeys)) {
    const v = publicData[sharetribeKey];
    if (v !== null && v !== undefined && v !== "" && !(ourKey in out)) {
      out[ourKey] = String(v).trim();
    }
  }

  return out;
}

/**
 * Items included is split across THREE Sharetribe fields, one per
 * category (lehengaitems for lehengas, salwaritemsincluded for salwars,
 * sareeitems for sarees). We union them into a single items_included
 * TEXT[] on our schema — the new app doesn't differentiate by category
 * for this field.
 */
export function extractItemsIncluded(
  publicData: Record<string, unknown>
): string[] {
  const merged = new Set<string>();
  for (const key of ["lehengaitems", "salwaritemsincluded", "sareeitems"]) {
    const v = publicData[key];
    for (const t of coerceToStringArray(v)) merged.add(t);
  }
  return Array.from(merged);
}

/**
 * Sharetribe data is inconsistent — fields meant to be arrays sometimes
 * appear as a single string (especially older listings). Conversely,
 * some fields are always single strings (e.g. `colour`). Coerce any
 * shape into a string[], skipping null/empty values. Returns an empty
 * array (not null) so the importer can hand it straight to a TEXT[]
 * column without postgres-js getting confused.
 */
export function coerceToStringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return [value.trim()].filter((v) => v.length > 0);
  }
  return [];
}

// ============================================================
// User country (Sharetribe → our location enum)
// ============================================================

// Sharetribe data has the country in MANY shapes, mostly because the
// platform's signup form changed over time:
//   - slugs:        australia_user, us_user, canada_user, uk_user, nz_user
//   - full names:   Australia, United States, Canada, United Kingdom, New Zealand
// Plus the empty case (~12K of 18K users). All normalised to our
// 2-letter ISO codes; anything we don't recognise becomes null.
const USER_COUNTRY_MAP: Record<string, string> = {
  // Slug variants
  australia_user: "AU",
  us_user: "US",
  canada_user: "CA",
  uk_user: "UK",
  nz_user: "NZ",
  newzealand_user: "NZ",
  // Full-name variants (case-insensitive lookup applied below)
  australia: "AU",
  "united states": "US",
  usa: "US",
  canada: "CA",
  "united kingdom": "UK",
  uk: "UK",
  britain: "UK",
  "great britain": "UK",
  "new zealand": "NZ",
  nz: "NZ",
};

export function mapUserCountry(value: string | null | undefined): string | null {
  if (!value) return null;
  return USER_COUNTRY_MAP[value.toLowerCase().trim()] ?? null;
}

// ============================================================
// Price (Sharetribe stores dollars as float; we store cents as int)
// ============================================================

export function dollarsToCents(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return clampInt(Math.round(amount * 100));
}

/**
 * Sanitises an "already in cents" value from Sharetribe. The data has
 * floats (`1798.9999999999998`) and absurd outliers (`6,421,100,382,900`
 * = $64 billion). Round + clamp to a sane range or return null.
 */
export function sanitizeCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampInt(Math.round(value));
}

/**
 * Clamp to a sane price range. Anything over $20M (in cents) is almost
 * certainly garbage data — return null and skip rather than overflow
 * the INTEGER column.
 */
const MAX_SANE_CENTS = 2_000_000_000; // $20M in cents
function clampInt(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  if (n > MAX_SANE_CENTS) return null;
  return n;
}

// ============================================================
// Phone number (Sharetribe stores AU mobile as int — leading 0 lost)
// ============================================================
// e.g. 475804914 → "0475804914". International numbers (with country
// code) are left as-is. Returns null if input isn't a number we
// recognise as AU mobile.

export function normalisePhone(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  // Already has leading + (international): pass through.
  if (str.startsWith("+")) return str;
  // 9-digit AU mobile stored without leading zero (4xxxxxxxx).
  if (/^4\d{8}$/.test(str)) return `0${str}`;
  // 10-digit AU mobile already with leading 0.
  if (/^04\d{8}$/.test(str)) return str;
  // Otherwise pass through whatever we got.
  return str;
}

// ============================================================
// ISO buyer preferences (publicData.iso* → profile columns)
// ============================================================

export interface MappedIsoPrefs {
  looking_for_categories: string[] | null;
  usual_sizes: string[] | null;
  buy_preferences: string[] | null;
  budget_ceiling: number | null;
  search_notes: string | null;
}

// iso* values are scoped with prefixes (isolehengas, iso1000, isouk14, ...).
// We strip the prefix to make them readable.
const stripIsoPrefix = (s: string): string =>
  s.replace(/^iso/, "").replace(/_/g, " ");

export function mapIsoPrefs(publicData: Record<string, unknown>): MappedIsoPrefs {
  const isotype = publicData.isotype as string[] | undefined;
  const isosize = publicData.isosize as string[] | undefined;
  const isocountry = publicData.isocountry as string[] | undefined;
  const isobudget = publicData.isobudget as string | undefined;
  const isopersonalised = publicData.isopersonalised as string | undefined;

  // Budget is stored as "iso1000", "iso2500" etc — strip prefix, parse int.
  let budget: number | null = null;
  if (isobudget) {
    const m = isobudget.match(/iso(\d+)/);
    if (m) budget = parseInt(m[1], 10);
  }

  return {
    looking_for_categories: isotype?.length ? isotype.map(stripIsoPrefix) : null,
    usual_sizes: isosize?.length ? isosize.map(stripIsoPrefix) : null,
    buy_preferences: isocountry?.length ? isocountry.map(stripIsoPrefix) : null,
    budget_ceiling: budget,
    search_notes: isopersonalised || null,
  };
}

// ============================================================
// Transaction status mapping (Sharetribe lastTransition → our OrderStatus)
// ============================================================

export type OrderStatus = "paid" | "shipped" | "delivered" | "complete" | "cancelled";

export function mapTransactionStatus(lastTransition: string): OrderStatus {
  // Treat anything in the cancel family as cancelled.
  if (lastTransition.startsWith("transition/cancel") ||
      lastTransition === "transition/auto-cancel" ||
      lastTransition === "transition/expire-payment") {
    return "cancelled";
  }
  // Any transition implying completion (review windows expired, auto-complete,
  // explicit completion) → complete.
  if (
    lastTransition === "transition/expire-review-period" ||
    lastTransition === "transition/expire-customer-review-period" ||
    lastTransition === "transition/expire-provider-review-period" ||
    lastTransition === "transition/auto-complete" ||
    lastTransition.startsWith("transition/review-")
  ) {
    return "complete";
  }
  // Conservative default — anything we don't recognise stays as 'paid'
  // (these are old transactions with payIns; safer to leave them as paid
  // than to fabricate a status).
  return "paid";
}
