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
] as const;
export type OccasionTag = (typeof OCCASION_TAGS)[number];

// Measurement fields vary by category
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

// Database row types
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
}

export interface ListingPhoto {
  id: string;
  listing_id: string;
  storage_path: string;
  url: string;
  position: number;
  created_at: string;
}

// API input types
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
}

export interface UpdateListingInput extends Partial<CreateListingInput> {}

// Listing with photos (for API responses)
export interface ListingWithPhotos extends Listing {
  photos: ListingPhoto[];
  seller?: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
    location: string | null;
  };
}
