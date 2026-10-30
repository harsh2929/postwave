/**
 * audienceGrowth — the wire contract for `GET /api/v1/subscribers/growth`
 * (SUB-124), and the honesty rules that come with it.
 *
 * "Is my list growing?" is the single most glanceable audience question and
 * mobile had no aggregate beyond a row count. The endpoint answers it, but
 * it answers it with three explicit caveats that a client is REQUIRED to
 * respect — and quietly plotting the numbers anyway is worse than showing
 * nothing, because a fabricated flat line looks like a fact:
 *
 *  1. `unavailable_metrics` (always contains `lapsed`) — placeholder-valued
 *     flows the spec says clients must omit from charts, totals, anomaly
 *     detection, accessible tables and exports. We drop them entirely.
 *  2. `partial_metrics` (always contains `unsubbed`) — verified LOWER
 *     BOUNDS, not exhaustive totals. We keep them, labelled "at least".
 *  3. `note` — the server's own UTC-scope / cold-start disclosure. Rendered
 *     verbatim; never paraphrased, never suppressed.
 *
 * Import-free so all of the above is unit-testable in the node environment.
 */
import { num } from "@/lib/format";


export interface AudienceGrowthPoint {
  date: string;
  total: number;
  added: number;
  unsubbed: number;
}

export interface AudienceGrowth {
  days: number;
  series: AudienceGrowthPoint[];
  /** Newest total minus oldest total; 0 when fewer than two points. */
  delta: number;
  deltaPct: number;
  totalAdded: number;
  /** A verified LOWER BOUND — see partialMetrics. */
  totalUnsubbed: number;
  /** Server disclosure. Render verbatim when present. */
  note: string;
  /** Metrics that are lower bounds, e.g. ["unsubbed"]. */
  partialMetrics: string[];
  /** Metrics that must NOT be charted, e.g. ["lapsed"]. */
  unavailableMetrics: string[];
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function parseAudienceGrowth(raw: unknown): AudienceGrowth {
  const env =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const points = Array.isArray(env.series) ? env.series : [];
  const series: AudienceGrowthPoint[] = [];
  for (const entry of points) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const date = typeof row.date === "string" ? row.date : "";
    if (!date) continue;
    series.push({
      date,
      total: int(row.total),
      added: int(row.added),
      unsubbed: int(row.unsubbed),
    });
  }
  return {
    days: int(env.days) || series.length,
    series,
    delta: int(env.delta),
    deltaPct:
      typeof env.delta_pct === "number" && Number.isFinite(env.delta_pct)
        ? env.delta_pct
        : 0,
    totalAdded: int(env.total_added),
    totalUnsubbed: int(env.total_unsubbed),
    note: typeof env.note === "string" ? env.note.trim() : "",
    partialMetrics: strList(env.partial_metrics),
    unavailableMetrics: strList(env.unavailable_metrics),
  };
}

/**
 * A trend needs at least two points to BE a trend. One snapshot drawn as a
 * line is a straight segment that reads as "flat" — a claim the data does
 * not support. Desktop's growth helpers apply the same floor.
 */
export const MIN_TREND_POINTS = 2;

export function hasPlottableTrend(growth: AudienceGrowth | undefined): boolean {
  return (growth?.series.length ?? 0) >= MIN_TREND_POINTS;
}

/** Whether the spec forbids charting this metric for this response. */
export function metricIsUnavailable(
  growth: AudienceGrowth | undefined,
  metric: string,
): boolean {
  return (growth?.unavailableMetrics ?? []).includes(metric);
}

/** Whether the metric is a verified lower bound rather than a total. */
export function metricIsPartial(
  growth: AudienceGrowth | undefined,
  metric: string,
): boolean {
  return (growth?.partialMetrics ?? []).includes(metric);
}

/**
 * The headline delta line: "+412 in 30 days (+3.1%)".
 *
 * Returns null when there is no trend to describe, so the caller renders
 * the server's `note` instead of a confident "0".
 */
export function growthDeltaLine(
  growth: AudienceGrowth | undefined,
): string | null {
  if (!growth || !hasPlottableTrend(growth)) return null;
  const sign = growth.delta > 0 ? "+" : growth.delta < 0 ? "−" : "";
  const magnitude = num(Math.abs(growth.delta));
  const pct =
    growth.deltaPct === 0
      ? ""
      : ` (${growth.deltaPct > 0 ? "+" : "−"}${Math.abs(growth.deltaPct).toFixed(1)}%)`;
  return `${sign}${magnitude} in ${growth.days} days${pct}`;
}

/**
 * Spoken summary for the card. Says the exact numbers (the tiles compact
 * them) and states the lower-bound caveat out loud rather than hiding it in
 * a superscript.
 */
export function growthSpokenSummary(
  growth: AudienceGrowth | undefined,
): string {
  if (!growth || growth.series.length === 0) {
    return "Audience growth: no snapshots yet.";
  }
  const latest = growth.series[growth.series.length - 1];
  const parts = [
    `Audience growth over ${growth.days} days.`,
    latest ? `${num(latest.total)} subscribers now.` : "",
    `${num(growth.totalAdded)} added.`,
    metricIsPartial(growth, "unsubbed")
      ? `At least ${num(growth.totalUnsubbed)} unsubscribed.`
      : `${num(growth.totalUnsubbed)} unsubscribed.`,
  ];
  return parts.filter(Boolean).join(" ");
}
