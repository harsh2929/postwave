import { describe, expect, it } from "vitest";

import {
  formatDelta,
  isAnomalous,
  rangeLabel,
  rateFromCounts,
  rateFromUniqueRecipients,
  sparklinePath,
} from "../../lib/dashboard-helpers";

describe("formatDelta — count", () => {
  it("positive count gives up arrow and +N", () => {
    expect(formatDelta(2500, 2352, "count")).toEqual({
      dir: "up",
      text: "+148",
    });
  });
  it("negative count gives down arrow", () => {
    expect(formatDelta(900, 1000, "count")).toEqual({
      dir: "down",
      text: "-100",
    });
  });
  it("flat (rounds to zero) gives em-dash", () => {
    expect(formatDelta(10, 10, "count")).toEqual({
      dir: "flat",
      text: "—",
    });
  });
  it("missing prev gives em-dash", () => {
    expect(formatDelta(10, null, "count")).toEqual({
      dir: "flat",
      text: "—",
    });
  });
  it("large count formats with locale separators", () => {
    expect(formatDelta(15_000, 10_000, "count").text).toBe("+5,000");
  });
});

describe("formatDelta — percent-points", () => {
  it("0..1 fraction inputs are converted to percent points", () => {
    expect(formatDelta(0.224, 0.212, "percent-points")).toEqual({
      dir: "up",
      text: "+1.2pt",
    });
  });
  it("uses one explicit scale — no per-value fraction/percent guessing", () => {
    // Mixed-scale inputs used to normalise curr and prev differently
    // and fabricate deltas; both values are now treated as fractions.
    expect(formatDelta(0.935, 0.0, "percent-points")).toEqual({
      dir: "up",
      text: "+93.5pt",
    });
    expect(formatDelta(0.5, 0.5, "percent-points")).toEqual({
      dir: "flat",
      text: "—",
    });
  });
  it("very small delta is flat", () => {
    expect(formatDelta(0.5004, 0.5, "percent-points")).toEqual({
      dir: "flat",
      text: "—",
    });
  });
  it("negative pp gives down arrow", () => {
    expect(formatDelta(0.18, 0.21, "percent-points")).toEqual({
      dir: "down",
      text: "-3.0pt",
    });
  });
});

describe("sparklinePath", () => {
  it("empty values returns empty path", () => {
    const p = sparklinePath([], 100, 28);
    expect(p.line).toBe("");
    expect(p.area).toBe("");
  });
  it("single value is a flat horizontal line", () => {
    const p = sparklinePath([5], 100, 28, 0);
    expect(p.line).toBe("M0,28 L100,28");
  });
  it("monotonic series starts at bottom-left, ends top-right", () => {
    const p = sparklinePath([0, 1, 2], 4, 4, 0);
    // 3 points → x at 0, 2, 4. Range 0..2 maps to y=4..0.
    expect(p.line).toBe("M0,4 L2,2 L4,0");
    expect(p.lastX).toBe(4);
    expect(p.lastY).toBe(0);
  });
  it("area path begins at bottom-left and closes back to bottom-right", () => {
    const p = sparklinePath([0, 1], 2, 4, 0);
    expect(p.area).toMatch(/^M0,4 /);
    expect(p.area).toMatch(/Z$/);
  });
  it("width<=0 is safe", () => {
    expect(sparklinePath([1, 2, 3], 0, 28).line).toBe("");
  });
  it("padding is reserved at the top — peak at y=padding, min at y=height", () => {
    const p = sparklinePath([0, 1], 2, 10, 2);
    // min value sits on the baseline (y = 10), peak at y = padding (2).
    expect(p.line).toBe("M0,10 L2,2");
    expect(p.lastY).toBe(2);
  });
});

describe("rateFromCounts", () => {
  it("normal rate", () => {
    expect(rateFromCounts(50, 200)).toBe(0.25);
  });
  it("zero denominator gives null", () => {
    expect(rateFromCounts(50, 0)).toBeNull();
  });
  it("null inputs give null", () => {
    expect(rateFromCounts(null, 100)).toBeNull();
    expect(rateFromCounts(50, null)).toBeNull();
  });
  it("rejects negative counts and non-finite quotients", () => {
    expect(rateFromCounts(-1, 100)).toBeNull();
    expect(rateFromCounts(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull();
    expect(rateFromCounts(1.5, 100)).toBeNull();
    expect(rateFromCounts(1, 100.5)).toBeNull();
  });
  it("rejects a numerator above its denominator", () => {
    expect(rateFromCounts(101, 100)).toBeNull();
  });
});

describe("rateFromUniqueRecipients", () => {
  it("prefers unique delivered when it covers the numerator", () => {
    expect(rateFromUniqueRecipients(40, 80, 100)).toBe(0.5);
  });

  it("falls back to unique sent for partial delivery-provider evidence", () => {
    expect(rateFromUniqueRecipients(90, 10, 100)).toBe(0.9);
  });

  it("returns unavailable when neither unique denominator is credible", () => {
    expect(rateFromUniqueRecipients(101, 50, 100)).toBeNull();
    expect(rateFromUniqueRecipients(1, undefined, undefined)).toBeNull();
  });
});

describe("isAnomalous", () => {
  it("explicit true → true", () => expect(isAnomalous(true)).toBe(true));
  it("explicit false → false", () => expect(isAnomalous(false)).toBe(false));
  it("undefined → false", () => expect(isAnomalous(undefined)).toBe(false));
});

describe("rangeLabel", () => {
  it("7d", () => expect(rangeLabel("7d")).toBe("Last 7 days"));
  it("30d", () => expect(rangeLabel("30d")).toBe("Last 30 days"));
  it("90d", () => expect(rangeLabel("90d")).toBe("Last 90 days"));
});

import {
  dashboardSnapshotMarkdown,
  forecastNextMilestone,
  nextRoundMilestone,
} from "../../lib/dashboard-helpers";

describe("nextRoundMilestone", () => {
  it("below 100 → 100", () => expect(nextRoundMilestone(42)).toBe(100));
  it("exactly 100 → 250", () => expect(nextRoundMilestone(100)).toBe(250));
  it("between → next rung", () => expect(nextRoundMilestone(800)).toBe(1000));
  it("very high → next rung", () =>
    expect(nextRoundMilestone(3_000_000)).toBe(5_000_000));
  it("past final rung → null", () =>
    expect(nextRoundMilestone(50_000_000)).toBeNull());
});

describe("forecastNextMilestone", () => {
  const today = new Date("2026-05-26T00:00:00Z");

  it("series too short → null", () => {
    expect(forecastNextMilestone([1, 2, 3], 500, today)).toBeNull();
  });
  it("no growth → null", () => {
    // Slope 0; projectedDailyAdds < 0.5.
    expect(
      forecastNextMilestone([0, 0, 0, 0, 0, 0, 0, 0], 500, today),
    ).toBeNull();
  });
  it("steady growth → returns next milestone", () => {
    // ~5 new subs per day, current 480. Next milestone is 500 → 4 days.
    const series = new Array(14).fill(5);
    const fc = forecastNextMilestone(series, 480, today);
    expect(fc).not.toBeNull();
    expect(fc?.target).toBe(500);
    expect(fc?.daysAway).toBeLessThanOrEqual(5);
  });
  it("past horizon → null", () => {
    // Tiny growth; 100 -> 100,000 would take longer than the horizon.
    const series = new Array(14).fill(1);
    expect(forecastNextMilestone(series, 100, today, 30)).toBeNull();
  });
});

describe("dashboardSnapshotMarkdown", () => {
  it("renders header + rows", () => {
    const md = dashboardSnapshotMarkdown({
      rangeLabel: "Last 30 days",
      rows: [
        { label: "Subscribers", value: "12,481", delta: { text: "+148" } },
        { label: "Open rate", value: "22.4%", delta: { text: "+1.2pt" } },
      ],
      methodology: "Rates use verified recipient evidence.",
    });
    expect(md).toMatch(/📊 Moosewave — Last 30 days/);
    expect(md).toMatch(/Subscribers: +12,481/);
    expect(md).toMatch(/Open rate: +22.4%/);
    expect(md).toContain("_Rates use verified recipient evidence._");
  });
});
