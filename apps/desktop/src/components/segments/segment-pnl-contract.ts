import type {
  PnLCurrencyTotal,
  SegmentLiftResult,
  SegmentPnLResponse,
} from "./segmentPnlClient";

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const optionalFinite = (value: unknown): boolean =>
  value === undefined || value === null || finite(value);

function isCurrencyTotal(value: unknown): value is PnLCurrencyTotal {
  if (!value || typeof value !== "object") return false;
  const total = value as Record<string, unknown>;
  return (
    typeof total.currency === "string" &&
    finite(total.conversions) &&
    finite(total.revenue_cents)
  );
}

function isLift(value: unknown): value is SegmentLiftResult {
  if (!value || typeof value !== "object") return false;
  const lift = value as Record<string, unknown>;
  return (
    finite(lift.holdout_percent) &&
    finite(lift.control_size) &&
    finite(lift.treated_size) &&
    finite(lift.control_conv_rate) &&
    finite(lift.treated_conv_rate) &&
    finite(lift.incremental_lift) &&
    finite(lift.lift_percent) &&
    finite(lift.window_days) &&
    typeof lift.confidence_low === "boolean"
  );
}

/** Keep malformed successful P&L payloads out of the detail renderer. */
export function parseSegmentPnl(value: unknown): SegmentPnLResponse | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const provenance = data.revenue_provenance;
  if (!provenance || typeof provenance !== "object") return null;
  const attribution = provenance as Record<string, unknown>;
  if (
    typeof data.segment_id !== "string" ||
    !finite(data.member_count) ||
    !finite(data.window_days) ||
    !Array.isArray(data.currencies) ||
    !data.currencies.every(isCurrencyTotal) ||
    !finite(data.revenue_cents) ||
    !finite(data.revenue_conversions) ||
    !optionalFinite(data.revenue_per_member_cents) ||
    typeof data.revenue_scope !== "string" ||
    !finite(attribution.explicit) ||
    !finite(attribution.last_touch) ||
    !finite(attribution.none) ||
    !finite(attribution.code_redemption) ||
    !finite(attribution.campaign_vanity_path) ||
    !finite(attribution.unclassified) ||
    !optionalFinite(data.aov_cents) ||
    !finite(data.aov_order_count) ||
    !finite(data.clv_members_scored) ||
    !finite(data.clv_historic_sum_cents) ||
    !finite(data.clv_predicted_sum_cents) ||
    !optionalFinite(data.clv_realised_vs_predicted) ||
    !finite(data.unsub_count) ||
    !finite(data.complaint_count) ||
    !finite(data.total_cost_cents) ||
    typeof data.cost_currency !== "string" ||
    typeof data.cost_config_present !== "boolean" ||
    !optionalFinite(data.net_contribution_cents) ||
    !optionalFinite(data.net_contribution_per_member_cents) ||
    (data.lift !== undefined && data.lift !== null && !isLift(data.lift)) ||
    (data.lift_skipped_reason !== undefined &&
      typeof data.lift_skipped_reason !== "string") ||
    typeof data.sequence_attribution_unsupported !== "boolean" ||
    typeof data.cross_currency_revenue_excluded !== "boolean" ||
    typeof data.generated_at !== "string" ||
    (data.currency !== undefined && typeof data.currency !== "string") ||
    (data.aov_currency !== undefined && typeof data.aov_currency !== "string")
  ) {
    return null;
  }
  return data as unknown as SegmentPnLResponse;
}
