// SPDX-License-Identifier: AGPL-3.0-only
//
// holdout-lift.ts — F02's client surface.
//
// A holdout answers "what did this campaign CAUSE" rather than "what happened
// after it": a randomly chosen slice is deliberately not sent to, and the
// difference between the two arms is the causal estimate. Everything else on
// the analytics page is correlational; this is the one number that is not.
//
// That distinction only survives while the comparison is powered, which is why
// the server refuses to emit a lift figure for an underpowered test. This
// module preserves that refusal in the type system: an underpowered verdict
// has no field to read a number out of, so a component cannot render one by
// accident.

import { api } from "@/lib/api";

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

export interface Holdout {
  campaign_id: string;
  percent: number;
  seed: string;
  decided_at?: string;
  held_out_count: number;
  sent_count: number;
  outcome_metric: string;
  conversion_window_days: number;
  minimum_relative_effect: number;
  assignment_ledger_version?: string;
  assignment_ledger_sha256?: string;
  created_at: string;
  updated_at: string;
}

export interface HoldoutLift {
  campaign_id: string;
  percent: number;
  status?: string;
  message?: string;
  held_out_subs?: number;
  sent_subs?: number;
  held_out_clicks?: number;
  sent_clicks?: number;
  held_out_click_rate?: number;
  sent_click_rate?: number;
  approximate?: boolean;
  significance?: HoldoutSignificance;
  incremental_lift?: number;
  lift_percent?: number;
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
      /**
       * True when the confidence interval includes zero — the campaign may
       * have caused nothing. Presenting the point estimate without saying so
       * is how a null result becomes a success story.
       */
      spansZero: boolean;
      pValue: number;
    };

/**
 * The one thing a caller may render.
 *
 * Deliberately a discriminated union rather than a struct with optional
 * fields: an underpowered result carries NO lift number, so there is nothing
 * for a component to reach for. That is the type-level version of the rule the
 * handler already enforces.
 */
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

export interface HoldoutReadiness {
  measurable: boolean;
  notes: string[];
}

/** What still has to be true before this holdout can produce a defensible number. */
export function holdoutReadiness(holdout: Holdout): HoldoutReadiness {
  const notes: string[] = [];
  if (!holdout.decided_at) {
    notes.push(
      "This campaign has not been sent, so the held-out group has not been decided yet.",
    );
  }
  // Without a frozen ledger there is no record of WHO was held out, so a
  // number computed later cannot be reproduced or defended.
  if (!holdout.assignment_ledger_sha256) {
    notes.push(
      "No frozen assignment ledger was recorded, so who was held out cannot be reproduced later.",
    );
  }
  return { measurable: notes.length === 0, notes };
}

/**
 * A signed percentage. The sign is not decoration: a holdout can show the
 * campaign performed WORSE than sending nothing, and that has to read as a
 * loss rather than as a smaller win.
 */
export function formatSignedPercent(value: number): string {
  const sign = value < 0 ? "−" : "+";
  return `${sign}${(Math.abs(value) * 100).toFixed(1)}%`;
}

export function getHoldout(campaignId: string): Promise<Holdout> {
  return api.get<Holdout>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/holdout`,
  );
}

export function getHoldoutLift(campaignId: string): Promise<HoldoutLift> {
  return api.get<HoldoutLift>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/holdout/lift`,
  );
}

// ---------------------------------------------------------------------------
// Creating a holdout
// ---------------------------------------------------------------------------

export interface HoldoutInput {
  percent: number;
  conversionWindowDays: number;
  minimumRelativeEffect: number;
}

/**
 * Mirrors the server's bounds (holdout.go: percent 0..50, window 1..30 days,
 * effect >0..1) so an operator is corrected in the form instead of by a 400.
 *
 * The server remains the authority — this is a courtesy, not a gate. Returns
 * EVERY problem rather than the first, because fixing one field at a time
 * across repeated submits is how people give up on a form.
 */
export function validateHoldoutInput(input: HoldoutInput): string[] {
  const problems: string[] = [];
  if (
    !Number.isFinite(input.percent) ||
    input.percent < 0 ||
    input.percent > 50
  ) {
    problems.push(
      "Hold out between 0% and 50% of the audience. Above half, you are no longer measuring a campaign — you are running a different one.",
    );
  }
  if (
    !Number.isInteger(input.conversionWindowDays) ||
    input.conversionWindowDays < 1 ||
    input.conversionWindowDays > 30
  ) {
    problems.push(
      "The conversion window must be between 1 and 30 days — long enough to catch the response, short enough that later campaigns are not credited to this one.",
    );
  }
  if (
    !Number.isFinite(input.minimumRelativeEffect) ||
    input.minimumRelativeEffect <= 0 ||
    input.minimumRelativeEffect > 1
  ) {
    problems.push(
      "The smallest effect worth detecting must be above 0% and at most 100%. Asking to detect any difference at all is a test no audience size can power.",
    );
  }
  return problems;
}

export function createHoldout(
  campaignId: string,
  input: HoldoutInput,
): Promise<Holdout> {
  return api.post<Holdout>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/holdout`,
    {
      percent: input.percent,
      conversion_window_days: input.conversionWindowDays,
      minimum_relative_effect: input.minimumRelativeEffect,
    },
    {
      requireOnline: true,
      maxAttempts: 1,
    },
  );
}

export function deleteHoldout(campaignId: string): Promise<void> {
  return api.delete<void>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/holdout`,
    {
      requireOnline: true,
      maxAttempts: 1,
    },
  );
}
