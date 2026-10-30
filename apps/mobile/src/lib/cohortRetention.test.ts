import { describe, expect, it } from "vitest";

import {
  cohortBarsAt,
  cohortComparison,
  cohortMonthName,
  parseCohorts,
} from "@/lib/cohortRetention";

/** Shaped exactly like the handler's `[]CohortRow`. */
const JUNE = { cohort_label: "2026-06", cohort_size: 400, weeks: [0.5, 0.4, 0.3, 0.25] };
const MAY = { cohort_label: "2026-05", cohort_size: 500, weeks: [0.6, 0.5, 0.42, 0.35, 0.3] };
/** Two weeks old: the server TRUNCATES, it does not pad with zeros. */
const JULY = { cohort_label: "2026-07", cohort_size: 300, weeks: [0.55, 0.4] };

describe("parseCohorts", () => {
  it("reads the handler's array and orders it newest first", () => {
    const rows = parseCohorts([MAY, JULY, JUNE]);
    expect(rows.map((r) => r.label)).toEqual(["2026-07", "2026-06", "2026-05"]);
  });

  it("keeps the truncated week array as the maturity claim", () => {
    expect(parseCohorts([JULY])[0]?.weeks).toHaveLength(2);
  });

  it("clamps an impossible rate rather than rendering 140%", () => {
    const rows = parseCohorts([
      { cohort_label: "2026-06", cohort_size: 10, weeks: [1.4, -0.2] },
    ]);
    expect(rows[0]?.weeks).toEqual([1, 0]);
  });

  it("truncates at a non-numeric cell instead of inventing a week", () => {
    const rows = parseCohorts([
      { cohort_label: "2026-06", cohort_size: 10, weeks: [0.5, null, 0.3] },
    ]);
    expect(rows[0]?.weeks).toEqual([0.5]);
  });

  it("survives a garbage payload", () => {
    expect(parseCohorts(null)).toEqual([]);
    expect(parseCohorts({ items: [{ cohort_size: 5 }] })).toEqual([]);
  });
});

describe("cohortComparison", () => {
  it("compares the two newest usable cohorts at their deepest COMMON week", () => {
    const result = cohortComparison(parseCohorts([JUNE, MAY, JULY]));
    // July has 2 mature weeks, June has 4 → week index 1, not July's missing 4.
    expect(result?.weekIndex).toBe(1);
    expect(result?.recent.label).toBe("2026-07");
    expect(result?.prior.label).toBe("2026-06");
  });

  it("never reads an immature week as a collapse to zero", () => {
    const result = cohortComparison(parseCohorts([JUNE, MAY, JULY]));
    // Naively indexing week 4 would give July 0 and report a 25-point drop.
    expect(result?.recentRate).toBeCloseTo(0.4);
    expect(result?.priorRate).toBeCloseTo(0.4);
    expect(result?.direction).toBe("flat");
  });

  it("states the direction and magnitude in percentage points", () => {
    const result = cohortComparison(parseCohorts([JUNE, MAY]));
    // Deepest common week is index 3: June 0.25 vs May 0.35 → −10 points.
    expect(result?.weekIndex).toBe(3);
    expect(result?.deltaPoints).toBeCloseTo(-10);
    expect(result?.direction).toBe("down");
    expect(result?.headline).toContain("10.0 points less");
    expect(result?.headline).toContain("June 2026");
    expect(result?.headline).toContain("May 2026");
    expect(result?.headline).toContain("week 4");
  });

  it("refuses to compare cohorts too small for a rate to mean anything", () => {
    const tiny = [
      { cohort_label: "2026-06", cohort_size: 8, weeks: [0.5, 0.4] },
      { cohort_label: "2026-05", cohort_size: 9, weeks: [0.6, 0.5] },
    ];
    expect(cohortComparison(parseCohorts(tiny))).toBeNull();
  });

  it("refuses with fewer than two usable cohorts", () => {
    expect(cohortComparison(parseCohorts([JUNE]))).toBeNull();
    expect(cohortComparison([])).toBeNull();
  });

  it("refuses when a cohort has no mature week at all", () => {
    const rows = parseCohorts([
      { cohort_label: "2026-07", cohort_size: 300, weeks: [] },
      MAY,
    ]);
    expect(cohortComparison(rows)).toBeNull();
  });

  it("calls a sub-half-point difference flat rather than movement", () => {
    const rows = parseCohorts([
      { cohort_label: "2026-06", cohort_size: 400, weeks: [0.503] },
      { cohort_label: "2026-05", cohort_size: 400, weeks: [0.5] },
    ]);
    expect(cohortComparison(rows)?.direction).toBe("flat");
    expect(cohortComparison(rows)?.headline).toContain("same rate");
  });
});

describe("cohortBarsAt", () => {
  it("omits cohorts that have not reached the week rather than drawing zero", () => {
    const rows = parseCohorts([JUNE, MAY, JULY]);
    const bars = cohortBarsAt(rows, 3);
    expect(bars.map((b) => b.id)).toEqual(["2026-06", "2026-05"]);
  });

  it("labels bars in percentage points with the cohort size as the hint", () => {
    const bars = cohortBarsAt(parseCohorts([MAY]), 0);
    expect(bars[0]).toMatchObject({ label: "May 2026", value: 60, hint: "500 joined" });
  });
});

describe("cohortMonthName", () => {
  it("names the month without going through Date, which shifts by timezone", () => {
    expect(cohortMonthName("2026-06")).toBe("June 2026");
    expect(cohortMonthName("2026-01")).toBe("January 2026");
  });

  it("passes an unexpected label through untouched", () => {
    expect(cohortMonthName("week-3")).toBe("week-3");
    expect(cohortMonthName("2026-13")).toBe("2026-13");
  });
});
