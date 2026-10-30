/**
 * lib/chartSummary.ts — the sentence a screen reader hears instead of a chart.
 *
 * A chart is an image. Without a summary, VoiceOver announces "image" and the
 * data is simply unavailable — which on an analytics screen means the screen
 * has no content at all. The summary below carries what a sighted reader takes
 * from the shape in one glance: which series, which direction, where it started
 * and ended, and the range it moved through.
 *
 * It lives outside the component so the wording is unit-testable, including the
 * cases that are easy to get wrong: an empty series, a series that is entirely
 * null, a single point (no direction exists), and a flat line (which is
 * "steady", not "trending up by zero").
 */
import { num } from "./format";

export interface SummarySeries {
  label: string;
  values: readonly (number | null | undefined)[];
}

export type TrendDirection = "up" | "down" | "steady" | "unknown";

/** Direction of travel between the first and last measured points. */
export function trendDirection(
  values: readonly (number | null | undefined)[],
): TrendDirection {
  const points = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (points.length === 0) return "unknown";
  // One measurement is a value, not a trend — claiming a direction from it
  // would be an assertion the data cannot support.
  if (points.length === 1) return "unknown";
  const first = points[0] as number;
  const last = points[points.length - 1] as number;
  if (last > first) return "up";
  if (last < first) return "down";
  return "steady";
}

const DIRECTION_PHRASE: Record<TrendDirection, string> = {
  up: "trending up",
  down: "trending down",
  steady: "holding steady",
  unknown: "",
};

/**
 * The spoken description for a chart. `title` names the chart; the primary
 * series carries the narrative; additional series are named so the listener
 * knows the chart is not single-valued.
 */
export function chartSummary(
  title: string | undefined,
  series: readonly SummarySeries[],
  pointCount: number,
): string {
  const name = title ?? "Chart";
  const primary = series[0];
  const points = (primary?.values ?? []).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );

  if (!primary || points.length === 0) {
    return `${name}: no data in this range yet.`;
  }

  const direction = DIRECTION_PHRASE[trendDirection(primary.values)];
  const first = points[0] as number;
  const last = points[points.length - 1] as number;

  const parts = [
    `${name}.`,
    direction ? `${primary.label}, ${direction}.` : `${primary.label}.`,
    points.length === 1
      ? `Single measurement of ${num(first)}.`
      : `From ${num(first)} to ${num(last)}.`,
  ];

  if (points.length > 1) {
    parts.push(
      `Ranging ${num(Math.min(...points))} to ${num(Math.max(...points))}.`,
    );
  }

  if (series.length > 1) {
    parts.push(
      `${series.length} series: ${series.map((s) => s.label).join(", ")}.`,
    );
  }

  parts.push(`${pointCount} points. A data table is available below.`);
  return parts.join(" ");
}

/**
 * Move the scrub cursor by one point, clamped to the series.
 *
 * A chart is one accessible node, so without an explicit cursor a VoiceOver
 * user got a single summary sentence and could not reach any individual point
 * — the touch-scrub that reveals them is a drag gesture assistive tech never
 * performs. The chart publishes itself as `adjustable`, which turns "swipe up
 * / swipe down" into increment / decrement, and this is the step rule.
 *
 * Starting from nowhere goes to the FIRST point on increment and the LAST on
 * decrement, which is what "step forward from the start" and "step back from
 * the end" mean to someone who has just landed on the chart.
 */
export function stepScrubIndex(
  current: number | null,
  direction: "increment" | "decrement",
  pointCount: number,
): number | null {
  if (pointCount <= 0) return null;
  if (current === null) return direction === "increment" ? 0 : pointCount - 1;
  const next = current + (direction === "increment" ? 1 : -1);
  // Clamp rather than wrap: wrapping from the last point to the first, with no
  // visual frame of reference, reads as the chart having silently changed.
  return Math.min(pointCount - 1, Math.max(0, next));
}

/**
 * What assistive tech announces for the point under the cursor. Returns null
 * when there is no cursor, so the caller falls back to the chart summary.
 *
 * Values are spoken in FULL (`num`), never in the compact form the axis and
 * the readout use — "1.2K" is right for a 40pt label and wrong for the only
 * channel through which a listener receives the number.
 */
export function chartPointSummary(
  index: number | null,
  labels: readonly string[],
  series: readonly SummarySeries[],
): string | null {
  if (index === null) return null;
  const label = labels[index];
  if (label === undefined) return null;
  const readings = series.map((s) => {
    const value = s.values[index];
    return typeof value === "number" && Number.isFinite(value)
      ? `${s.label} ${num(value)}`
      : `${s.label} not measured`;
  });
  return `${label}: ${readings.join(", ")}. Point ${index + 1} of ${labels.length}.`;
}
