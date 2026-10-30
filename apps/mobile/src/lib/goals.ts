/**
 * lib/goals.ts — the contract for `GET /api/v1/goals/progress`.
 *
 * Operators set per-tenant targets (subscribers, open rate, revenue, list
 * growth) on a monthly or quarterly cadence; the server computes the current
 * value live and returns a pace verdict. Everything here is pure so the
 * arithmetic and the units can be tested in the node environment.
 *
 * THE UNITS ARE THE WHOLE JOB, and each metric uses a different one
 * (verified against apps/api/internal/goals/progress.go):
 *
 *   subscribers   — a count.
 *   list_growth   — a count (net adds in the window).
 *   open_rate     — ALREADY A PERCENTAGE (0..100). Passing it through a
 *                   ratio formatter would render 24% as 2,400%.
 *   revenue_cents — CENTS. Dividing by 100 is not optional, and the currency
 *                   is the window's dominant one, not a hardcoded dollar.
 *
 * `pct` is a FRACTION (current/target) and is NOT clamped to 1 by the server:
 * a workspace that beat its target reports 1.4. Callers clamp the BAR and
 * keep the number.
 */

export type GoalMetric =
  | "subscribers"
  | "open_rate"
  | "revenue_cents"
  | "list_growth";

export type GoalPace = "ahead" | "on_track" | "behind";

export interface GoalProgress {
  id: string;
  name: string;
  metric: GoalMetric;
  period: "monthly" | "quarterly" | string;
  current: number;
  target: number;
  /** current / target, as a fraction. May exceed 1. */
  pct: number;
  pace: GoalPace;
  periodEnd: string | null;
}

const METRICS = new Set<string>([
  "subscribers",
  "open_rate",
  "revenue_cents",
  "list_growth",
]);
const PACES = new Set<string>(["ahead", "on_track", "behind"]);

/** Default label when the operator did not name the goal. */
export function goalMetricLabel(metric: GoalMetric): string {
  switch (metric) {
    case "subscribers":
      return "Subscribers";
    case "open_rate":
      return "Open rate";
    case "revenue_cents":
      return "Revenue";
    case "list_growth":
      return "List growth";
  }
}

export function goalPaceLabel(pace: GoalPace): string {
  switch (pace) {
    case "ahead":
      return "Ahead of pace";
    case "behind":
      return "Behind pace";
    case "on_track":
      return "On track";
  }
}

function isFinitePositiveish(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse `{ progress: [...] }`.
 *
 * A row missing its metric, target or current value is DROPPED rather than
 * defaulted: a goal rendered at "0% of 0" is a fabricated status report about
 * something the operator is actually being measured on.
 */
export function parseGoalProgress(raw: unknown): GoalProgress[] {
  const envelope = asRecord(raw);
  const rows = envelope?.progress;
  if (!Array.isArray(rows)) return [];

  const out: GoalProgress[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (!record) continue;
    const goal = asRecord(record.goal);
    if (!goal) continue;

    const metric = goal.metric;
    if (typeof metric !== "string" || !METRICS.has(metric)) continue;

    const current = record.current;
    const target = record.target ?? goal.target;
    if (!isFinitePositiveish(current) || !isFinitePositiveish(target)) continue;
    if (target <= 0) continue;

    const id = typeof goal.id === "string" ? goal.id : "";
    if (!id) continue;

    const paceRaw = record.pace;
    const pace: GoalPace =
      typeof paceRaw === "string" && PACES.has(paceRaw)
        ? (paceRaw as GoalPace)
        : "on_track";

    // Trust the server's pct when it sent one; recompute otherwise so the bar
    // is never blank just because a field was omitted.
    const pct = isFinitePositiveish(record.pct)
      ? Math.max(0, record.pct)
      : Math.max(0, current / target);

    const name =
      typeof goal.name === "string" && goal.name.trim()
        ? goal.name.trim()
        : goalMetricLabel(metric as GoalMetric);

    out.push({
      id,
      name,
      metric: metric as GoalMetric,
      period: typeof goal.period === "string" ? goal.period : "monthly",
      current,
      target,
      pct,
      pace,
      periodEnd:
        typeof record.period_end === "string" ? record.period_end : null,
    });
  }
  return out;
}

/** Bar fill, clamped to the track. The NUMBER beside it is never clamped. */
export function goalBarFraction(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(1, pct);
}
