export interface StripeOnboardingResponse {
  url: string;
  account_id: string;
}

export type StripeAccountStatus =
  | "not_connected"
  | "onboarding_incomplete"
  | "pending_verification"
  | "verified"
  | "action_needed";

export interface StripeStatusResponse {
  status: StripeAccountStatus;
  account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}
