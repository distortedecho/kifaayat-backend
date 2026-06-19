// ============================================================
// Categories — matching live Play Store app + Footwear
// ============================================================

// Canonical 9-category taxonomy — matches live Sharetribe platform.
// Display labels stay as written; Sharetribe IDs are noted in comments:
//   Lehenga      = lehengas
//   Saree        = sarees
//   Suit/Salwar  = salwarsuits
//   Blouse       = blouses
//   Indowestern  = indowestern
//   Menswear     = menswear
//   Kidswear     = kids
//   Footwear     = footwear
//   Other        = other
// Categories the app supports as filter values, listing-create options,
// and feed sections. Real Sharetribe categories only — Anarkali / Sharara
// / Dupatta were AI hallucinations the client flagged and we dropped.
// `Jewellery` covers the Sharetribe jewellery sub-categories (necklace,
// earrings, bangles, etc., ~576 migrated listings).
//
// The DB `listings_category_check` constraint (schema-09.sql) still
// permits the dropped 3 values for backwards-compat — harmless, just
// never used by importer or new listings.
export const LISTING_CATEGORIES = [
  "Lehenga",
  "Saree",
  "Suit/Salwar",
  "Indowestern",
  "Jewellery",
  "Blouse",
  "Menswear",
  "Kidswear",
  "Footwear",
  "Other",
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

// ============================================================
// Sub-categories
// ============================================================
// Three parent categories carry a second level so the filter sheet
// can drill down. Vocabulary is intentionally TS-side (no DB CHECK)
// so the client can rename labels later without a migration —
// we'd just update this map and any UI strings, no schema work.
//
// Parents not listed here have no sub-categories: their listings
// must store sub_category = null. The validator in listings.ts
// enforces this so a Saree never silently gets tagged "Bangles".

export const SUB_CATEGORIES_BY_CATEGORY: Partial<
  Record<ListingCategory, readonly string[]>
> = {
  Jewellery: [
    "Earrings",
    "Necklace/Necklace sets",
    "Earring & Tika Sets",
    "Bangles",
    "Other Jewellery",
  ],
  Other: ["Bags/Clutches", "Belts", "Other accessories"],
  Footwear: ["Men's Footwear", "Women's Footwear", "Other"],
} as const;

/**
 * Returns true when the (category, sub_category) pair is valid.
 * - null / empty sub_category is always allowed (legacy listings,
 *   sellers who skip the field, parents with no sub-categories).
 * - A non-null sub_category is only allowed for parents listed in
 *   SUB_CATEGORIES_BY_CATEGORY, and must match one of that parent's
 *   exact strings.
 */
export function isValidSubCategoryPair(
  category: string,
  subCategory: string | null | undefined
): boolean {
  if (subCategory === null || subCategory === undefined || subCategory === "") {
    return true;
  }
  const allowed =
    SUB_CATEGORIES_BY_CATEGORY[category as ListingCategory] ?? null;
  if (!allowed) return false;
  return allowed.includes(subCategory);
}

// ============================================================
// Conditions — matching live Play Store app
// ============================================================

export const LISTING_CONDITIONS = [
  "Pre-loved",
  "New without tags",
  "New with tags",
  "New with defects",
] as const;
export type ListingCondition = (typeof LISTING_CONDITIONS)[number];

// Status enum
export const LISTING_STATUSES = [
  "draft",
  "pending_review",
  "active",
  "reserved",
  "sold",
  "deactivated",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

// ============================================================
// Occasion tags — matching live Play Store app
// ============================================================

export const OCCASION_TAGS = [
  "Bridal",
  "Casual",
  "Festive",
  "Groom",
  "Pre-wedding event (bride/groom)",
  "Pre-wedding event (guest)",
  "Wedding party",
  "Wedding guest",
] as const;
export type OccasionTag = (typeof OCCASION_TAGS)[number];

// ============================================================
// Predefined Lists — aligned with live app
// ============================================================

// Fabric types — 15 options, matches live Sharetribe platform exactly.
export const FABRIC_TYPES = [
  "Art silk",
  "Chiffon",
  "Cotton",
  "Chinon",
  "Georgette",
  "Lawn",
  "Linen",
  "Net",
  "Organza",
  "Pure silk",
  "Raw silk",
  "Satin",
  "Sequin",
  "Velvet",
  "Other",
] as const;
export type FabricType = (typeof FABRIC_TYPES)[number];

// Work/embroidery types
export const WORK_TYPES = [
  "Zardozi",
  "Thread",
  "Mirror",
  "Sequin",
  "Gota Patti",
  "Kundan",
  "Resham",
  "Dabka",
  "Cutdana",
  "Aari",
  "Chikankari",
  "Phulkari",
  "Bandhani",
  "Stone",
  "Pearl",
  "Plain",
  "Other",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

// ============================================================
// Items included — matching live Play Store app labels
// ============================================================

// Items included — only 3 lists exist in Sharetribe (lehengas, sarees, salwar/menswear shared).
// Blouse, Indowestern, Kidswear, Footwear, Other DO NOT have an items_included field.
export const ITEMS_INCLUDED_OPTIONS: Record<string, string[]> = {
  Lehenga: ["Lehenga skirt", "Dupatta", "Lehenga top/blouse", "Matching potli bag/purse"],
  Saree: ["Stitched Blouse", "Blouse piece (material)", "Petticoat/Underskirt"],
  "Suit/Salwar": ["Kurta/Kurti", "Dupatta", "Bottoms (e.g. Pant, Salwar, Shalwar, Sharara)"],
  // Menswear shares the Suit/Salwar items list per Sharetribe.
  Menswear: ["Kurta/Kurti", "Dupatta", "Bottoms (e.g. Pant, Salwar, Shalwar, Sharara)"],
};

// ============================================================
// Designers — live app list (31 designers, incl. Pakistani)
// ============================================================

export const POPULAR_DESIGNERS = [
  "Abhinav Mishra",
  "Abu Jani & Sandeep Khosla",
  "Anamika Khanna",
  "Anita Dongre",
  "Anushree Reddy",
  "Asim Jofa",
  "Dolly J",
  "Faiza Saqlain",
  "Falguni Shane Peacock",
  "Faraz Manan",
  "Gaurav Gupta",
  "Hussain Rehar",
  "Jade by Monica & Karishma",
  "Mahima Mahajan",
  "Manish Malhotra",
  "Maria B",
  "Masaba Gupta (House of Masaba)",
  "Mohsin Naveed Ranjha",
  "Nikita Gujral",
  "Papa Don't Preach by Shubhika",
  "Payal Singhal",
  "Ritu Kumar",
  "Sabyasachi Mukherjee",
  "Sana Safinaz",
  "Sania Maskatiya",
  "Seema Gujral",
  "Sobia Nazir",
  "Suffuse by Sana Yasir",
  "Tarun Tahiliani",
  "Vvani by Vani Vats",
  "Other",
] as const;

// Dry cleaning status — matching live Play Store app
export const DRY_CLEANING_STATUSES = [
  "Pre-loved, never dry cleaned",
  "Pre-loved, previously dry cleaned",
  "Brand new, never dry cleaned",
] as const;
export type DryCleaningStatus = (typeof DRY_CLEANING_STATUSES)[number];

// ============================================================
// Primary colours — matching live Play Store app (20 colours)
// ============================================================

export const PRIMARY_COLOURS = [
  "Black",
  "Grey",
  "White",
  "Brown",
  "Tan",
  "Cream",
  "Yellow",
  "Red",
  "Burgundy",
  "Orange",
  "Pink",
  "Purple",
  "Blue",
  "Navy",
  "Green",
  "Khaki",
  "Multi",
  "Silver",
  "Gold",
  "Other",
] as const;
export type PrimaryColour = (typeof PRIMARY_COLOURS)[number];

// ============================================================
// Countries (seller location) — matching live app
// ============================================================

export const SELLER_COUNTRIES = [
  "Australia",
  "New Zealand",
  "United States",
  "Canada",
  "United Kingdom",
] as const;

// Country codes used in profiles.location
export const COUNTRY_CODES = ["AU", "NZ", "US", "CA", "GB"] as const;

// ============================================================
// Country of origin — matching live Play Store app
// ============================================================

export const COUNTRIES_OF_ORIGIN = [
  "India",
  "Indian - Designer",
  "Pakistan",
  "Pakistani - Designer",
  "Nepal",
  "Bangladesh",
  "Sri Lanka",
  "Maldives",
  "Afghanistan",
  "Bhutan",
  "Other",
  "Other - Designer",
] as const;
export type CountryOfOrigin = (typeof COUNTRIES_OF_ORIGIN)[number];

// ============================================================
// Standardized sizes — matching live Play Store app
// ============================================================

export const WOMENS_SIZES = [
  "UK4 / US0 / AU4",
  "UK6 / US2 / AU6",
  "UK8 / US4 / AU8",
  "UK10 / US6 / AU10",
  "UK12 / US8 / AU12",
  "UK14 / US10 / AU14",
  "UK16 / US12 / AU16",
  "UK18 / US14 / AU18",
  "UK20 / US16 / AU20",
  "UK22 / US18 / AU22",
  "UK24 / US20 / AU24",
  "UK26 / US22 / AU26",
  "UK28 / US24 / AU28",
  "Free Size",
] as const;

export const MENSWEAR_KIDSWEAR_SIZES = [
  "XXS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "XXL",
  "3XL",
  "4XL",
  "Free size",
] as const;

export const FOOTWEAR_SIZES = [
  "AU4 / UK2 / US5 / EU35",
  "AU5 / UK3 / US6 / EU36",
  "AU6 / UK4 / US7 / EU37",
  "AU7 / UK5 / US8 / EU38",
  "AU8 / UK6 / US9 / EU39",
  "AU9 / UK7 / US10 / EU40",
  "AU10 / UK8 / US11 / EU41",
  "AU11 / UK9 / US12 / EU42",
  "AU12 / UK10 / US14 / EU43",
  "AU13 / UK11 / US15 / EU44",
  "AU14 / UK12 / US16 / EU45",
] as const;

export type SizeType = "womens" | "menswear_kidswear" | "footwear" | "free_size";

// Which size chart a category uses (matches Sharetribe field assignments).
// Sarees have no required size (length only — handled via measurements free text).
// "Other" allows women's sizing per Sharetribe (estimateWomenSSizeAu applies to "other").
export const CATEGORY_SIZE_TYPE: Record<ListingCategory, SizeType | null> = {
  Lehenga: "womens",
  Saree: "womens",
  "Suit/Salwar": "womens",
  Indowestern: "womens",
  Blouse: "womens",
  Menswear: "menswear_kidswear",
  Kidswear: "menswear_kidswear",
  Footwear: "footwear",
  // Jewellery has no sizing — necklaces / earrings / bangles don't follow
  // clothing-size conventions.
  Jewellery: null,
  Other: "womens",
};

// Admin curation tag options
export const CURATION_TAGS = [
  "Bridal Edit",
  "Designer Edit",
  "Top Picks",
  "Popular Brands",
] as const;
export type CurationTag = (typeof CURATION_TAGS)[number];

// ============================================================
// Per-category field visibility — single source of truth.
// Matches Sharetribe field assignments from the live platform.
// Drives both the listing form pickers and GET /api/listing-config.
// ============================================================

export interface CategoryFieldConfig {
  size_type: SizeType | null;
  shows_items_included: boolean;
  shows_fabric: boolean;
  shows_dry_cleaning: boolean;
  shows_measurements: boolean;
  shows_alteration: boolean;
  // Fully enumerated list of fields the frontend must collect before allowing
  // the seller to activate the listing. Universal fields (title, category,
  // condition, price, original_price, negotiable, photos) appear here too so
  // the frontend doesn't have to compose from multiple sources.
  // `photos` represents at least PHOTO_MIN_COUNT (3) product photos.
  required_fields: string[];
}

// Universal required fields — apply to every category per Sharetribe spec.
// Size is added per-category below based on whether size_type is non-null.
const UNIVERSAL_REQUIRED = [
  "title",
  "category",
  "condition",
  "price_amount",
  "original_price_amount",
  "negotiable",
  "photos",
] as const;

/** Minimum number of product photos required to activate a listing. */
export const PHOTO_MIN_COUNT = 3;

const WITH_SIZE = [...UNIVERSAL_REQUIRED, "estimated_size"];

// "Other" follows strict CSV reading: gets women's size but no clothing-only
// fields. Flip the bools below if the product team wants Other treated as a
// clothing catch-all.
export const LISTING_CATEGORY_CONFIG: Record<ListingCategory, CategoryFieldConfig> = {
  Lehenga:       { size_type: "womens",            shows_items_included: true,  shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Saree:         { size_type: "womens",            shows_items_included: true,  shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  "Suit/Salwar": { size_type: "womens",            shows_items_included: true,  shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Indowestern:   { size_type: "womens",            shows_items_included: false, shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Blouse:        { size_type: "womens",            shows_items_included: false, shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Menswear:      { size_type: "menswear_kidswear", shows_items_included: true,  shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Kidswear:      { size_type: "menswear_kidswear", shows_items_included: false, shows_fabric: true,  shows_dry_cleaning: true,  shows_measurements: true,  shows_alteration: true,  required_fields: WITH_SIZE },
  Footwear:      { size_type: "footwear",          shows_items_included: false, shows_fabric: false, shows_dry_cleaning: false, shows_measurements: false, shows_alteration: false, required_fields: WITH_SIZE },
  // Jewellery is sizeless — no estimated_size required; no fabric / dry-cleaning
  // / measurements / alteration apply to jewellery items.
  Jewellery:     { size_type: null,                shows_items_included: false, shows_fabric: false, shows_dry_cleaning: false, shows_measurements: false, shows_alteration: false, required_fields: [...UNIVERSAL_REQUIRED] },
  Other:         { size_type: "womens",            shows_items_included: false, shows_fabric: false, shows_dry_cleaning: false, shows_measurements: false, shows_alteration: false, required_fields: WITH_SIZE },
};

// ============================================================
// Measurement fields vary by category
// ============================================================

export interface Measurements {
  bust?: string;
  waist?: string;
  hip?: string;
  length?: string;
  sleeve_length?: string;
  chest?: string;
  age_range?: string;
}

// Sharetribe treats measurements as one optional free-text field for all
// clothing categories. We keep a structured per-category hint list here for
// the form UX (suggested fields), but none of these are hard-required at the
// API level — see the listings POST validator which checks measurements as
// an optional object.
export const REQUIRED_MEASUREMENTS: Record<
  ListingCategory,
  (keyof Measurements)[]
> = {
  Lehenga: ["bust", "waist", "length"],
  Saree: ["length"],
  "Suit/Salwar": ["bust", "waist", "hip", "length", "sleeve_length"],
  Indowestern: ["bust", "waist", "length"],
  Blouse: ["bust", "waist", "length", "sleeve_length"],
  Menswear: ["chest", "waist", "length", "sleeve_length"],
  Kidswear: ["chest", "length", "age_range"],
  Footwear: [],
  Jewellery: [],
  Other: [],
};

// ============================================================
// Database row types
// ============================================================

export interface Listing {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  category: ListingCategory;
  condition: ListingCondition;
  measurements: Measurements;
  occasion_tags: OccasionTag[];
  colors: string[];
  price_amount: number;
  price_currency: string;
  original_price_amount: number | null;
  negotiable: boolean;
  status: ListingStatus;
  rejection_reason: string | null;
  stripe_account_id: string | null;
  shipping_info: string | null;
  created_at: string;
  updated_at: string;

  // Standardized size (live app field)
  estimated_size: string | null;
  size_type: SizeType | null;

  // Admin curation
  curation_tags: CurationTag[];

  // v2 fields (all nullable/defaulted in database)
  fabric_types: string[];
  work_types: string[];
  items_included: string[];
  designer_name: string | null;
  is_known_designer: boolean;
  designer_verification_url: string | null;
  country_of_origin: string | null;
  dry_cleaning_status: DryCleaningStatus | null;
  alteration_room: string | null;
  fit_tips: string | null;

  // Shipping v2
  shipping_cost_amount: number | null;
  free_shipping: boolean;

  // Video
  video_url: string | null;
  video_storage_path: string | null;
}

export interface ListingPhoto {
  id: string;
  listing_id: string;
  storage_path: string;
  url: string;
  position: number;
  created_at: string;
}

// ============================================================
// API input types
// ============================================================

export interface CreateListingInput {
  title: string;
  description?: string;
  category: ListingCategory;
  condition: ListingCondition;
  measurements?: Measurements;
  occasion_tags?: OccasionTag[];
  colors?: string[];
  price_amount: number;
  price_currency?: string;
  original_price_amount?: number;
  negotiable?: boolean;
  shipping_info?: string;
  status?: "draft" | "active";

  // Standardized size
  estimated_size?: string;
  size_type?: SizeType;

  // v2 fields
  fabric_types?: string[];
  work_types?: string[];
  items_included?: string[];
  designer_name?: string;
  is_known_designer?: boolean;
  country_of_origin?: string;
  dry_cleaning_status?: DryCleaningStatus;
  alteration_room?: string;
  fit_tips?: string;

  // Shipping v2
  shipping_cost_amount?: number;
  free_shipping?: boolean;
}

export interface UpdateListingInput extends Partial<CreateListingInput> {}

// ============================================================
// Listing with photos (for API responses)
// ============================================================

export interface ListingWithPhotos extends Listing {
  photos: ListingPhoto[];
  seller?: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
    location: string | null;
  };
}
