// ============================================================
// Sharetribe → Supabase field mappings
//
// Every field-level decision from MIGRATION.md lives here so the
// per-entity importers stay readable. Anything questionable should
// be a single map / function in this file, not inlined logic.
// ============================================================

import fs from "node:fs";

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

// Category + sub-category (client's data-mapping review, Jul 2026). Granular
// Sharetribe categoryLevel2 → (category, sub_category):
//   - jewellery/footwear values carry a sub-category
//   - bags/belts/accessories → NEW "Accessories" category
//   - otherjewellery / jewelleryother / otherfootwear → "Other"
// Anything unmapped / missing → { Other, null }.
const SHARETRIBE_CATEGORY_SUB: Record<
  string,
  { category: string; sub_category: string | null }
> = {
  salwarsuits: { category: "Suit/Salwar", sub_category: null },
  lehengas: { category: "Lehenga", sub_category: null },
  sarees: { category: "Saree", sub_category: null },
  indowestern: { category: "Indowestern", sub_category: null },
  menswear: { category: "Menswear", sub_category: null },
  blouses: { category: "Blouse", sub_category: null },
  kids: { category: "Kidswear", sub_category: null },
  otherclothing: { category: "Other", sub_category: null },
  necklace: { category: "Jewellery", sub_category: "Necklace/Necklace sets" },
  earrings: { category: "Jewellery", sub_category: "Earrings" },
  bangles: { category: "Jewellery", sub_category: "Bangles" },
  earringtika: { category: "Jewellery", sub_category: "Earring & Tika Sets" },
  womensfootwear: { category: "Footwear", sub_category: "Women's Footwear" },
  mensfootwear: { category: "Footwear", sub_category: "Men's Footwear" },
  bags: { category: "Accessories", sub_category: "Bags/Clutches" },
  belts: { category: "Accessories", sub_category: "Belts" },
  otheraccessories: { category: "Accessories", sub_category: "Other accessories" },
  otherjewellery: { category: "Other", sub_category: null },
  jewelleryother: { category: "Other", sub_category: null },
  otherfootwear: { category: "Other", sub_category: null },
};

export function mapCategoryAndSub(sharetribeCat: string | null | undefined): {
  category: string;
  sub_category: string | null;
} {
  if (!sharetribeCat) return { category: "Other", sub_category: null };
  return (
    SHARETRIBE_CATEGORY_SUB[sharetribeCat] ?? { category: "Other", sub_category: null }
  );
}

/** Categories where the dry-cleaning field doesn't apply (client decision). */
export function dryCleaningApplies(category: string): boolean {
  return category !== "Jewellery" && category !== "Accessories";
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

  // Each branch maps the raw slug (AU number / size-letter) to the
  // combined display label the new app expects. Unmapped slugs fall to
  // null estimated_size rather than storing the bare "8" / "large".
  if (footwear) {
    return {
      size_type: "footwear",
      estimated_size: lookupLabel(footwear, FOOTWEAR_SIZE_MAP),
    };
  }
  // Merge both menswear keys — the typo'd field stored the same thing.
  const mens = mensA ?? mensB;
  if (mens) {
    return {
      size_type: "menswear_kidswear",
      estimated_size: lookupLabel(mens, MENS_SIZE_MAP),
    };
  }
  if (womens) {
    return {
      size_type: "womens",
      estimated_size: lookupLabel(womens, WOMENS_SIZE_MAP),
    };
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
// Designer cleanup via the client's canonical CSV (Column C + Origin)
// ============================================================
// The client sent "designer clean up - designer-brand.csv":
//   Raw Value | Match Key (normalized) | Canonical Name | Origin
// We match a listing's raw designer (free-text, or designerID slug resolved
// to a name) against the Match Key and take the Canonical Name + Origin.
// Not in the CSV / blank canonical → BLANK the designer (client decision).

export const DESIGNER_CSV_DEFAULT = "designer clean up - designer-brand.csv";

export type DesignerResolution = {
  designer_name: string | null;
  designer_origin: string | null; // 'Indian' | 'Pakistani' | null
};

export type DesignerCsvMap = Map<
  string,
  { canonical: string | null; origin: string | null }
>;

/** Same normalisation as the CSV's Match Key column. */
const designerNorm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Quote-aware CSV line parser (handles embedded commas in "..." fields). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Load the designer CSV into a matchKey → { canonical, origin } map. */
export function loadDesignerCsv(path: string): DesignerCsvMap {
  const map: DesignerCsvMap = new Map();
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  lines.shift(); // header
  for (const line of lines) {
    const [, matchKey, canonicalRaw, originRaw] = parseCsvLine(line);
    if (!matchKey) continue;
    const canonical = canonicalRaw && canonicalRaw.trim() ? canonicalRaw.trim() : null;
    const origin =
      originRaw === "Indian" || originRaw === "Pakistani" ? originRaw : null;
    map.set(matchKey, { canonical, origin });
  }
  return map;
}

/**
 * Resolve a listing's designer against the canonical CSV. Prefers free-text
 * `designer`; falls back to a `designerID` slug resolved to its name. Not in
 * the CSV → blanked.
 */
export function resolveDesigner(
  csv: DesignerCsvMap,
  designerFree: string | null | undefined,
  designerID: string | null | undefined
): DesignerResolution {
  let raw: string | null = null;
  if (designerFree && designerFree.toString().trim()) {
    raw = designerFree.toString().trim();
  } else if (designerID) {
    const slugName = DESIGNER_SLUG_MAP[designerID.toLowerCase()];
    if (slugName && slugName !== "Other") raw = slugName;
  }
  if (!raw) return { designer_name: null, designer_origin: null };

  const hit = csv.get(designerNorm(raw));
  if (!hit) return { designer_name: null, designer_origin: null };
  return { designer_name: hit.canonical, designer_origin: hit.origin };
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
    // Map each slug to its display label (e.g. "lehengaskirt" →
    // "Lehenga skirt"); unmapped slugs are dropped by lookupLabels.
    for (const label of lookupLabels(publicData[key], ITEMS_INCLUDED_MAP)) {
      merged.add(label);
    }
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
// Sharetribe option-key → display-label maps
// ============================================================
//
// Sharetribe select fields store the option KEY (a slug), not the
// label. The new app renders the label. Without translation, listings
// showed raw slugs ("net", "lehengaskirt", "dryCleanedOver1MonthAgo").
// Keys below are lowercased so lookups are case-insensitive (source
// data mixes "Linen"/"net" casing); all inputs are lowercased before
// lookup. Unmapped values are dropped rather than passed through raw,
// so a stray junk slug can't leak into the UI.
//
// Source of truth: /sharetribe-data/*.pdf (labels) + distinct values
// extracted from the raw export (keys).

const FABRIC_MAP: Record<string, string> = {
  artsilk: "Art silk",
  chiffon: "Chiffon",
  cotton: "Cotton",
  chinon: "Chinon",
  georgette: "Georgette",
  lawn: "Lawn",
  linen: "Linen",
  net: "Net",
  organza: "Organza",
  puresilk: "Pure silk",
  rawsilk: "Raw silk",
  satin: "Satin",
  sequin: "Sequin",
  velvet: "Velvet",
  other: "Other",
};

const COLOUR_MAP: Record<string, string> = {
  black: "Black",
  grey: "Grey",
  white: "White",
  brown: "Brown",
  tan: "Tan",
  cream: "Cream",
  yellow: "Yellow",
  red: "Red",
  burgundy: "Burgundy",
  orange: "Orange",
  pink: "Pink",
  purple: "Purple",
  blue: "Blue",
  navy: "Navy",
  green: "Green",
  khaki: "Khaki",
  multi: "Multi",
  silver: "Silver",
  gold: "Gold",
  other: "Other",
};

const OCCASION_MAP: Record<string, string> = {
  bridal: "Bridal",
  casual: "Casual",
  festive: "Festive",
  groom: "Groom",
  prewedding: "Pre-wedding event (bride/groom)",
  preweddingguest: "Pre-wedding event (guest)",
  weddingguest: "Wedding guest",
  weddingparty: "Wedding party",
};

// Merged across lehengaitems / sareeitems / salwaritemsincluded — keys
// are unique across the three source fields. `dupatta` (lehenga) and
// `dupattasalwar` (salwar) both map to "Dupatta".
const ITEMS_INCLUDED_MAP: Record<string, string> = {
  // Lehenga
  lehengaskirt: "Lehenga skirt",
  dupatta: "Dupatta",
  lehengablouse: "Lehenga top/blouse",
  potlimatching: "Matching potli bag/purse",
  // Saree
  stichedblouse: "Stitched Blouse",
  blousepiece: "Blouse piece (material)",
  petticoat: "Petticoat/Underskirt",
  // Suit/Salwar/Menswear
  kurta: "Kurta/Kurti",
  dupattasalwar: "Dupatta",
  bottoms: "Bottoms (e.g. Pant, Salwar, Shalwar, Sharara)",
};

// Sharetribe had 7 dry-cleaning values (incl. jewellery-specific ones);
// the new app has only 3. Client-confirmed collapse: anything implying
// "previously dry cleaned/sanitised" → previously; "pre-owned, not
// cleaned" → never; "new" → brand new.
const DRY_CLEANING_MAP: Record<string, string> = {
  preownedandnotdrycleaned: "Pre-loved, never dry cleaned",
  drycleanedlessthan1monthago: "Pre-loved, previously dry cleaned",
  drycleanedover1monthago: "Pre-loved, previously dry cleaned",
  newthereforenotdrycleaned: "Brand new, never dry cleaned",
  newjewelleryaccessoriesonly: "Brand new, never dry cleaned",
  preownedandnotsanitisedjewelleryaccessoriesonly: "Pre-loved, never dry cleaned",
  sanitisedjewelleryaccessoriesonly: "Pre-loved, previously dry cleaned",
};

const COUNTRY_OF_ORIGIN_MAP: Record<string, string> = {
  india: "India",
  indiandesigner: "Indian - Designer",
  pakistan: "Pakistan",
  pakistanidesigner: "Pakistani - Designer",
  nepal: "Nepal",
  bangladesh: "Bangladesh",
  srilanka: "Sri Lanka",
  maldives: "Maldives",
  afghanistan: "Afghanistan",
  bhutan: "Bhutan",
  other: "Other",
  designerother: "Other - Designer",
};

// Size maps: the slug is the AU number (women's/footwear) or a
// size-letter slug (menswear). Output is the combined display label
// that matches VALID_SIZES in routes/search.ts and the new app.
const WOMENS_SIZE_MAP: Record<string, string> = {
  "4": "UK4 / US0 / AU4",
  "6": "UK6 / US2 / AU6",
  "8": "UK8 / US4 / AU8",
  "10": "UK10 / US6 / AU10",
  "12": "UK12 / US8 / AU12",
  "14": "UK14 / US10 / AU14",
  "16": "UK16 / US12 / AU16",
  "18": "UK18 / US14 / AU18",
  "20": "UK20 / US16 / AU20",
  "22": "UK22 / US18 / AU22",
  "24": "UK24 / US20 / AU24",
  "26": "UK26 / US22 / AU26",
  "28": "UK28 / US24 / AU28",
  freesize: "Free Size",
};

const FOOTWEAR_SIZE_MAP: Record<string, string> = {
  "4": "AU4 / UK2 / US5 / EU35",
  "5": "AU5 / UK3 / US6 / EU36",
  "6": "AU6 / UK4 / US7 / EU37",
  "7": "AU7 / UK5 / US8 / EU38",
  "8": "AU8 / UK6 / US9 / EU39",
  "9": "AU9 / UK7 / US10 / EU40",
  "10": "AU10 / UK8 / US11 / EU41",
  "11": "AU11 / UK9 / US12 / EU42",
  "12": "AU12 / UK10 / US14 / EU43",
  "13": "AU13 / UK11 / US15 / EU44",
  "14": "AU14 / UK12 / US16 / EU45",
};

// Two source fields (estimateMensSizeAu + the typo'd estimateMenSSizeAu)
// used different slug schemes — descriptive (small/large/xlarge) and
// abbreviated (s/l/xl). Both covered here.
const MENS_SIZE_MAP: Record<string, string> = {
  xxs: "XXS",
  xs: "XS",
  s: "S",
  small: "S",
  m: "M",
  medium: "M",
  l: "L",
  large: "L",
  xl: "XL",
  xlarge: "XL",
  xxl: "XXL",
  "2xl": "XXL",
  "3xl": "3XL",
  "4xl": "4XL",
  freesize: "Free size",
};

/** Map a single slug to its label via the given map (case-insensitive). */
function lookupLabel(
  value: unknown,
  map: Record<string, string>
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return map[value.toLowerCase().trim()] ?? null;
}

/** Map an array (or single) of slugs to labels, dropping unmapped. */
function lookupLabels(value: unknown, map: Record<string, string>): string[] {
  const seen = new Set<string>();
  for (const raw of coerceToStringArray(value)) {
    const label = map[raw.toLowerCase().trim()];
    if (label) seen.add(label);
  }
  return Array.from(seen);
}

export function mapFabricTypes(value: unknown): string[] {
  return lookupLabels(value, FABRIC_MAP);
}

export function mapColours(value: unknown): string[] {
  return lookupLabels(value, COLOUR_MAP);
}

export function mapOccasionTags(value: unknown): string[] {
  return lookupLabels(value, OCCASION_MAP);
}

export function mapDryCleaningStatus(value: unknown): string | null {
  return lookupLabel(value, DRY_CLEANING_MAP);
}

export function mapCountryOfOrigin(value: unknown): string | null {
  return lookupLabel(value, COUNTRY_OF_ORIGIN_MAP);
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
  uk_user: "GB",
  nz_user: "NZ",
  newzealand_user: "NZ",
  // Full-name variants (case-insensitive lookup applied below)
  australia: "AU",
  "united states": "US",
  usa: "US",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  gb: "GB",
  britain: "GB",
  "great britain": "GB",
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
