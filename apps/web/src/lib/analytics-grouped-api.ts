// SPDX-License-Identifier: AGPL-3.0-only
//
// Tenant-level grouped engagement time series —
//   GET /api/v1/analytics/timeseries?group_by=campaign|domain&metric=opens|clicks|bounces&days=N
// (apps/api/internal/analytics/handlers.go GroupedTimeseries). The server
// returns the top-10 groups by volume plus an "other" rollup, each zero-filled
// to exactly `days` points, so the client never invents gaps.
//
// Campaign-scoped report readers live in campaign-analytics-api.ts; this is
// the one tenant-wide breakdown the Analytics page's Group-by menu drives.

import { api } from "@/lib/api";
import type { GroupedDimension } from "@/lib/analytics-view-params";

export type GroupedMetric = "opens" | "clicks" | "bounces";

export const GROUPED_METRICS: readonly GroupedMetric[] = [
  "opens",
  "clicks",
  "bounces",
];

export const GROUPED_METRIC_LABELS: Readonly<Record<GroupedMetric, string>> = {
  opens: "Opens",
  clicks: "Clicks",
  bounces: "Bounces",
};

/** The server bounds `days` to 1..90; the chart offers the page's windows. */
export const GROUPED_DAY_OPTIONS = [7, 30, 90] as const;
export type GroupedDays = (typeof GROUPED_DAY_OPTIONS)[number];

export interface GroupedPoint {
  date: string;
  value: number;
}

export interface GroupedSeries {
  /** Campaign id, sending domain, or "other". */
  key: string;
  label: string;
  points: GroupedPoint[];
}

export interface GroupedTimeseries {
  series: GroupedSeries[];
}

/** Top 10 plus the "other" rollup. */
const MAX_SERIES = 11;
const MAX_POINTS = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The grouped analytics response had an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Strict reader: a malformed payload is an error, never an empty chart that
 * reads as "no engagement".
 */
export function parseGroupedTimeseries(value: unknown): GroupedTimeseries {
  const root = record(value, "body");
  if (!Array.isArray(root.series) || root.series.length > MAX_SERIES) {
    throw new Error("The grouped analytics response had an invalid series list.");
  }
  const keys = new Set<string>();
  const series = root.series.map((item) => {
    const row = record(item, "series");
    if (
      typeof row.key !== "string" ||
      row.key.length === 0 ||
      row.key.length > 320 ||
      keys.has(row.key)
    ) {
      throw new Error("The grouped analytics response had an invalid group.");
    }
    keys.add(row.key);
    if (typeof row.label !== "string" || row.label.length > 500) {
      throw new Error("The grouped analytics response had an invalid label.");
    }
    if (!Array.isArray(row.points) || row.points.length > MAX_POINTS) {
      throw new Error("The grouped analytics response had invalid points.");
    }
    const points = row.points.map((raw) => {
      const point = record(raw, "point");
      if (
        typeof point.date !== "string" ||
        !DAY.test(point.date) ||
        typeof point.value !== "number" ||
        !Number.isSafeInteger(point.value) ||
        point.value < 0
      ) {
        throw new Error("The grouped analytics response had an invalid point.");
      }
      return { date: point.date, value: point.value };
    });
    return { key: row.key, label: row.label, points };
  });
  return { series };
}

export async function getGroupedTimeseries(
  input: {
    groupBy: GroupedDimension;
    metric: GroupedMetric;
    days: GroupedDays;
  },
  opts: { signal?: AbortSignal } = {},
): Promise<GroupedTimeseries> {
  return parseGroupedTimeseries(
    await api.get<unknown>("/api/v1/analytics/timeseries", {
      signal: opts.signal,
      query: {
        group_by: input.groupBy,
        metric: input.metric,
        days: input.days,
      },
    }),
  );
}

/** Sum of every point in one series. */
export function seriesTotal(series: GroupedSeries): number {
  return series.points.reduce((sum, point) => sum + point.value, 0);
}

/**
 * Display labels, disambiguated: two campaigns sharing a name would otherwise
 * collide in the legend, so repeats carry their key.
 */
export function groupedSeriesLabels(series: GroupedSeries[]): string[] {
  const seen = new Map<string, number>();
  return series.map((s) => {
    const base = s.key === "other" ? "Other" : s.label || s.key;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${s.key})`;
  });
}
