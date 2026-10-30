import { describe, expect, it } from "vitest";

import {
  auditActivitySummary,
  auditActivityTone,
  AUDIT_BASELINE_MIN_DAYS,
  AUDIT_ELEVATED_RATIO,
  median,
  normalizeAuditStats,
  type AuditStats,
} from "./auditStats";

function stats(daily: number[], totalEvents = daily.reduce((a, b) => a + b, 0)): AuditStats {
  return {
    totalEvents,
    byActorType: [],
    topActions: [],
    daily: daily.map((count, i) => ({ date: `2026-07-${String(i + 1).padStart(2, "0")}`, count })),
  };
}

describe("median", () => {
  it("is null for an empty series rather than a misleading zero", () => {
    expect(median([])).toBeNull();
  });

  it("takes the middle of an odd series and the mean of the middle pair", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is not dragged by a single incident day, unlike a mean", () => {
    // A mean here is 206; the median stays at 10, so the incident day is still
    // detectable as an outlier instead of redefining "normal".
    expect(median([10, 10, 10, 10, 1000])).toBe(10);
  });
});

describe("auditActivitySummary", () => {
  it("refuses to judge before there is enough history", () => {
    const summary = auditActivitySummary(stats([5, 6]), "the last 7 days");
    expect(summary.baseline).toBeNull();
    expect(summary.level).toBe("unknown");
    expect(summary.detail).toContain("Not enough history");
  });

  it("needs the documented minimum of COMPLETE prior days", () => {
    // AUDIT_BASELINE_MIN_DAYS prior days plus today.
    const days = new Array(AUDIT_BASELINE_MIN_DAYS).fill(10).concat([10]);
    expect(auditActivitySummary(stats(days), "the last 7 days").baseline).toBe(10);
  });

  it("excludes today from the baseline it is compared against", () => {
    // Without the exclusion, today's 1000 would enter the median and make the
    // spike look closer to normal.
    const summary = auditActivitySummary(stats([10, 10, 10, 10, 1000]), "the last 7 days");
    expect(summary.baseline).toBe(10);
    expect(summary.today).toBe(1000);
    expect(summary.level).toBe("elevated");
  });

  it("calls a genuine spike elevated and says by how much", () => {
    const summary = auditActivitySummary(stats([10, 10, 10, 34]), "the last 7 days");
    expect(summary.level).toBe("elevated");
    expect(summary.headline).toContain("Elevated");
    expect(summary.detail).toContain("3.4×");
  });

  it("does not cry wolf just below the threshold", () => {
    const today = Math.floor(10 * AUDIT_ELEVATED_RATIO) - 1; // 24 against a 10 baseline
    const summary = auditActivitySummary(stats([10, 10, 10, today]), "the last 7 days");
    expect(summary.level).toBe("normal");
    expect(summary.headline).toContain("Normal");
  });

  it("names a quiet day rather than staying silent about it", () => {
    const summary = auditActivitySummary(stats([20, 20, 20, 4]), "the last 7 days");
    expect(summary.level).toBe("quiet");
    expect(summary.detail).toContain("quieter than");
  });

  it("handles a zero baseline without an infinite ratio", () => {
    const spike = auditActivitySummary(stats([0, 0, 0, 12]), "the last 24 hours");
    expect(spike.level).toBe("elevated");
    expect(spike.detail).toContain("recorded nothing at all");
    expect(spike.detail).not.toContain("Infinity");

    const silent = auditActivitySummary(stats([0, 0, 0, 0]), "the last 24 hours");
    expect(silent.level).toBe("quiet");
  });

  it("says the data is unavailable rather than inventing a zero", () => {
    const summary = auditActivitySummary(null, "the last 7 days");
    expect(summary.today).toBeNull();
    expect(summary.level).toBe("unknown");
    expect(summary.headline).toBe("Activity unavailable");
    expect(summary.series).toEqual([]);
  });

  it("speaks both lines, because the sparkline is not spoken", () => {
    const summary = auditActivitySummary(stats([10, 10, 10, 11]), "the last 7 days");
    expect(summary.spoken).toBe(`${summary.headline}. ${summary.detail}`);
  });
});

describe("normalizeAuditStats", () => {
  it("reads the real payload", () => {
    const out = normalizeAuditStats({
      totalEvents: 41,
      byActorType: [{ label: "user", count: 40 }],
      topActions: [{ label: "campaign.send", count: 12 }],
      daily: [{ date: "2026-07-25", count: 41 }],
    });
    expect(out?.totalEvents).toBe(41);
    expect(out?.byActorType).toHaveLength(1);
    expect(out?.daily[0]).toEqual({ date: "2026-07-25", count: 41 });
  });

  it("degrades a drifted payload instead of throwing on a compliance screen", () => {
    expect(normalizeAuditStats(null)).toBeNull();
    expect(normalizeAuditStats("nope")).toBeNull();
    const out = normalizeAuditStats({ totalEvents: "many", daily: "nope" });
    expect(out?.totalEvents).toBe(0);
    expect(out?.daily).toEqual([]);
  });

  it("drops undated buckets and coerces a non-numeric count to zero", () => {
    const out = normalizeAuditStats({
      totalEvents: 1,
      daily: [{ count: 5 }, { date: "2026-07-25", count: "x" }],
    });
    expect(out?.daily).toEqual([{ date: "2026-07-25", count: 0 }]);
  });

  it("refuses a negative total", () => {
    expect(normalizeAuditStats({ totalEvents: -4 })?.totalEvents).toBe(0);
  });
});

describe("auditActivityTone", () => {
  it("gives each level a distinct tone, always paired with the word", () => {
    expect(auditActivityTone("elevated")).toBe("warning");
    expect(auditActivityTone("quiet")).toBe("info");
    expect(auditActivityTone("normal")).toBe("neutral");
    expect(auditActivityTone("unknown")).toBe("neutral");
  });
});
