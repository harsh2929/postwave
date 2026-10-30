/**
 * segment-growth-report-helpers — pure projection + copy logic for the
 * SUB-031 segment growth report (GET /segments/{id}/growth/report).
 *
 * The wire gives one point per day with the running `count`, the per-day
 * `adds`/`drops` (and capped_* flags), a `delta` vs the prior day, and an
 * optional `anomaly_kind`. These helpers project that onto an SVG: a
 * count polyline plus mirrored adds(up)/drops(down) bars around a
 * mid-baseline, and anomaly markers placed on the count line. All pure —
 * unit-testable without React/DOM.
 */

import type {
  SegmentGrowthReportPoint,
  SegmentGrowthReportResponse,
} from "../../lib/api-client";

export interface GrowthReportBar {
  x: number;
  date: string;
  adds: number;
  drops: number;
  cappedAdds: boolean;
  cappedDrops: boolean;
  /** Pixel heights (>= 0) measured away from the baseline. */
  addsHeight: number;
  dropsHeight: number;
}

export interface GrowthReportAnomalyMarker {
  x: number;
  y: number;
  date: string;
  anomalyKind: string;
}

export interface GrowthReportGeometry {
  /** SVG path for the running-count polyline; null when < 2 points. */
  countPath: string | null;
  /** Y of the churn baseline (bars grow up for adds, down for drops). */
  midY: number;
  /** Half the bar width in px (so a bar is 2× this, centred on x). */
  barHalfWidth: number;
  bars: GrowthReportBar[];
  anomalyMarkers: GrowthReportAnomalyMarker[];
  maxCount: number;
  minCount: number;
}

/**
 * Project the report series onto a width×height SVG. The count line uses
 * the TOP ~55% of the canvas; the bottom band hosts the mirrored churn
 * bars around a baseline so adds/drops read at a glance. Uniform X
 * spacing per snapshot (the worker only writes when it runs, so a
 * time-proportional axis would imply a regularity we don't have).
 */
export function buildGrowthReportGeometry(
  series: SegmentGrowthReportPoint[],
  width = 560,
  height = 120,
): GrowthReportGeometry {
  if (series.length === 0) {
    return {
      countPath: null,
      midY: height * 0.78,
      barHalfWidth: 2,
      bars: [],
      anomalyMarkers: [],
      maxCount: 0,
      minCount: 0,
    };
  }

  const counts = series.map((p) => p.count);
  const maxCount = Math.max(...counts);
  const minCount = Math.min(...counts);
  const countSpan = Math.max(1, maxCount - minCount);

  // Count line occupies the upper region; churn bars the lower band.
  const lineTop = height * 0.06;
  const lineBottom = height * 0.5;
  const lineUsable = lineBottom - lineTop;
  const midY = height * 0.78; // churn baseline
  const churnBand = height - midY - 4; // px available above & below baseline

  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  // Bars only render when there are >= 2 points (the line case); width is
  // a fraction of the step, clamped so dense windows don't collapse.
  const barHalfWidth = Math.max(
    1,
    Math.min(6, (stepX > 0 ? stepX : width) * 0.3),
  );

  const maxChurn = Math.max(
    1,
    ...series.map((p) => Math.max(p.adds, p.drops)),
  );

  const xFor = (i: number): number =>
    series.length > 1 ? i * stepX : width / 2;
  const yForCount = (count: number): number =>
    lineTop + (1 - (count - minCount) / countSpan) * lineUsable;

  const points = series.map((p, i) => ({
    x: xFor(i),
    y: yForCount(p.count),
  }));

  const countPath =
    points.length >= 2
      ? points
          .map(
            (pt, i) =>
              `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
          )
          .join(" ")
      : null;

  const bars: GrowthReportBar[] = series.map((p, i) => ({
    x: xFor(i),
    date: p.date,
    adds: p.adds,
    drops: p.drops,
    cappedAdds: !!p.capped_adds,
    cappedDrops: !!p.capped_drops,
    addsHeight: (p.adds / maxChurn) * churnBand,
    dropsHeight: (p.drops / maxChurn) * churnBand,
  }));

  const anomalyMarkers: GrowthReportAnomalyMarker[] = [];
  series.forEach((p, i) => {
    if (p.anomaly_kind) {
      anomalyMarkers.push({
        x: xFor(i),
        y: yForCount(p.count),
        date: p.date,
        anomalyKind: p.anomaly_kind,
      });
    }
  });

  return {
    countPath,
    midY,
    barHalfWidth,
    bars,
    anomalyMarkers,
    maxCount,
    minCount,
  };
}

export interface GrowthReportSummary {
  /** e.g. "net +312 (+4.1%)" / "net −20 (−1.2%)" / "net 0". */
  netLabel: string;
  netColor: string;
  /** Snapshot/window caption, honest about sparseness. */
  caption: string;
}

export function growthReportSummaryCopy(
  resp: SegmentGrowthReportResponse,
): GrowthReportSummary {
  const n = resp.series.length;
  const net = resp.net_delta;
  let netLabel: string;
  let netColor: string;
  if (n < 2) {
    netLabel = "net —";
    netColor = "var(--pw-fg-muted)";
  } else if (net === 0) {
    netLabel = "net 0";
    netColor = "var(--pw-fg-muted)";
  } else {
    const sign = net > 0 ? "+" : "−";
    netLabel = `net ${sign}${Math.abs(net).toLocaleString()} (${sign}${Math.abs(
      resp.net_pct,
    ).toFixed(1)}%)`;
    netColor = net > 0 ? "var(--pw-success)" : "var(--pw-danger)";
  }
  const caption =
    n === 0
      ? `No snapshots in the last ${resp.days} days.`
      : `${n.toLocaleString()} snapshot${n === 1 ? "" : "s"} over ${resp.days} days`;
  return { netLabel, netColor, caption };
}
