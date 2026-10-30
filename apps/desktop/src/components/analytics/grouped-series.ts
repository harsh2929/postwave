/**
 * grouped-series — pure series-building logic behind
 * GroupedTimeseriesChart. Lives in a .ts module (not the .tsx
 * component) so the node-environment vitest suite can import it
 * without a JSX transform (same pattern as suppressions/trend-series).
 */

// Type-only imports: erased at compile time, so importing this module
// never pulls the .tsx chart component into a node test run.
import type {
  AnalyticsTimeseriesGroupBy,
  AnalyticsTimeseriesMetric,
  AnalyticsTimeseriesSeries,
} from "../../lib/api-client";
import type { MultiLineSeries } from "../charts/MultiLineChart";
import type { GroupByDimension } from "./GroupByMenu";

/* ---------- Analytics-page group-by policy --------------------------- */

/**
 * Dimensions GroupByMenu lists that the Analytics page cannot chart
 * yet. The grouped time-series endpoint (GET /api/v1/analytics/
 * timeseries) only breaks engagement down by campaign or sending
 * domain, so every other dimension renders disabled with an honest
 * "no data" chip. (`list` is always disabled inside the menu itself —
 * engagement events carry no list attribution — and doesn't need
 * repeating here.)
 */
export const ANALYTICS_GROUPBY_UNAVAILABLE: GroupByDimension[] = [
  "segment",
  "country",
  "mail-client",
  "device",
];

/**
 * Map the menu's selection onto the grouped chart's dimension.
 * Returns null for "none" (and any dimension the page can't chart),
 * which keeps the default ungrouped Engagement-velocity view.
 */
export function groupedChartDimension(
  d: GroupByDimension,
): AnalyticsTimeseriesGroupBy | null {
  return d === "campaign" || d === "domain" ? d : null;
}

/* ---------- series building ------------------------------------------ */

/** Headline label per metric — shared by the chart card and any
 *  consumer that needs to format the active metric. */
export const GROUPED_METRIC_LABELS: Readonly<
  Record<AnalyticsTimeseriesMetric, string>
> = {
  opens: "Opens",
  clicks: "Clicks",
  bounces: "Bounces",
};

/** Muted swatch for the server's "other" rollup series so the tail
 *  never steals a headline palette colour from a named group. */
const OTHER_COLOR = "color-mix(in srgb, var(--pw-fg-subtle) 55%, transparent)";

/**
 * Map the API's grouped time-series (top-10 + "other", zero-filled by
 * the server) into MultiLineChart series.
 *
 * - Legend toggles in MultiLineChart are keyed by `label`, so two
 *   campaigns that share a display name would collide; duplicate
 *   labels get a short key suffix to stay distinct.
 * - The server's "other" rollup keeps its position but renders in a
 *   muted colour so the named groups own the palette.
 */
export function buildGroupedSeries(
  series: AnalyticsTimeseriesSeries[],
): MultiLineSeries[] {
  const seen = new Map<string, number>();
  return series.map((s) => {
    const base = s.label || s.key;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const label = n === 0 ? base : `${base} (${s.key})`;
    const out: MultiLineSeries = {
      label,
      values: s.points.map((p) => ({ date: p.date, count: p.value })),
    };
    if (s.key === "other") out.color = OTHER_COLOR;
    return out;
  });
}

/** Sum of every point across all series — used for the honest
 *  "no events in the window" empty state. */
export function groupedSeriesTotal(
  series: AnalyticsTimeseriesSeries[],
): number {
  let total = 0;
  for (const s of series) for (const p of s.points) total += p.value;
  return total;
}
