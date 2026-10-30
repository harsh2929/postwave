/**
 * segment-growth-helpers — pure logic for the per-segment growth chart
 * (R11: GET /api/v1/segments/{id}/growth?days=).
 *
 * The wire gives `{segment_id, days, series: [{date, evaluated_at,
 * count}], delta, delta_pct, note?}`. Snapshots are taken by a
 * background worker, so early tenants have sparse/empty series — the
 * server's `note` field explains why and MUST be rendered when
 * present (honest-UI). delta/delta_pct compare newest vs oldest point
 * and are zero-valued below 2 points.
 *
 * (Named segment-growth-helpers — `growth-helpers.ts` already exists
 * under components/forms for the signup-form growth panel.)
 */

import type { SegmentGrowthPoint } from "../../lib/api-client";

export interface GrowthPath {
  /** SVG path ("M…L…") for the count polyline; null when < 2 points. */
  path: string | null;
  /** Highest count in the window (axis annotation). */
  maxCount: number;
  /** Lowest count in the window. */
  minCount: number;
  points: Array<{ x: number; y: number; date: string; count: number }>;
}

/**
 * Project the snapshot series onto a width×height SVG. X spacing is
 * uniform per snapshot (the series may have date gaps — the worker
 * only writes when it runs — so a time-proportional axis would imply
 * a regularity we don't have; uniform spacing renders what exists).
 */
export function buildGrowthPath(
  series: SegmentGrowthPoint[],
  width = 320,
  height = 72,
): GrowthPath {
  if (series.length === 0) {
    return { path: null, maxCount: 0, minCount: 0, points: [] };
  }
  const counts = series.map((p) => p.count);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const span = Math.max(1, maxCount - minCount);
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  // 10% vertical padding so a flat line isn't glued to an edge.
  const padY = height * 0.1;
  const usable = height - padY * 2;
  const points = series.map((p, i) => ({
    x: series.length > 1 ? i * stepX : width / 2,
    y: padY + (1 - (p.count - minCount) / span) * usable,
    date: p.date,
    count: p.count,
  }));
  const path =
    points.length >= 2
      ? points
          .map(
            (pt, i) =>
              `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
          )
          .join(" ")
      : null;
  return { path, maxCount, minCount, points };
}

export interface GrowthDeltaCopy {
  /** e.g. "+12 (+8.3%)" / "−3 (−1.2%)" / "no change". */
  label: string;
  tone: "up" | "down" | "flat";
  /** True when the window has < 2 snapshots → delta is structurally 0
   * and shouldn't be presented as "no change". */
  insufficient: boolean;
}

export function growthDeltaCopy(
  series: SegmentGrowthPoint[],
  delta: number,
  deltaPct: number,
): GrowthDeltaCopy {
  if (series.length < 2) {
    return {
      label: "not enough snapshots to compare",
      tone: "flat",
      insufficient: true,
    };
  }
  if (delta === 0) {
    return { label: "no change", tone: "flat", insufficient: false };
  }
  const sign = delta > 0 ? "+" : "−";
  const pct = `${sign}${Math.abs(deltaPct).toFixed(1)}%`;
  return {
    label: `${sign}${Math.abs(delta).toLocaleString()} (${pct})`,
    tone: delta > 0 ? "up" : "down",
    insufficient: false,
  };
}

/** Caption under the chart: snapshot count + window, honest about
 * sparseness. */
export function growthCaption(
  series: SegmentGrowthPoint[],
  days: number,
): string {
  if (series.length === 0) return `No snapshots in the last ${days} days.`;
  const n = series.length;
  return `${n.toLocaleString()} snapshot${n === 1 ? "" : "s"} over the last ${days} days`;
}
