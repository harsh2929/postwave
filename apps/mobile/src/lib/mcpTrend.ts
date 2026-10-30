/**
 * lib/mcpTrend.ts — turning the hourly call trend into something a phone chart
 * can honestly draw.
 *
 * `Repo.Trend` returns ONE ROW PER HOUR across the window, zero-filled by a
 * `generate_series` (apps/api/internal/apikeycalls/apikeycalls.go:498-513).
 * That is 24 points over a day, 168 over a week and 720 over a month. Plotting
 * 720 points across ~340pt of phone gives roughly two points per horizontal
 * pixel: the line stops being readable and, worse, the chart's scrub readout
 * starts naming a bucket the reader cannot possibly have aimed at.
 *
 * SO THE WIDER WINDOWS ARE ROLLED UP, AND THE ROLL-UP IS A SUM, NOT A SAMPLE.
 * Dropping every Nth point — the cheap way to thin a series — would hide every
 * spike that happened in a discarded hour, which on this screen is precisely
 * the event the operator opened the app to find. Summing whole UTC days keeps
 * every call in the picture and changes only the granularity, which the chart
 * then states in its own title.
 *
 * The day boundary is UTC because the buckets are: `date_trunc('hour',
 * called_at)` runs in the connection's timezone with `called_at` stored as
 * timestamptz, and the series is generated from a UTC `now()`. Re-bucketing in
 * device-local time would shift counts across midnight for every reader east or
 * west of the server and make two people disagree about the same day.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */
import type { McpTrendPoint, McpWindow } from "@/lib/mcpActivity";

export type McpTrendGranularity = "hour" | "day";

export interface McpTrendSeries {
  /** RFC3339 bucket starts, ascending. */
  buckets: readonly string[];
  values: readonly number[];
  granularity: McpTrendGranularity;
  /** Sum of every call in the series — never derived from the stats payload. */
  total: number;
}

/** Above this many points a phone chart is drawing noise, so days it is. */
const HOURLY_POINT_CEILING = 48;

/** The UTC day a bucket falls in, as an RFC3339 midnight. "" if unparseable. */
function utcDayOf(bucket: string): string {
  const parsed = Date.parse(bucket);
  if (!Number.isFinite(parsed)) return "";
  const date = new Date(parsed);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}T00:00:00.000Z`;
}

export function mcpTrendSeries(
  points: readonly McpTrendPoint[],
  window: McpWindow,
): McpTrendSeries {
  const usable = points.filter((point) => point.bucket !== "");
  const total = usable.reduce((sum, point) => sum + point.calls, 0);

  if (window === "24h" || usable.length <= HOURLY_POINT_CEILING) {
    return {
      buckets: usable.map((point) => point.bucket),
      values: usable.map((point) => point.calls),
      granularity: "hour",
      total,
    };
  }

  const byDay = new Map<string, number>();
  for (const point of usable) {
    const day = utcDayOf(point.bucket);
    // A bucket whose timestamp will not parse cannot be placed on a day axis.
    // Its calls stay in `total` — they happened — so the chart's own subtitle
    // can disclose that the plotted series is short of the window total rather
    // than silently under-reporting.
    if (!day) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + point.calls);
  }
  const days = [...byDay.keys()].sort();
  return {
    buckets: days,
    values: days.map((day) => byDay.get(day) ?? 0),
    granularity: "day",
    total,
  };
}

/**
 * The sentence under the chart. Returns null when there is nothing to qualify.
 *
 * Two separate disclosures, and they are different facts:
 *   - the roll-up changed the granularity the reader is looking at;
 *   - the plotted points do not add up to the window's calls, because some
 *     bucket carried a timestamp this client could not parse.
 */
export function mcpTrendNotice(series: McpTrendSeries): string | null {
  const plotted = series.values.reduce((sum, value) => sum + value, 0);
  const parts: string[] = [];
  if (series.granularity === "day") {
    parts.push(
      "Hourly buckets are summed into whole UTC days so the line stays readable — no call is dropped.",
    );
  }
  if (plotted !== series.total) {
    parts.push(
      `${series.total - plotted} calls sit in a bucket whose timestamp could not be read, so they are counted in the window but not plotted.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
