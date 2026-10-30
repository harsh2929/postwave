/**
 * lib/groupedTimeseries.ts — reading `GET /api/v1/analytics/timeseries`, the
 * one endpoint that answers "which campaigns / which mailbox providers is this
 * number actually coming from?".
 *
 * Handler: apps/api/internal/analytics/handlers.go:106 (`GroupedTimeseries`,
 * `read:reports`). Three parts of its contract are load-bearing here:
 *
 *  - `group_by` ACCEPTS ONLY campaign AND domain. `list` is recognised and
 *    rejected with a structured 400 (`unsupported_dimension`) because
 *    campaign_report_events carries no per-event list attribution. A mobile
 *    dimension control that offered "list" would ship a button whose only
 *    possible outcome is an error, so `GROUPED_DIMENSIONS` is the whitelist and
 *    nothing derives it from a wider list.
 *  - THE SERVER ALREADY ROLLS UP. It returns the top ten groups by volume plus
 *    a trailing `other` series (service.go:143). Ten lines is a desk chart; a
 *    phone can separate about four. So this module rolls further — and the
 *    trailing series says HOW MANY groups it absorbed, because "Other" without
 *    a count hides whether it is one straggler or forty.
 *  - EVERY SERIES IS ZERO-FILLED to exactly `days` points server-side, so the
 *    date axis is shared. It is still rebuilt here from the union of dates:
 *    a partial deployment that stops zero-filling would otherwise silently
 *    misalign two series against one axis, which is a chart that lies.
 *
 * Pure and import-free (house rule 6).
 */

/** Dimensions the handler accepts. NOT derived from a wider list — see above. */
export const GROUPED_DIMENSIONS = ["campaign", "domain"] as const;
export type GroupedDimension = (typeof GROUPED_DIMENSIONS)[number];

/** Metrics the handler whitelists (`groupedTimeseriesMetrics`, service.go:153). */
export const GROUPED_METRICS = ["opens", "clicks", "bounces"] as const;
export type GroupedMetric = (typeof GROUPED_METRICS)[number];

/** The key the server uses for its own rollup bucket. */
export const OTHER_SERIES_KEY = "other";

/** How many named series a phone-width chart can keep separable. */
export const MAX_PHONE_SERIES = 4;

/** The server's hard ceiling; a longer window is silently truncated to it. */
export const GROUPED_MAX_DAYS = 90;

export interface GroupedPoint {
  /** `YYYY-MM-DD`, as the server formats it. */
  date: string;
  value: number;
}

export interface GroupedSeries {
  key: string;
  label: string;
  points: GroupedPoint[];
  /** Sum across the window — the ranking key for the phone-side rollup. */
  total: number;
}

export function isGroupedDimension(value: unknown): value is GroupedDimension {
  return (
    typeof value === "string" &&
    (GROUPED_DIMENSIONS as readonly string[]).includes(value)
  );
}

export function isGroupedMetric(value: unknown): value is GroupedMetric {
  return (
    typeof value === "string" &&
    (GROUPED_METRICS as readonly string[]).includes(value)
  );
}

export function groupedTimeseriesPath(
  dimension: GroupedDimension,
  metric: GroupedMetric,
  days: number,
): string {
  const bounded = Math.max(1, Math.min(GROUPED_MAX_DAYS, Math.trunc(days)));
  return `/api/v1/analytics/timeseries?group_by=${dimension}&metric=${metric}&days=${bounded}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{ series: [...] }`, or a bare array from a future/older shape. */
export function parseGroupedTimeseries(raw: unknown): GroupedSeries[] {
  const envelope = record(raw);
  const list = Array.isArray(raw)
    ? raw
    : envelope && Array.isArray(envelope.series)
      ? envelope.series
      : [];
  const out: GroupedSeries[] = [];
  for (const entry of list) {
    const row = record(entry);
    if (!row) continue;
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!key) continue;
    const points: GroupedPoint[] = [];
    let total = 0;
    for (const cell of Array.isArray(row.points) ? row.points : []) {
      const point = record(cell);
      if (!point) continue;
      const date = typeof point.date === "string" ? point.date.trim() : "";
      const value = point.value;
      if (!date) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        // A day whose count did not parse is a GAP. Coercing it to zero draws
        // a cliff the workspace never had; see `groupedChartInput`, which
        // keeps gaps as nulls so the line breaks instead.
        points.push({ date, value: Number.NaN });
        continue;
      }
      points.push({ date, value });
      total += value;
    }
    if (points.length === 0) continue;
    out.push({
      key,
      label:
        typeof row.label === "string" && row.label.trim() !== ""
          ? row.label.trim()
          : key,
      points,
      total,
    });
  }
  return out;
}

export interface GroupedChartInput {
  labels: string[];
  series: { id: string; label: string; values: (number | null)[] }[];
  /** How many source groups the trailing "Other" series absorbed; 0 if none. */
  rolledUp: number;
}

/**
 * Chart-ready arrays: the top `max - 1` series by volume, plus one trailing
 * series carrying everything else — INCLUDING the server's own `other` bucket,
 * which must never be ranked as if it were a real group. A chart whose second
 * line is "Other" tells the reader nothing about which campaign moved.
 *
 * Dates come from the union of every series' dates, sorted lexically (the
 * server's `YYYY-MM-DD` sorts chronologically), so two series with different
 * lengths cannot be drawn against each other's x positions.
 */
export function groupedChartInput(
  series: readonly GroupedSeries[],
  max: number = MAX_PHONE_SERIES,
): GroupedChartInput {
  const dates = new Set<string>();
  for (const one of series) {
    for (const point of one.points) dates.add(point.date);
  }
  const labels = [...dates].sort();
  if (labels.length === 0) return { labels: [], series: [], rolledUp: 0 };

  const named = series.filter((one) => one.key !== OTHER_SERIES_KEY);
  const serverOther = series.filter((one) => one.key === OTHER_SERIES_KEY);
  const ranked = [...named].sort(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label),
  );
  const keepCount = Math.max(1, max - 1);
  const kept = ranked.slice(0, keepCount);
  const spilled = [...ranked.slice(keepCount), ...serverOther];

  const valuesOf = (one: GroupedSeries): (number | null)[] => {
    const byDate = new Map(one.points.map((p) => [p.date, p.value]));
    return labels.map((date) => {
      const value = byDate.get(date);
      return value === undefined || !Number.isFinite(value) ? null : value;
    });
  };

  const out: GroupedChartInput["series"] = kept.map((one) => ({
    id: one.key,
    label: one.label,
    values: valuesOf(one),
  }));

  if (spilled.length > 0) {
    // A summed rollup has no gaps to preserve: a null in one contributor is
    // absence in that contributor, not absence in the total. Days where NO
    // contributor reported stay null.
    const summed: (number | null)[] = labels.map(() => null);
    for (const one of spilled) {
      const values = valuesOf(one);
      values.forEach((value, index) => {
        if (value === null) return;
        summed[index] = (summed[index] ?? 0) + value;
      });
    }
    // The count names SOURCE GROUPS, and the server's own `other` bucket is
    // an unknown number of them — so it is reported separately in the label
    // rather than counted as one.
    const absorbedNamed = ranked.length - kept.length;
    out.push({
      id: OTHER_SERIES_KEY,
      label: otherSeriesLabel(absorbedNamed, serverOther.length > 0),
      values: summed,
    });
    return { labels, series: out, rolledUp: absorbedNamed };
  }

  return { labels, series: out, rolledUp: 0 };
}

/**
 * Names the rollup honestly. The server's `other` bucket already contains an
 * unknown number of groups, so a bare count would understate it.
 */
export function otherSeriesLabel(
  absorbedNamed: number,
  includesServerRollup: boolean,
): string {
  if (includesServerRollup && absorbedNamed > 0) {
    return `Other (${absorbedNamed} more + rest)`;
  }
  if (includesServerRollup) return "Other (everything else)";
  return absorbedNamed === 1 ? "Other (1 more)" : `Other (${absorbedNamed} more)`;
}

/** Human noun for the y axis and the spoken table rows. */
export function metricNoun(metric: GroupedMetric): string {
  return metric;
}

/** Human label for the dimension control. */
export function dimensionLabel(dimension: GroupedDimension): string {
  return dimension === "campaign" ? "Campaign" : "Domain";
}

/**
 * The caption under the chart. It states the server's own top-ten cap as well
 * as the phone's, because a reader comparing this against the desktop chart
 * must be able to tell which rollup they are looking at.
 */
export function groupedCaption(
  dimension: GroupedDimension,
  rolledUp: number,
): string {
  const noun = dimension === "campaign" ? "campaigns" : "recipient domains";
  const base = `Daily totals for the top ${noun} in this window. The server ranks the top ten by volume and rolls the rest into “other”`;
  if (rolledUp <= 0) return `${base}.`;
  return `${base}; this phone shows the largest few and folds ${rolledUp} more into the trailing line.`;
}
