/**
 * holdout-lift — F02 on the desktop.
 *
 * A holdout withholds a campaign from a random slice of the audience, so the
 * gap between the two arms is what the campaign CAUSED. Every other figure on
 * a campaign page is correlational: it says what happened after the send.
 *
 * That distinction survives only while the comparison is powered, which is why
 * the server refuses to emit a lift figure for an underpowered test. The
 * refusal is preserved here in the type system rather than by convention: the
 * underpowered variant has no field a component could read a number out of.
 */

import { apiRequest } from "./api-client";
import type { ApiResult } from "./api/result";

export interface HoldoutSignificance {
  control_rate: number;
  treatment_rate: number;
  absolute_lift: number | null;
  relative_lift: number | null;
  incremental_conversions: number | null;
  p_value: number;
  ci_low: number | null;
  ci_high: number | null;
  powered: boolean;
  minimum_detectable_effect: number;
  underpowered_reason?: string;
}

export interface HoldoutLift {
  campaign_id: string;
  percent: number;
  status?: string;
  message?: string;
  held_out_subs?: number;
  sent_subs?: number;
  held_out_click_rate?: number;
  sent_click_rate?: number;
  significance?: HoldoutSignificance;
}

export type LiftVerdict =
  | { kind: "pending"; message: string }
  | { kind: "underpowered"; reason: string; minimumDetectableEffect: number }
  | {
      kind: "measured";
      absoluteLift: number;
      relativeLift: number | null;
      incrementalConversions: number | null;
      interval: { low: number; high: number } | null;
      /** The interval includes zero — the campaign may have caused nothing. */
      spansZero: boolean;
      pValue: number;
    };

export function liftVerdict(lift: HoldoutLift): LiftVerdict {
  if (lift.status === "pending" || !lift.significance) {
    return {
      kind: "pending",
      message:
        lift.message ??
        "This campaign has not been sent yet, so there is nothing to compare.",
    };
  }
  const s = lift.significance;
  if (!s.powered || s.absolute_lift === null) {
    return {
      kind: "underpowered",
      reason:
        s.underpowered_reason?.trim() ||
        "The two groups are too small to separate a real effect from noise.",
      minimumDetectableEffect: s.minimum_detectable_effect,
    };
  }
  const interval =
    s.ci_low !== null && s.ci_high !== null
      ? { low: s.ci_low, high: s.ci_high }
      : null;
  return {
    kind: "measured",
    absoluteLift: s.absolute_lift,
    relativeLift: s.relative_lift,
    incrementalConversions: s.incremental_conversions,
    interval,
    spansZero: interval !== null && interval.low <= 0 && interval.high >= 0,
    pValue: s.p_value,
  };
}

/**
 * A signed percentage. The sign is load-bearing: a holdout can show the
 * campaign performed WORSE than sending nothing, and that must read as a loss
 * rather than as a smaller win.
 */
export function formatSignedPercent(value: number): string {
  const sign = value < 0 ? "−" : "+";
  return `${sign}${(Math.abs(value) * 100).toFixed(1)}%`;
}

export function getHoldoutLift(campaignId: string): Promise<ApiResult<unknown>> {
  return apiRequest(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/holdout/lift`,
  );
}
