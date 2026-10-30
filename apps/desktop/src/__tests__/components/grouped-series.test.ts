// Grouped engagement time-series mapping (desktop audit task: enable
// campaign/domain group-by). buildGroupedSeries adapts the
// /api/v1/analytics/timeseries response (top-10 + "other", zero-filled)
// into MultiLineChart series; legend toggles are keyed by label, so
// duplicate display names must stay distinct.

import { describe, expect, it } from "vitest";

import {
  GROUPED_METRIC_LABELS,
  buildGroupedSeries,
  groupedSeriesTotal,
} from "../../components/analytics/grouped-series";
import type { AnalyticsTimeseriesSeries } from "../../lib/api-client";

function series(
  key: string,
  label: string,
  values: number[],
): AnalyticsTimeseriesSeries {
  return {
    key,
    label,
    points: values.map((v, i) => ({
      date: `2026-06-0${i + 1}`,
      value: v,
    })),
  };
}

describe("buildGroupedSeries", () => {
  it("maps {date,value} points to MultiLineChart {date,count} values", () => {
    const out = buildGroupedSeries([series("c1", "Welcome", [1, 2, 3])]);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("Welcome");
    expect(out[0]?.values).toEqual([
      { date: "2026-06-01", count: 1 },
      { date: "2026-06-02", count: 2 },
      { date: "2026-06-03", count: 3 },
    ]);
    // Named groups take palette colors — no override.
    expect(out[0]?.color).toBeUndefined();
  });

  it("disambiguates duplicate labels with the series key", () => {
    const out = buildGroupedSeries([
      series("c1", "Welcome", [1]),
      series("c2", "Welcome", [2]),
    ]);
    expect(out[0]?.label).toBe("Welcome");
    expect(out[1]?.label).toBe("Welcome (c2)");
  });

  it("falls back to the key when the label is empty", () => {
    const out = buildGroupedSeries([series("dom.example.com", "", [1])]);
    expect(out[0]?.label).toBe("dom.example.com");
  });

  it("gives the server's 'other' rollup a muted color override", () => {
    const out = buildGroupedSeries([
      series("c1", "Welcome", [1]),
      series("other", "Other", [9]),
    ]);
    expect(out[0]?.color).toBeUndefined();
    expect(out[1]?.color).toBeTruthy();
  });

  it("returns [] for an empty response", () => {
    expect(buildGroupedSeries([])).toEqual([]);
  });
});

describe("groupedSeriesTotal", () => {
  it("sums every point across all series (empty-state check)", () => {
    expect(groupedSeriesTotal([])).toBe(0);
    expect(
      groupedSeriesTotal([
        series("c1", "A", [0, 0]),
        series("other", "Other", [0]),
      ]),
    ).toBe(0);
    expect(
      groupedSeriesTotal([series("c1", "A", [1, 2]), series("c2", "B", [3])]),
    ).toBe(6);
  });
});

describe("GROUPED_METRIC_LABELS", () => {
  it("covers every metric the endpoint accepts", () => {
    expect(GROUPED_METRIC_LABELS).toEqual({
      opens: "Opens",
      clicks: "Clicks",
      bounces: "Bounces",
    });
  });
});
