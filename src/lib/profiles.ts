import { createSupabaseAdmin } from "./supabase.js";

/**
 * Shared profile interface containing all commonly-needed profile columns.
 * Routes can destructure only the fields they need.
 */
export interface ProfileBase {
  id: string;
  profile_complete: boolean;
  is_admin: boolean;
  display_name: string | null;
  avatar_url: string | null;
  stripe_account_id: string | null;
  stripe_onboarding_complete: boolean;
}

/**
 * Look up the profile for a given Clerk user ID.
 * Selects all commonly-needed fields so individual routes don't need separate queries.
 * Returns null if no profile exists.
 */
export async function getProfileByClerkId(
  clerkUserId: string
): Promise<ProfileBase | null> {
  const supabase = createSupabaseAdmin();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, profile_complete, is_admin, display_name, avatar_url, stripe_account_id, stripe_onboarding_complete"
    )
    .eq("clerk_id", clerkUserId)
    .single();

  if (error || !data) return null;
  return data as ProfileBase;
}
