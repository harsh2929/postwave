/**
 * goals-helpers — pure formatting / parsing logic for the GoalsCard.
 *
 * Unit semantics mirror apps/api/internal/goals/progress.go exactly:
 *
 *   subscribers   — live enabled-audience COUNT          → integer
 *   open_rate     — unique opens ÷ delivered × 100       → PERCENT units
 *                   (the Go query multiplies by 100, so a target of
 *                   "45" means 45%; we do NOT convert to a fraction)
 *   revenue_cents — attributed conversion revenue        → integer CENTS
 *                   (operators type dollars; we convert to cents)
 *   list_growth   — net new subscriber rows in window    → integer
 *
 * All functions are pure — tested in
 * src/__tests__/components/goals-helpers.test.ts.
 */

import type { TenantGoal, TenantGoalMetric } from "../../lib/api-client";

export interface GoalMetricDef {
  value: TenantGoalMetric;
  label: string;
  /** Short unit description shown next to the target input. */
  unitHint: string;
}

export const GOAL_METRICS: readonly GoalMetricDef[] = [
  {
    value: "subscribers",
    label: "Subscribers",
    unitHint: "total enabled subscribers",
  },
  {
    value: "open_rate",
    label: "Open rate",
    unitHint: "% of delivered emails opened",
  },
  {
    value: "revenue_cents",
    label: "Revenue",
    unitHint: "attributed revenue in dollars",
  },
  {
    value: "list_growth",
    label: "List growth",
    unitHint: "new subscribers this period",
  },
];

export function goalMetricLabel(metric: string): string {
  const def = GOAL_METRICS.find((m) => m.value === metric);
  return def ? def.label : metric;
}

/** Prefer the operator-authored label, with a stable metric fallback. */
export function goalDisplayName(goal: TenantGoal): string {
  return goal.name || goalMetricLabel(goal.metric);
}

/** Display formatting for a goal's current / target value. */
export function formatGoalValue(
  metric: TenantGoalMetric,
  value: number,
): string {
  if (!Number.isFinite(value)) return "—";
  switch (metric) {
    case "open_rate":
      // Server emits percent units already (opens/delivered × 100).
      return `${value.toFixed(1)}%`;
    case "revenue_cents": {
      const dollars = value / 100;
      return `$${dollars.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    default:
      return Math.round(value).toLocaleString();
  }
}

/** Prefill string for the edit modal's target input (inverse of
 *  {@link parseGoalTargetInput}'s unit conversion). */
export function goalTargetToInput(
  metric: TenantGoalMetric,
  target: number,
): string {
  if (!Number.isFinite(target)) return "";
  if (metric === "revenue_cents") {
    // cents → dollars; trim trailing ".00" noise only when whole.
    const dollars = target / 100;
    return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  }
  return String(target);
}

export type ParsedGoalTarget = { target: number } | { error: string };

/**
 * Parse the user-typed target into the unit the server stores.
 * Tolerates "$", "%", "," and surrounding whitespace.
 */
export function parseGoalTargetInput(
  metric: TenantGoalMetric,
  raw: string,
): ParsedGoalTarget {
  const cleaned = raw.replace(/[$,%\s]/g, "");
  if (cleaned === "") return { error: "Enter a target." };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { error: "Target must be a number." };
  if (n <= 0) return { error: "Target must be greater than zero." };

  switch (metric) {
    case "open_rate":
      if (n > 100) return { error: "Open-rate target can't exceed 100%." };
      return { target: n };
    case "revenue_cents": {
      // Dollars in, cents out. Round to whole cents.
      const cents = Math.round(n * 100);
      if (cents <= 0) return { error: "Target must be at least $0.01." };
      return { target: cents };
    }
    default: {
      if (!Number.isInteger(n))
        return { error: "Target must be a whole number." };
      return { target: n };
    }
  }
}

export interface PaceBadge {
  label: string;
  /** Maps to the existing `.badge` modifier classes in styles.css. */
  className: "badge success" | "badge" | "badge warning";
}

/** pace ∈ "ahead" | "on_track" | "behind" (goals.ComputePace). Unknown
 *  values render as a plain badge with the raw text — honest, no guess. */
export function paceBadge(pace: string): PaceBadge {
  switch (pace) {
    case "ahead":
      return { label: "Ahead", className: "badge success" };
    case "on_track":
      return { label: "On track", className: "badge" };
    case "behind":
      return { label: "Behind", className: "badge warning" };
    default:
      return { label: pace, className: "badge" };
  }
}

/** "Jun 1 – Jun 30, 2026" (same year) / "Dec 1, 2026 – Jan 31, 2027".
 *  `locale` is only pinned by tests; the UI uses the system locale. */
export function formatPeriodRange(
  startIso: string,
  endIso: string,
  locale?: string,
): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  // Goal windows are server-defined calendar periods, not instants in the
  // operator's local timezone. Formatting their UTC calendar fields prevents
  // an inclusive 23:59:59Z end from shifting into the following day east of
  // Greenwich (and a 00:00Z start from shifting backward west of it).
  const md: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  const mdy: Intl.DateTimeFormatOptions = { ...md, year: "numeric" };
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return `${start.toLocaleDateString(locale, md)} – ${end.toLocaleDateString(locale, mdy)}`;
  }
  return `${start.toLocaleDateString(locale, mdy)} – ${end.toLocaleDateString(locale, mdy)}`;
}

/** Clamp a server pct (current/target, can exceed 1) to a 0..1 bar width. */
export function clampFraction(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0) return 0;
  return Math.min(pct, 1);
}

/** "42%" display for the server's pct fraction (NOT clamped — an
 *  overshooting goal honestly shows 120%). */
export function formatGoalPct(pct: number): string {
  if (!Number.isFinite(pct) || pct < 0) return "0%";
  return `${Math.round(pct * 100)}%`;
}
