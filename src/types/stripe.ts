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
  // Stripe's per-account requirements bag. Frontend can use these to
  // render "Setup pending: 3 items left" copy and link the user back
  // to onboarding if currently_due is non-empty. All optional —
  // omitted when there's no Stripe account or the retrieve failed.
  requirements?: {
    currently_due: string[];
    past_due: string[];
    eventually_due: string[];
    disabled_reason: string | null;
  };
}
