/**
 * lib/goalsFormat.ts — rendering a goal's current/target pair in ITS OWN unit.
 *
 * Split from lib/goals.ts because this half imports the locale-aware
 * formatters while the parser must stay dependency-free.
 *
 * Every branch here exists because the four metrics do NOT share a unit — see
 * the header of lib/goals.ts. Getting this wrong does not look like a bug: it
 * looks like a confident "2,400% of target".
 */
import type { GoalMetric } from "@/lib/goals";
import { money, num, percent } from "@/lib/format";

export interface GoalValueOptions {
  /** Currency for `revenue_cents`. The server resolves the window's dominant
   *  currency; a hardcoded "$" would mislabel a euro workspace. */
  currency?: string | undefined;
}

/** Format one side of a goal (current or target) in the metric's own unit. */
export function formatGoalValue(
  metric: GoalMetric,
  value: number,
  { currency = "USD" }: GoalValueOptions = {},
): string {
  switch (metric) {
    case "open_rate":
      // Already a percentage 0..100 — `alreadyPercent` is what stops 24
      // rendering as 2,400%.
      return percent(value, { alreadyPercent: true, digits: 1 });
    case "revenue_cents":
      return money(value / 100, currency);
    case "subscribers":
    case "list_growth":
      return num(Math.round(value));
  }
}

/** "812 of 1,000" — the spoken and printed summary of a goal's position. */
export function formatGoalPosition(
  metric: GoalMetric,
  current: number,
  target: number,
  options: GoalValueOptions = {},
): string {
  return `${formatGoalValue(metric, current, options)} of ${formatGoalValue(
    metric,
    target,
    options,
  )}`;
}
