/**
 * segmentPnlClient — thin fetch wrapper for the Segment P&L surface
 * (feature #4; apps/api/internal/segments/pnl*.go).
 *
 * Lives next to the segments UI (sibling of segmentsClient.ts) rather
 * than mutating the shared lib/api-client.ts. It delegates to the canonical
 * apiRequest helper so native headers, workspace + bearer/session resolution,
 * offline policy, retry behavior, and diagnostics match the rest of desktop.
 */

import {
  apiRequest,
  type ApiResult,
} from "../../lib/api-client";

/** Per-currency revenue disclosure (segments.PnLCurrencyTotal). */
export interface PnLCurrencyTotal {
  currency: string;
  conversions: number;
  revenue_cents: number;
}

/** Attribution provenance split (segments.PnLAttributionProvenance) —
 *  never present last_touch as certain. */
export interface PnLAttributionProvenance {
  explicit: number;
  last_touch: number;
  none: number;
  code_redemption: number;
  campaign_vanity_path: number;
  unclassified: number;
}

/** Holdout-validated causal lift (segments.SegmentLiftResult). */
export interface SegmentLiftResult {
  holdout_percent: number;
  control_size: number;
  treated_size: number;
  control_conv_rate: number;
  treated_conv_rate: number;
  incremental_lift: number;
  lift_percent: number;
  window_days: number;
  confidence_low: boolean;
}

/** GET /api/v1/segments/{id}/pnl (segments.SegmentPnLResponse). */
export interface SegmentPnLResponse {
  segment_id: string;
  member_count: number;
  window_days: number;
  currency?: string;
  currencies: PnLCurrencyTotal[];

  revenue_cents: number;
  revenue_conversions: number;
  revenue_per_member_cents?: number | null;
  revenue_scope: string;
  revenue_provenance: PnLAttributionProvenance;

  aov_cents?: number | null;
  aov_order_count: number;
  aov_currency?: string;

  clv_members_scored: number;
  clv_historic_sum_cents: number;
  clv_predicted_sum_cents: number;
  clv_realised_vs_predicted?: number | null;

  unsub_count: number;
  complaint_count: number;
  total_cost_cents: number;
  cost_currency: string;
  cost_config_present: boolean;

  net_contribution_cents?: number | null;
  net_contribution_per_member_cents?: number | null;

  lift?: SegmentLiftResult | null;
  lift_skipped_reason?: string;

  sequence_attribution_unsupported: boolean;
  cross_currency_revenue_excluded: boolean;
  generated_at: string;
}

/** GET /api/v1/segments/pnl/compare (segments.SegmentCompareResponse). */
export interface SegmentCompareResponse {
  items: SegmentPnLResponse[];
  window_days: number;
  days: number;
}

/** GET /api/v1/segments/{id}/engagement-summary
 *  (segments.SegmentEngagementSummaryResponse) — SUB-036. Engagement
 *  side of the audience comparison: open/click/unsub rates aggregated
 *  from subscriber_events scoped to the segment's membership. Rates are
 *  in [0,1]; rate_basis discloses the denominator (delivery-outcome
 *  events for members in the window). */
export interface SegmentEngagementSummary {
  segment_id: string;
  window_days: number;
  member_count: number;

  sends: number;
  opens: number;
  clicks: number;
  unsubs: number;
  bounces: number;
  complaints: number;

  open_rate: number;
  click_rate: number;
  unsub_rate: number;
  rate_basis: string;

  generated_at: string;
}

/** segment_holdouts row (segments.SegmentHoldoutConfig). */
export interface SegmentHoldoutConfig {
  segment_id: string;
  percent: number;
  seed: string;
  window_days: number;
  decided_at?: string | null;
  created_at: string;
  updated_at: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  return apiRequest<T>(path, init, { timeoutMs: 30_000 });
}

export const segmentPnlClient = {
  /** GET /api/v1/segments/{id}/pnl?days=&include_lift= */
  pnl(
    id: string,
    opts: { days?: number; includeLift?: boolean } = {},
  ): Promise<ApiResult<SegmentPnLResponse>> {
    const params = new URLSearchParams();
    if (opts.days != null) params.set("days", String(opts.days));
    if (opts.includeLift) params.set("include_lift", "true");
    const qs = params.toString();
    return call<SegmentPnLResponse>(
      `/api/v1/segments/${encodeURIComponent(id)}/pnl${qs ? `?${qs}` : ""}`,
    );
  },
  /** GET /api/v1/segments/pnl/compare?ids=a,b,c&days= */
  compare(
    ids: string[],
    opts: { days?: number } = {},
  ): Promise<ApiResult<SegmentCompareResponse>> {
    const params = new URLSearchParams();
    params.set("ids", ids.join(","));
    if (opts.days != null) params.set("days", String(opts.days));
    return call<SegmentCompareResponse>(
      `/api/v1/segments/pnl/compare?${params.toString()}`,
    );
  },
  /** GET /api/v1/segments/{id}/engagement-summary?days= (SUB-036). */
  engagementSummary(
    id: string,
    opts: { days?: number } = {},
  ): Promise<ApiResult<SegmentEngagementSummary>> {
    const params = new URLSearchParams();
    if (opts.days != null) params.set("days", String(opts.days));
    const qs = params.toString();
    return call<SegmentEngagementSummary>(
      `/api/v1/segments/${encodeURIComponent(id)}/engagement-summary${qs ? `?${qs}` : ""}`,
    );
  },
  /** POST /api/v1/segments/{id}/holdout */
  configureHoldout(
    id: string,
    body: { percent: number; windowDays: number },
  ): Promise<ApiResult<SegmentHoldoutConfig>> {
    return call<SegmentHoldoutConfig>(
      `/api/v1/segments/${encodeURIComponent(id)}/holdout`,
      {
        method: "POST",
        body: JSON.stringify({
          percent: body.percent,
          window_days: body.windowDays,
        }),
      },
    );
  },
  /** DELETE /api/v1/segments/{id}/holdout */
  deleteHoldout(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return call<{ ok: boolean }>(
      `/api/v1/segments/${encodeURIComponent(id)}/holdout`,
      { method: "DELETE" },
    );
  },
};
