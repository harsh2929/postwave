import { rawRequest, type AIApiResult } from "./request";
import type { WeightHistoryResponseWire } from "@/lib/abWeightHistory";

export interface ABTestCreateInput {
  name: string;
  subject_variants: string[];
  audience_list_id?: string;
  audience_segment_id?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  preview_text?: string;
  from_name?: string;
  /**
   * G14 multivariate axis: 2+ names make the test the cross-product
   * subjects × from-names, capped server-side at 8 combos (abtest.go:80).
   * lib/campaignAbVariants owns the client-side cap check.
   */
  from_name_variants?: string[];
  reply_to?: string;
  /** 0-100; defaults to even split server-side when omitted. */
  split_percentage?: number;
  /**
   * Stored verbatim on the parent. The one shape mobile sends is
   * AB_BANDIT_DELIVERY_SETTINGS (lib/campaignAbVariants) — the same
   * `{ab_test:{bandit,policy,explore_floor}}` desktop's runBandit posts.
   */
  delivery_settings?: Record<string, unknown>;
}

export interface ABTestCampaign {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
}

export interface ABTestCreateResponse {
  parent: ABTestCampaign;
  children: ABTestCampaign[];
}

export async function createABTestCampaign(
  input: ABTestCreateInput,
): Promise<AIApiResult<ABTestCreateResponse>> {
  const res = await rawRequest<ABTestCreateResponse | null>(
    "POST",
    "/api/v1/campaigns/ab-test",
    input,
  );
  if (res.error) return { data: null, error: res.error };
  if (!res.data?.parent) {
    return {
      data: null,
      error: { status: 0, message: "ab-test create returned no parent" },
    };
  }
  return { data: res.data, error: null };
}

export type ABMetric = "open_rate" | "click_rate" | "reply_rate";

export interface ABResultsVariant {
  id: string;
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

export async function getABResults(
  campaignId: string,
  metric: ABMetric = "open_rate",
): Promise<AIApiResult<ABResultsResponse>> {
  return rawRequest<ABResultsResponse>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab-results?metric=${encodeURIComponent(metric)}`,
  );
}

/**
 * The bandit's allocation ledger — every recompute of every arm's traffic
 * share (apps/api/internal/abtests/handlers.go:50).
 *
 * Typed as the wire shape rather than a chart-ready one: normalising ragged
 * per-arm point lists onto one axis is arithmetic with real failure modes, so
 * it lives in `lib/abWeightHistory` where it can be tested in node.
 *
 * A fixed (non-bandit) split has never written a row here, so `{series: []}`
 * is the ORDINARY answer, not a failure.
 */
export async function getABWeightHistory(
  campaignId: string,
): Promise<AIApiResult<WeightHistoryResponseWire>> {
  return rawRequest<WeightHistoryResponseWire>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/ab-weight-history`,
  );
}
