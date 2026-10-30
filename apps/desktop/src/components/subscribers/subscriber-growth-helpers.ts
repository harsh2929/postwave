/**
 * subscriber-growth-helpers — pure logic for the SUB-124 audience growth
 * card (GET /api/v1/subscribers/growth?days=).
 *
 * The wire gives a daily series of {total, added, unsubbed, lapsed} plus
 * a window-level delta/delta_pct (newest vs oldest total) and an optional
 * server `note` explaining a cold-start empty series. These helpers
 * project each metric onto a sparkline and flag churn spikes via a z-score
 * on the unsubscribed series (mirroring the bounces anomaly elsewhere in
 * the dashboard). All pure — unit-testable without React/DOM.
 *
 * Anomaly caveat (from the risk note): a z-score is meaningless on sparse
 * early data, so detection is suppressed below MIN_ANOMALY_POINTS points.
 */

import type {
  AudienceGrowthPoint,
  AudienceGrowthResponse,
} from "../../lib/api/audience-growth";

/** Metrics we sparkline. "total" is a running level; the others are
 *  per-day flows. */
export type GrowthMetric = "total" | "added" | "unsubbed" | "lapsed";

export function metricValue(p: AudienceGrowthPoint, m: GrowthMetric): number {
  switch (m) {
    case "total":
      return p.total;
    case "added":
      return p.added;
    case "unsubbed":
      return p.unsubbed;
    case "lapsed":
      return p.lapsed;
  }
}

export interface SparkPoint {
  x: number;
  y: number;
  date: string;
  value: number;
}

export interface SparkPath {
  /** SVG path ("M…L…") for the metric polyline; null when < 2 points. */
  path: string | null;
  points: SparkPoint[];
  max: number;
  min: number;
}

/**
 * Project one metric onto a width×height sparkline. Uniform X spacing per
 * snapshot (the worker only writes when it runs, so a time-proportional
 * axis would imply a regularity we don't have).
 */
export function buildSparkline(
  series: AudienceGrowthPoint[],
  metric: GrowthMetric,
  width = 280,
  height = 40,
): SparkPath {
  if (series.length === 0) {
    return { path: null, points: [], max: 0, min: 0 };
  }
  const values = series.map((p) => metricValue(p, metric));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const padY = height * 0.12;
  const usable = height - padY * 2;
  const points: SparkPoint[] = series.map((p, i) => {
    const value = metricValue(p, metric);
    return {
      x: series.length > 1 ? i * stepX : width / 2,
      y: padY + (1 - (value - min) / span) * usable,
      date: p.date,
      value,
    };
  });
  const path =
    points.length >= 2
      ? points
          .map(
            (pt, i) =>
              `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
          )
          .join(" ")
      : null;
  return { path, points, max, min };
}

export interface GrowthDeltaCopy {
  /** e.g. "+312 (+4.1%) over 90d" / "−40 (−0.6%) over 90d". */
  label: string;
  tone: "up" | "down" | "flat";
  /** True when the window has < 2 snapshots → delta is structurally 0. */
  insufficient: boolean;
}

export function audienceDeltaCopy(
  resp: AudienceGrowthResponse,
): GrowthDeltaCopy {
  if (resp.series.length < 2) {
    return {
      label: "not enough snapshots to compare yet",
      tone: "flat",
      insufficient: true,
    };
  }
  if (resp.delta === 0) {
    return {
      label: `no net change over ${resp.days}d`,
      tone: "flat",
      insufficient: false,
    };
  }
  const sign = resp.delta > 0 ? "+" : "−";
  const pct = `${sign}${Math.abs(resp.delta_pct).toFixed(1)}%`;
  return {
    label: `${sign}${Math.abs(resp.delta).toLocaleString()} (${pct}) over ${resp.days}d`,
    tone: resp.delta > 0 ? "up" : "down",
    insufficient: false,
  };
}

/** Below this, a z-score is noise — anomaly detection is suppressed. */
export const MIN_ANOMALY_POINTS = 7;
/** Standard-deviations above the mean that count as a spike. */
const ANOMALY_Z = 2.5;

export interface ChurnAnomaly {
  date: string;
  unsubbed: number;
  /** z-score of this day's unsubscribes vs the window mean. */
  z: number;
}

/**
 * Flag churn spikes on the unsubscribed series via a z-score. Returns the
 * days whose unsub count is ANOMALY_Z standard deviations above the mean.
 * Suppressed (empty) below MIN_ANOMALY_POINTS points or when the series
 * has no variance (a flat line never spikes). Pure.
 */
export function detectChurnAnomalies(
  series: AudienceGrowthPoint[],
): ChurnAnomaly[] {
  if (series.length < MIN_ANOMALY_POINTS) return [];
  const vals = series.map((p) => p.unsubbed);
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance =
    vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  const sd = Math.sqrt(variance);
  if (sd <= 0) return [];
  const out: ChurnAnomaly[] = [];
  series.forEach((p) => {
    const z = (p.unsubbed - mean) / sd;
    if (z >= ANOMALY_Z) out.push({ date: p.date, unsubbed: p.unsubbed, z });
  });
  return out;
}

/** Caption under the chart: snapshot count + window, honest about
 *  sparseness. */
export function audienceGrowthCaption(
  resp: AudienceGrowthResponse,
): string {
  const n = resp.series.length;
  if (n === 0) return `No snapshots in the last ${resp.days} days.`;
  return `${n.toLocaleString()} snapshot${n === 1 ? "" : "s"} over the last ${resp.days} days`;
}
