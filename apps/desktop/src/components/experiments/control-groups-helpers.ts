/**
 * control-groups-helpers — pure logic behind ControlGroupsCard.
 *
 * Mirrors apps/api/internal/control_group exactly:
 *   - percent bounds 0..50 ("percent must be 0..50" in Repo.Create);
 *   - statuses active|paused|dissolved (control_groups.status CHECK);
 *   - report `incremental_lift` = treated − control engagement, both
 *     fractions 0..1 (Repo.Report) — we render percentage POINTS, not
 *     a relative %, because that's what the subtraction yields;
 *   - PATCH only mutates description / status / ends_at — name and
 *     percent are immutable after create (the seed bucketing would
 *     silently re-shuffle members otherwise), so the edit form must
 *     not offer them.
 *
 * Kept free of React/DOM so the node-env vitest suite can exercise the
 * validation + formatting paths directly.
 */

import type { ControlGroupReport } from "../../lib/api-client";

/** Mirrors the control_groups.status CHECK constraint. */
export const CONTROL_GROUP_STATUSES = [
  "active",
  "paused",
  "dissolved",
] as const;
export type ControlGroupStatus = (typeof CONTROL_GROUP_STATUSES)[number];

/** Report window choices; server clamps to 1..365 and defaults to 30. */
export const REPORT_WINDOW_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_REPORT_WINDOW = 30;

/** Form draft as typed by the operator (percent stays a string). */
export interface ControlGroupDraft {
  name: string;
  description: string;
  percent: string;
}

export interface ControlGroupDraftValidation {
  ok: boolean;
  errors: { name?: string; percent?: string };
  /** Parsed percent — only set when `ok`. */
  percent?: number;
}

/**
 * Strict numeric parse for the percent input. Returns null for empty
 * strings, whitespace, or anything Number() can't fully consume
 * ("10%" is a typo, not 10).
 */
export function parsePercent(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Client-side mirror of Repo.Create's validation so the 400 backstop
 * almost never fires: name required, percent numeric within 0..50.
 */
export function validateControlGroupDraft(
  draft: ControlGroupDraft,
): ControlGroupDraftValidation {
  const errors: ControlGroupDraftValidation["errors"] = {};
  if (!draft.name.trim()) {
    errors.name = "Name is required.";
  }
  const pct = parsePercent(draft.percent);
  if (pct == null) {
    errors.percent = "Enter a holdback percent (number).";
  } else if (pct < 0 || pct > 50) {
    // Server rule: "percent must be 0..50".
    errors.percent = "Percent must be between 0 and 50.";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors, percent: pct! };
}

/** Badge class for a control-group status chip. */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "badge accent";
    case "paused":
      return "badge warning";
    case "dissolved":
    default:
      return "badge";
  }
}

/** Fraction (0..1) → "12.3%"; null/undefined → em dash. */
export function fmtEngagementRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * A report is only statistically meaningful when both cohorts have
 * members — with an empty control bucket the engagement comparison is
 * a division-by-zero dressed up as 0%. The card must say so instead
 * of painting fake numbers.
 */
export function reportHasCohorts(report: ControlGroupReport): boolean {
  return report.control_size > 0 && report.treated_size > 0;
}

export interface LiftSummary {
  /** e.g. "+2.3 pts" — percentage POINTS (treated − control). */
  text: string;
  tone: "good" | "bad" | "neutral";
}

/**
 * A lift figure is publishable only when the server actually enforced the
 * control group at send time. While `enforced` is false the control cohort
 * received the campaign too, so treated-vs-control measures noise — the
 * server omits the numbers and we must not invent them.
 */
export function hasPublishableLift(report: ControlGroupReport): boolean {
  return report.enforced === true && report.incremental_lift != null;
}

/**
 * Render incremental_lift (treated − control, both fractions) as
 * signed percentage points. Sub-0.05pt deltas read as neutral noise.
 *
 * Returns an em dash when the server withheld the figure — previously this
 * multiplied `undefined` and rendered a literal "NaN pts".
 */
export function liftSummary(report: ControlGroupReport): LiftSummary {
  if (!hasPublishableLift(report)) return { text: "—", tone: "neutral" };
  const pts = (report.incremental_lift as number) * 100;
  const rounded = Math.round(pts * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const text = `${sign}${rounded.toFixed(1)} pts`;
  if (Math.abs(rounded) < 0.05) return { text: "0.0 pts", tone: "neutral" };
  return { text, tone: rounded > 0 ? "good" : "bad" };
}
