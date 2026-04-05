// ============================================================
// Categories — matching live Play Store app + Footwear
// ============================================================

export const LISTING_CATEGORIES = [
  "Lehenga",
  "Saree",
  "Suit/Salwar",
  "Anarkali",
  "Indowestern",
  "Sharara",
  "Jewellery",
  "Dupatta",
  "Blouse",
  "Menswear",
  "Kidswear",
  "Footwear",
  "Other",
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

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

// Fabric types — merged live app + new app values
export const FABRIC_TYPES = [
  "Art silk",
  "Chiffon",
  "Chinon",
  "Cotton",
  "Crepe",
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
  "Brocade",
  "Banarasi",
  "Jacquard",
  "Lycra",
  "Rayon",
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

export const ITEMS_INCLUDED_OPTIONS: Record<string, string[]> = {
  Lehenga: ["Lehenga skirt", "Lehenga top/blouse", "Dupatta", "Matching potli bag/purse"],
  Saree: ["Stitched Blouse", "Blouse piece (material)", "Petticoat/Underskirt"],
  "Suit/Salwar": ["Kurta/Kurti", "Dupatta", "Bottoms (e.g. Pant, Salwar, Shalwar, Sharara)"],
  Anarkali: ["Anarkali Kurta", "Bottom (Churidar/Legging)", "Dupatta"],
  Sharara: ["Top/Kurta", "Sharara", "Dupatta"],
  Menswear: ["Kurta/Kurti", "Dupatta", "Bottoms (e.g. Pant, Salwar, Shalwar, Sharara)"],
  Kidswear: ["Top/Kurta", "Bottom", "Dupatta/Stole", "Accessories"],
  Jewellery: [
    "Necklace",
    "Earrings",
    "Bangles/Choori",
    "Maang Tikka",
    "Ring",
    "Anklet/Payal",
    "Nose Ring/Nath",
  ],
  Dupatta: ["Dupatta"],
  Blouse: ["Blouse"],
  Indowestern: ["Top/Blouse", "Bottom/Skirt", "Dupatta/Stole", "Jacket/Cape"],
  Footwear: ["Shoes", "Juttis/Mojris", "Sandals", "Heels"],
  Other: [],
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
  "Dry-cleaned less than 1 month ago",
  "Dry-cleaned over 1 month ago",
  "Pre-loved and not dry cleaned",
  "New, therefore not dry cleaned",
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
export const COUNTRY_CODES = ["AU", "NZ", "US", "CA", "UK"] as const;

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

// Which size chart a category uses
export const CATEGORY_SIZE_TYPE: Record<ListingCategory, SizeType | null> = {
  Lehenga: "womens",
  Saree: null,
  "Suit/Salwar": "womens",
  Anarkali: "womens",
  Indowestern: "womens",
  Sharara: "womens",
  Jewellery: null,
  Dupatta: null,
  Blouse: "womens",
  Menswear: "menswear_kidswear",
  Kidswear: "menswear_kidswear",
  Footwear: "footwear",
  Other: null,
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

// Required measurements per category
export const REQUIRED_MEASUREMENTS: Record<
  ListingCategory,
  (keyof Measurements)[]
> = {
  Lehenga: ["bust", "waist", "length"],
  Saree: ["length"],
  "Suit/Salwar": ["bust", "waist", "hip", "length", "sleeve_length"],
  Anarkali: ["bust", "waist", "length"],
  Sharara: ["waist", "hip", "length"],
  Blouse: ["bust", "waist", "length", "sleeve_length"],
  Menswear: ["chest", "waist", "length", "sleeve_length"],
  Kidswear: ["chest", "length", "age_range"],
  Jewellery: [],
  Dupatta: [],
  Indowestern: [],
  Footwear: [],
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

  // Rental fields
  is_rentable: boolean;
  rental_daily_rate: number | null;
  rental_4to7_rate: number | null;
  rental_8to14_rate: number | null;
  rental_cleaning_fee: number | null;
  rental_security_deposit: number | null;

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

  // Rental fields
  is_rentable?: boolean;
  rental_daily_rate?: number;
  rental_4to7_rate?: number;
  rental_8to14_rate?: number;
  rental_cleaning_fee?: number;
  rental_security_deposit?: number;

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
