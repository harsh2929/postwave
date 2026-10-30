/**
 * growth-sources-helpers — pure mapping logic for the Lists page
 * "Growth sources" card (full-surface wiring #24).
 *
 * Adapts the /api/v1/growth-source/* wire shapes into the existing
 * chart primitives:
 *
 *   - summary buckets (consent_source × source_platform × count) →
 *     Donut slices aggregated per consent_source,
 *   - timeseries points (date × consent_source × count) →
 *     MultiLineChart series, zero-filled over the union of dates so
 *     all series share one x-axis,
 *   - 0..1 quality-rate formatting (the Go handler divides counts by
 *     total, it does NOT multiply by 100).
 *
 * Kept out of the component so the shapes are unit-testable.
 */

import type { GrowthSourceBucket } from "../../lib/api/growth-sources";
import type { DonutSlice } from "../charts/Donut";
import type { MultiLineSeries } from "../charts/MultiLineChart";

/** Empty consent_source on the wire means the row predates tracking. */
export function sourceLabel(consentSource: string | null | undefined): string {
  // `consent_source` is typed non-null on the wire, but the Go handler
  // can emit a null/absent bucket field; coalesce to "" so `.trim()`
  // never throws and the row labels "untracked" instead of crashing.
  const s = (consentSource ?? "").trim();
  return s === "" ? "untracked" : s;
}

/**
 * Collapse summary buckets to one Donut slice per consent_source
 * (summing across source_platform), sorted by count descending so the
 * accent color lands on the biggest source.
 */
export function donutSlicesFromSummary(
  sources: GrowthSourceBucket[] | undefined | null,
): DonutSlice[] {
  // The summary response can omit `sources` on an empty window; treat a
  // missing/non-array value as "no buckets" rather than throwing
  // "sources is not iterable".
  if (!Array.isArray(sources)) return [];
  const byLabel = new Map<string, number>();
  for (const b of sources) {
    // A bucket can arrive missing fields; `sourceLabel` coalesces the
    // consent_source and `?? 0` keeps the sum numeric so a missing
    // `count` contributes nothing rather than producing NaN.
    const label = sourceLabel(b?.consent_source);
    byLabel.set(label, (byLabel.get(label) ?? 0) + (b?.count ?? 0));
  }
  return [...byLabel.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export interface GrowthTimeseriesPoint {
  date: string;
  consent_source: string;
  count: number;
}

/**
 * Group timeseries points into one MultiLineChart series per
 * consent_source. The backend already zero-fills via generate_series,
 * but we defensively re-fill the union of dates per series so the
 * chart never misaligns if a backend rewrite drops the dense fill.
 * Series are ordered by total count descending; dates ascending.
 */
export function seriesFromTimeseries(
  points: GrowthTimeseriesPoint[] | undefined | null,
): MultiLineSeries[] {
  // `points` is absent on an empty window — return no series instead of
  // throwing on `.map` of undefined.
  if (!Array.isArray(points)) return [];
  // Coalesce each point's fields: a missing date collapses to "" (a
  // single stable bucket) and a missing count contributes 0, so a
  // partial point can't NaN the totals or misalign the x-axis.
  const dates = [...new Set(points.map((p) => p?.date ?? ""))].sort();
  const bySource = new Map<string, Map<string, number>>();
  for (const p of points) {
    const label = sourceLabel(p?.consent_source);
    const date = p?.date ?? "";
    let m = bySource.get(label);
    if (!m) {
      m = new Map();
      bySource.set(label, m);
    }
    m.set(date, (m.get(date) ?? 0) + (p?.count ?? 0));
  }
  const series: Array<MultiLineSeries & { total: number }> = [];
  for (const [label, m] of bySource) {
    const values = dates.map((date) => ({ date, count: m.get(date) ?? 0 }));
    series.push({
      label,
      values,
      total: values.reduce((a, v) => a + v.count, 0),
    });
  }
  return series
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .map(({ label, values }) => ({ label, values }));
}

/** Format a 0..1 fraction as a percentage string, e.g. 0.0312 → "3.1%". */
export function fmtRate01(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const pct = v * 100;
  // One decimal below 10% so small-but-real complaint rates don't
  // round to a dishonest "0%".
  return pct > 0 && pct < 10 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}
