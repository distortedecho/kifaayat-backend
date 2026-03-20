// Category enum matching database CHECK constraint
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
  "Other",
] as const;
export type ListingCategory = (typeof LISTING_CATEGORIES)[number];

// Condition enum
export const LISTING_CONDITIONS = [
  "New",
  "Like New",
  "Good",
  "Fair",
] as const;
export type ListingCondition = (typeof LISTING_CONDITIONS)[number];

// Status enum (Phase 3: added pending_review between draft and active for admin moderation)
export const LISTING_STATUSES = [
  "draft",
  "pending_review",
  "active",
  "reserved",
  "sold",
  "deactivated",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

// Occasion tags
export const OCCASION_TAGS = [
  "Wedding",
  "Mehendi",
  "Sangeet",
  "Festive",
  "Party",
  "Formal",
  "Casual",
  "Eid",
  "Diwali",
  "Haldi",
] as const;
export type OccasionTag = (typeof OCCASION_TAGS)[number];

// ============================================================
// v2 Predefined Lists
// ============================================================

// Fabric types for multi-select chips
export const FABRIC_TYPES = [
  "Silk",
  "Georgette",
  "Chiffon",
  "Velvet",
  "Cotton",
  "Net",
  "Organza",
  "Crepe",
  "Satin",
  "Brocade",
  "Banarasi",
  "Jacquard",
  "Lycra",
  "Linen",
  "Rayon",
  "Other",
] as const;
export type FabricType = (typeof FABRIC_TYPES)[number];

// Work/embroidery types for multi-select chips
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

// Items included options per category (dynamic checkboxes)
export const ITEMS_INCLUDED_OPTIONS: Record<string, string[]> = {
  Lehenga: ["Skirt", "Blouse", "Dupatta", "Cancan/Petticoat", "Belt/Kamar Patti"],
  Saree: ["Saree", "Blouse Piece", "Petticoat", "Fall & Pico Done"],
  "Suit/Salwar": ["Kurta", "Bottom (Salwar/Churidar/Palazzo)", "Dupatta"],
  Anarkali: ["Anarkali Kurta", "Bottom (Churidar/Legging)", "Dupatta"],
  Sharara: ["Top/Kurta", "Sharara", "Dupatta"],
  Menswear: ["Kurta", "Pajama/Churidar", "Dupatta/Stole", "Jacket/Waistcoat"],
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
  Other: [],
};

// Popular South Asian designers for autocomplete
export const POPULAR_DESIGNERS = [
  "Sabyasachi Mukherjee",
  "Anita Dongre",
  "Manish Malhotra",
  "Tarun Tahiliani",
  "Abu Jani Sandeep Khosla",
  "Ritu Kumar",
  "Rohit Bal",
  "JJ Valaya",
  "Anamika Khanna",
  "Masaba Gupta",
  "Papa Don't Preach by Shubhika",
  "Ridhi Mehra",
  "Falguni Shane Peacock",
  "Gaurav Gupta",
  "Varun Bahl",
  "Shyamal & Bhumika",
  "Payal Singhal",
  "Raw Mango",
  "Seema Gujral",
  "Jade by Monica and Karishma",
] as const;

// Dry cleaning status options
export const DRY_CLEANING_STATUSES = [
  "required",
  "recommended",
  "not_needed",
  "already_cleaned",
] as const;
export type DryCleaningStatus = (typeof DRY_CLEANING_STATUSES)[number];

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
  status?: "draft" | "active"; // can only create as draft or active

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
