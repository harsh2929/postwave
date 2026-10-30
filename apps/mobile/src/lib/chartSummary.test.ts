import { describe, expect, it } from "vitest";

import {
  chartPointSummary,
  chartSummary,
  stepScrubIndex,
  trendDirection,
} from "./chartSummary";

describe("trendDirection", () => {
  it("reads direction between the first and last measured points", () => {
    expect(trendDirection([1, 5, 9])).toBe("up");
    expect(trendDirection([9, 5, 1])).toBe("down");
    expect(trendDirection([4, 9, 4])).toBe("steady");
  });

  it("refuses to claim a trend from a single measurement", () => {
    expect(trendDirection([7])).toBe("unknown");
    expect(trendDirection([null, 7, null])).toBe("unknown");
  });

  it("has no direction with no data", () => {
    expect(trendDirection([])).toBe("unknown");
    expect(trendDirection([null, undefined])).toBe("unknown");
  });

  it("ignores gaps when locating the endpoints", () => {
    expect(trendDirection([1, null, null, 9])).toBe("up");
  });
});

describe("chartSummary", () => {
  it("says so plainly when there is nothing to describe", () => {
    const spoken = chartSummary("Opens", [{ label: "Opens", values: [] }], 0);
    expect(spoken).toContain("no data");
    expect(spoken).not.toMatch(/NaN|Infinity|undefined/);
  });

  it("survives an all-null series without inventing numbers", () => {
    const spoken = chartSummary(
      "Opens",
      [{ label: "Opens", values: [null, null] }],
      2,
    );
    expect(spoken).toContain("no data");
    expect(spoken).not.toMatch(/NaN|Infinity/);
  });

  it("carries direction, endpoints, and range", () => {
    const spoken = chartSummary(
      "Opens",
      [{ label: "Opens", values: [10, 40, 30] }],
      3,
    );
    expect(spoken).toContain("Opens");
    expect(spoken).toContain("trending up");
    expect(spoken).toContain("10");
    expect(spoken).toContain("30");
    expect(spoken).toContain("40");
    expect(spoken).toContain("3 points");
  });

  it("describes a single point as a measurement, not a trend", () => {
    const spoken = chartSummary("Opens", [{ label: "Opens", values: [7] }], 1);
    expect(spoken).toContain("Single measurement");
    expect(spoken).not.toContain("trending");
  });

  it("names every series so the listener knows the chart is multi-valued", () => {
    const spoken = chartSummary(
      "Engagement",
      [
        { label: "Opens", values: [1, 2] },
        { label: "Clicks", values: [3, 4] },
      ],
      2,
    );
    expect(spoken).toContain("2 series");
    expect(spoken).toContain("Opens");
    expect(spoken).toContain("Clicks");
  });

  it("always points at the table escape hatch", () => {
    const spoken = chartSummary("Opens", [{ label: "Opens", values: [1, 2] }], 2);
    expect(spoken.toLowerCase()).toContain("table");
  });
});

describe("stepScrubIndex", () => {
  it("lands on the first point stepping forward from nowhere", () => {
    expect(stepScrubIndex(null, "increment", 5)).toBe(0);
  });

  it("lands on the last point stepping back from nowhere", () => {
    expect(stepScrubIndex(null, "decrement", 5)).toBe(4);
  });

  it("clamps rather than wrapping at either end", () => {
    expect(stepScrubIndex(4, "increment", 5)).toBe(4);
    expect(stepScrubIndex(0, "decrement", 5)).toBe(0);
  });

  it("has no cursor in an empty series", () => {
    expect(stepScrubIndex(null, "increment", 0)).toBeNull();
    expect(stepScrubIndex(2, "increment", 0)).toBeNull();
  });
});

describe("chartPointSummary", () => {
  const labels = ["Mar 1", "Mar 2"];
  const series = [{ label: "Subscribers", values: [1200, null] }];

  it("is null with no cursor, so the caller falls back to the summary", () => {
    expect(chartPointSummary(null, labels, series)).toBeNull();
  });

  it("speaks the full value, never the compacted one", () => {
    expect(chartPointSummary(0, labels, series)).toBe(
      "Mar 1: Subscribers 1,200. Point 1 of 2.",
    );
  });

  it("says a gap is unmeasured rather than reading it as zero", () => {
    expect(chartPointSummary(1, labels, series)).toContain(
      "Subscribers not measured",
    );
  });

  it("is null for an index the labels do not cover", () => {
    expect(chartPointSummary(9, labels, series)).toBeNull();
  });
});
