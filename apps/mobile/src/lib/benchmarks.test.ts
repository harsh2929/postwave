import { describe, expect, it } from "vitest";

import {
  LEVEL_BAND,
  benchmarkDirection,
  compareAll,
  compareToBenchmark,
  parseBenchmarks,
} from "./benchmarks";

// The handler's own illustrative fallback, verbatim from
// apps/api/internal/analytics/dashboard_layout.go::illustrativeBenchmarks.
const BODY = {
  rows: [
    { metric: "opens", average: 0.214, source: "Industry average 2024" },
    { metric: "clicks", average: 0.026, source: "Industry average 2024" },
    { metric: "bounces", average: 0.009, source: "Industry average 2024" },
    { metric: "unsubs", average: 0.002, source: "Industry average 2024" },
  ],
  note: "Illustrative averages — platform-wide aggregate not available yet.",
};

describe("parseBenchmarks", () => {
  it("reads the verified handler shape", () => {
    const benchmarks = parseBenchmarks(BODY);
    expect(benchmarks.rows).toHaveLength(4);
    expect(benchmarks.note).toContain("Illustrative averages");
  });

  it("drops an average outside [0,1] rather than clamping a unit change", () => {
    const benchmarks = parseBenchmarks({
      rows: [
        { metric: "opens", average: 21.4, source: "percent-not-fraction" },
        { metric: "clicks", average: 0.026, source: "ok" },
      ],
    });
    expect(benchmarks.rows.map((row) => row.metric)).toEqual(["clicks"]);
  });

  it("drops a metric it cannot name", () => {
    const benchmarks = parseBenchmarks({
      rows: [{ metric: "conversions", average: 0.1, source: "x" }],
    });
    expect(benchmarks.rows).toEqual([]);
  });

  it("survives a body that is not the shape we expect", () => {
    for (const raw of [null, undefined, 3, "no", [], {}]) {
      expect(parseBenchmarks(raw).rows).toEqual([]);
      expect(parseBenchmarks(raw).note).toBeNull();
    }
  });
});

describe("direction", () => {
  it("knows which way is good", () => {
    expect(benchmarkDirection("opens")).toBe("higher");
    expect(benchmarkDirection("clicks")).toBe("higher");
    expect(benchmarkDirection("bounces")).toBe("lower");
    expect(benchmarkDirection("unsubs")).toBe("lower");
  });
});

describe("compareToBenchmark", () => {
  const benchmarks = parseBenchmarks(BODY);

  it("calls a high open rate ahead and a high bounce rate behind", () => {
    expect(compareToBenchmark("opens", 0.34, benchmarks)?.verdict).toBe("ahead");
    expect(compareToBenchmark("bounces", 0.03, benchmarks)?.verdict).toBe(
      "behind",
    );
    // …and the same sign flips the other way for a LOW bounce rate.
    expect(compareToBenchmark("bounces", 0.002, benchmarks)?.verdict).toBe(
      "ahead",
    );
    expect(compareToBenchmark("opens", 0.09, benchmarks)?.verdict).toBe(
      "behind",
    );
  });

  it("treats a small difference as level rather than as movement", () => {
    // 5% above the 21.4% benchmark, inside the band.
    const inside = compareToBenchmark("opens", 0.214 * 1.05, benchmarks);
    expect(inside?.verdict).toBe("level");
    expect(inside?.sentence).toBe("Open rate is in line with the benchmark.");
    // Just outside it.
    const outside = compareToBenchmark(
      "opens",
      0.214 * (1 + LEVEL_BAND + 0.01),
      benchmarks,
    );
    expect(outside?.verdict).toBe("ahead");
  });

  it("says which direction is better, not just which is bigger", () => {
    expect(compareToBenchmark("bounces", 0.03, benchmarks)?.sentence).toContain(
      "above the benchmark — worse than typical",
    );
    expect(compareToBenchmark("opens", 0.34, benchmarks)?.sentence).toContain(
      "above the benchmark — better than typical",
    );
  });

  it("says nothing when it has nothing to compare", () => {
    expect(compareToBenchmark("opens", null, benchmarks)).toBeNull();
    expect(compareToBenchmark("opens", 0.3, parseBenchmarks({}))).toBeNull();
    // A zero average would make every workspace infinitely ahead.
    expect(
      compareToBenchmark(
        "opens",
        0.3,
        parseBenchmarks({ rows: [{ metric: "opens", average: 0, source: "x" }] }),
      ),
    ).toBeNull();
  });

  it("carries the server's provenance with the verdict", () => {
    expect(compareToBenchmark("opens", 0.34, benchmarks)?.source).toBe(
      "Industry average 2024",
    );
  });
});

describe("compareAll", () => {
  it("keeps the deliverability reading order and skips unmeasured rates", () => {
    const rows = compareAll(
      { opens: 0.34, clicks: null, bounces: 0.03 },
      parseBenchmarks(BODY),
    );
    expect(rows.map((row) => row.metric)).toEqual(["opens", "bounces"]);
  });
});
