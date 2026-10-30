import { describe, expect, it } from "vitest";

import {
  GROUPED_DIMENSIONS,
  GROUPED_MAX_DAYS,
  groupedCaption,
  groupedChartInput,
  groupedTimeseriesPath,
  isGroupedDimension,
  isGroupedMetric,
  otherSeriesLabel,
  parseGroupedTimeseries,
} from "@/lib/groupedTimeseries";

function series(key: string, label: string, values: number[]) {
  return {
    key,
    label,
    points: values.map((value, index) => ({
      date: `2026-07-0${index + 1}`,
      value,
    })),
  };
}

const PAYLOAD = {
  series: [
    series("a", "Alpha", [10, 12, 14]),
    series("b", "Bravo", [8, 9, 10]),
    series("c", "Charlie", [5, 5, 5]),
    series("d", "Delta", [2, 2, 2]),
    series("e", "Echo", [1, 1, 1]),
    series("other", "Other", [30, 30, 30]),
  ],
};

describe("the dimension whitelist", () => {
  it("never offers `list`, which the handler 400s", () => {
    expect(GROUPED_DIMENSIONS).toEqual(["campaign", "domain"]);
    expect(isGroupedDimension("list")).toBe(false);
    expect(isGroupedDimension("campaign")).toBe(true);
    expect(isGroupedMetric("opens")).toBe(true);
    expect(isGroupedMetric("revenue")).toBe(false);
  });
});

describe("groupedTimeseriesPath", () => {
  it("builds the handler's query and clamps days to the server ceiling", () => {
    expect(groupedTimeseriesPath("domain", "clicks", 30)).toBe(
      "/api/v1/analytics/timeseries?group_by=domain&metric=clicks&days=30",
    );
    expect(groupedTimeseriesPath("campaign", "opens", 5000)).toContain(
      `days=${GROUPED_MAX_DAYS}`,
    );
    expect(groupedTimeseriesPath("campaign", "opens", 0)).toContain("days=1");
  });
});

describe("parseGroupedTimeseries", () => {
  it("reads the `{ series: [...] }` envelope and totals each series", () => {
    const parsed = parseGroupedTimeseries(PAYLOAD);
    expect(parsed).toHaveLength(6);
    expect(parsed[0]?.total).toBe(36);
  });

  it("accepts a bare array and survives garbage", () => {
    expect(parseGroupedTimeseries(PAYLOAD.series)).toHaveLength(6);
    expect(parseGroupedTimeseries(null)).toEqual([]);
    expect(parseGroupedTimeseries({ series: "nope" })).toEqual([]);
    expect(parseGroupedTimeseries([{ key: "" }])).toEqual([]);
  });

  it("keeps an unreadable day as a gap and out of the total", () => {
    const parsed = parseGroupedTimeseries({
      series: [
        {
          key: "a",
          label: "Alpha",
          points: [
            { date: "2026-07-01", value: 4 },
            { date: "2026-07-02", value: null },
            { date: "2026-07-03", value: 6 },
          ],
        },
      ],
    });
    expect(parsed[0]?.total).toBe(10);
    expect(Number.isNaN(parsed[0]?.points[1]?.value)).toBe(true);
  });
});

describe("groupedChartInput", () => {
  it("keeps the largest three and folds the rest into one trailing line", () => {
    const input = groupedChartInput(parseGroupedTimeseries(PAYLOAD));
    expect(input.series.map((s) => s.id)).toEqual(["a", "b", "c", "other"]);
    expect(input.rolledUp).toBe(2);
    // Delta + Echo + the server's own rollup, summed per day.
    expect(input.series[3]?.values).toEqual([33, 33, 33]);
  });

  it("never ranks the server's `other` bucket as a real group", () => {
    // `other` has the highest total in PAYLOAD; ranking it would put a bucket
    // named "Other" at the top of a chart meant to name the mover.
    const input = groupedChartInput(parseGroupedTimeseries(PAYLOAD));
    expect(input.series[0]?.id).toBe("a");
    expect(input.series[3]?.label).toContain("Other");
  });

  it("aligns series of different lengths on the union of dates", () => {
    const input = groupedChartInput(
      parseGroupedTimeseries({
        series: [
          {
            key: "a",
            label: "Alpha",
            points: [
              { date: "2026-07-01", value: 1 },
              { date: "2026-07-03", value: 3 },
            ],
          },
          {
            key: "b",
            label: "Bravo",
            points: [{ date: "2026-07-02", value: 2 }],
          },
        ],
      }),
    );
    expect(input.labels).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(input.series[0]?.values).toEqual([1, null, 3]);
    expect(input.series[1]?.values).toEqual([null, 2, null]);
  });

  it("adds no trailing line when nothing spilled, largest first", () => {
    const input = groupedChartInput(
      parseGroupedTimeseries({
        series: [series("a", "Alpha", [1, 2]), series("b", "Bravo", [3, 4])],
      }),
    );
    // Bravo totals 7 against Alpha's 3: rank is by VOLUME, not by payload
    // order, so the line a reader looks at first is the one that moved most.
    expect(input.series.map((s) => s.id)).toEqual(["b", "a"]);
    expect(input.rolledUp).toBe(0);
  });

  it("returns an empty input rather than throwing on no series", () => {
    expect(groupedChartInput([])).toEqual({
      labels: [],
      series: [],
      rolledUp: 0,
    });
  });
});

describe("otherSeriesLabel", () => {
  it("does not pretend the server's bucket is one group", () => {
    expect(otherSeriesLabel(0, true)).toBe("Other (everything else)");
    expect(otherSeriesLabel(2, true)).toBe("Other (2 more + rest)");
    expect(otherSeriesLabel(1, false)).toBe("Other (1 more)");
  });
});

describe("groupedCaption", () => {
  it("names both rollups so the reader can compare with the desktop", () => {
    expect(groupedCaption("campaign", 0)).toContain("top ten by volume");
    expect(groupedCaption("domain", 3)).toContain("folds 3 more");
  });
});
