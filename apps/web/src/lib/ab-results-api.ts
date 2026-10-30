// SPDX-License-Identifier: AGPL-3.0-only
//
// A/B test result reader.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./abtests-mocks");

// Sibling of abtests-api.ts / campaigns-api.ts: real fetch by default; mocks
// are opt-in via NEXT_PUBLIC_USE_MOCKS=1. Without this the A/B Results page
// hits the real backend in the demo/preview build and 500s (CAMP-004).
async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export type ABMetric = "open_rate" | "click_rate" | "reply_rate";

export interface ABResultsVariant {
  id?: string;
  variant_index: number;
  variant_label?: string;
  subject?: string;
  sent: number;
  hits: number;
  rate: number;
  is_control: boolean;
}

export interface ABFrequentistOutcome {
  z_score: number;
  p_value: number;
  lift_percent: number;
  significant_at_95: boolean;
  significant_after_correction: boolean;
}

export interface ABBayesianOutcome {
  prob_b_better: number;
  expected_lift: number;
  credible_interval_95: [number, number];
}

export interface ABBonferroni {
  num_comparisons: number;
  family_alpha: number;
  corrected_alpha: number;
  applied_to_frequentist: boolean;
  notes?: string;
}

export interface ABWinner {
  variant_index: number;
  variant_id?: string;
  method: "bayesian" | "frequentist" | "not_decided";
  confidence: number;
}

export interface ABResultsResponse {
  campaign_id: string;
  metric: ABMetric;
  variants: ABResultsVariant[];
  frequentist: Record<string, ABFrequentistOutcome>;
  bayesian: Record<string, ABBayesianOutcome>;
  bonferroni: ABBonferroni;
  winner?: ABWinner;
}

export function getABResults(
  campaignID: string,
  metric: ABMetric = "open_rate",
  signal?: AbortSignal,
): Promise<ABResultsResponse> {
  return withMockFallback(
    () =>
      api.get<ABResultsResponse>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab-results`,
        { query: { metric }, signal },
      ),
    async () =>
      (await loadMocks()).mockABResults(campaignID, metric) as ABResultsResponse,
  );
}

// --- Bandit allocation-drift over time (CAMP-042). GET
// /api/v1/campaigns/{id}/ab-weight-history returns one series per variant of
// how traffic weight shifted at each recompute. ---
export interface ABWeightPoint {
  at: string;
  weight: number;
}
export interface ABWeightSeries {
  variant_id: string;
  label: string;
  points: ABWeightPoint[];
}
export interface ABWeightHistoryResponse {
  campaign_id: string;
  series: ABWeightSeries[];
}

export function getABWeightHistory(
  campaignID: string,
): Promise<ABWeightHistoryResponse> {
  return withMockFallback(
    () =>
      api.get<ABWeightHistoryResponse>(
        `/api/v1/campaigns/${encodeURIComponent(campaignID)}/ab-weight-history`,
      ),
    async () => (await loadMocks()).mockABWeightHistory(campaignID),
  );
}
