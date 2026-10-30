// SPDX-License-Identifier: AGPL-3.0-only

export type BillingTier = "sandbox" | "launch" | "growth" | "scale";

export interface TierFeature {
  label: string;
  included: boolean;
}

export interface TierDescriptor {
  tier: BillingTier;
  name: string;
  tagline: string;
  price: string;
  cadence: "free" | "monthly";
  perEmail: string | null;
  features: TierFeature[];
}

export interface SendingAddon {
  monthlyCap: number;
  used: number;
  daysRemaining: number;
  overageEnabled: boolean;
  /** How far `used` is past `monthlyCap` this period (0 when under). */
  overageUnits?: number;
  /** Optional ceiling on billable overage units; null/undefined = uncapped. */
  overageCap?: number | null;
  /**
   * True only when overage would actually bill — the preference is on AND
   * Stripe metered billing is configured. When false the UI shows the toggle as
   * inert rather than implying money moves.
   */
  overageChargeable?: boolean;
  /**
   * Whether Stripe metered billing is wired, independent of the preference, so
   * the UI can distinguish "off" from "on but not yet charged".
   */
  overageBillingConfigured?: boolean;
}

export interface BillingState {
  tier: BillingTier;
  startedAt: string;
  sendingAddon: SendingAddon | null;
  card: { brand: string; last4: string } | null;
}

export interface Invoice {
  id: string;
  number?: string;
  date: string;
  amount: string;
  status: "paid" | "open" | "refunded";
  downloadUrl: string;
}

export interface UsagePoint {
  date: string;
  sent: number;
}

export interface PlanUsageResource {
  resource: string;
  current: number;
  limit: number;
  percent: number;
  exceeded: boolean;
}

export interface SendsProjection {
  current: number;
  limit: number;
  as_of: string;
  period_start: string;
  period_end: string;
  avg_per_day: number;
  days_elapsed: number;
  days_in_period: number;
  projected_end_of_period: number;
  projected_exceed_date?: string | null;
  on_track_to_exceed: boolean;
}

export interface BillingPlanSummary {
  tier: string;
  current_period_end?: string;
  resources: PlanUsageResource[];
  sends_projection?: SendsProjection;
}

export interface LimitsUsageResponse {
  tier: string;
  rows: PlanUsageResource[];
}
