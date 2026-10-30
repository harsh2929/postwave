import { describe, expect, it } from "vitest";

import {
  growthDeltaLine,
  growthSpokenSummary,
  hasPlottableTrend,
  metricIsPartial,
  metricIsUnavailable,
  parseAudienceGrowth,
} from "./audienceGrowth";

const wire = {
  days: 30,
  series: [
    {
      date: "2026-06-26",
      evaluated_at: "2026-06-26T00:05:00Z",
      total: 1000,
      added: 10,
      unsubbed: 2,
      lapsed: 0,
    },
    {
      date: "2026-07-25",
      evaluated_at: "2026-07-25T00:05:00Z",
      total: 1412,
      added: 20,
      unsubbed: 3,
      lapsed: 0,
    },
  ],
  delta: 412,
  delta_pct: 41.2,
  total_added: 430,
  total_unsubbed: 18,
  note: "UTC calendar days; unsubbed is a verified lower bound.",
  partial_metrics: ["unsubbed"],
  unavailable_metrics: ["lapsed"],
  metric_contract_version: "verified-exact-ledger-v2",
};

describe("parseAudienceGrowth", () => {
  it("reads the SUB-124 envelope", () => {
    const g = parseAudienceGrowth(wire);
    expect(g.days).toBe(30);
    expect(g.series).toHaveLength(2);
    expect(g.series[1]).toEqual({
      date: "2026-07-25",
      total: 1412,
      added: 20,
      unsubbed: 3,
    });
    expect(g.delta).toBe(412);
    expect(g.deltaPct).toBeCloseTo(41.2);
    expect(g.note).toContain("lower bound");
    expect(g.partialMetrics).toEqual(["unsubbed"]);
    expect(g.unavailableMetrics).toEqual(["lapsed"]);
  });

  it("drops points with no date rather than plotting an undated value", () => {
    expect(
      parseAudienceGrowth({ series: [{ total: 5 }, { date: "2026-01-01" }] })
        .series,
    ).toEqual([{ date: "2026-01-01", total: 0, added: 0, unsubbed: 0 }]);
  });

  it("degrades to an empty growth on junk", () => {
    const g = parseAudienceGrowth(null);
    expect(g.series).toEqual([]);
    expect(g.days).toBe(0);
    expect(g.note).toBe("");
  });
});

describe("trend guards", () => {
  it("refuses to call one snapshot a trend", () => {
    expect(hasPlottableTrend(parseAudienceGrowth(wire))).toBe(true);
    expect(
      hasPlottableTrend(
        parseAudienceGrowth({ ...wire, series: wire.series.slice(0, 1) }),
      ),
    ).toBe(false);
    expect(hasPlottableTrend(undefined)).toBe(false);
  });

  it("reports the spec's unavailable and partial metric sets", () => {
    const g = parseAudienceGrowth(wire);
    expect(metricIsUnavailable(g, "lapsed")).toBe(true);
    expect(metricIsUnavailable(g, "added")).toBe(false);
    expect(metricIsPartial(g, "unsubbed")).toBe(true);
    expect(metricIsPartial(g, "added")).toBe(false);
    expect(metricIsUnavailable(undefined, "lapsed")).toBe(false);
  });
});

describe("growthDeltaLine", () => {
  it("formats a positive delta with its percentage", () => {
    expect(growthDeltaLine(parseAudienceGrowth(wire))).toBe(
      "+412 in 30 days (+41.2%)",
    );
  });

  it("formats a negative delta with a real minus sign", () => {
    expect(
      growthDeltaLine(
        parseAudienceGrowth({ ...wire, delta: -50, delta_pct: -5 }),
      ),
    ).toBe("−50 in 30 days (−5.0%)");
  });

  it("omits the percentage when the server reports zero", () => {
    expect(
      growthDeltaLine(parseAudienceGrowth({ ...wire, delta: 0, delta_pct: 0 })),
    ).toBe("0 in 30 days");
  });

  it("is null when there is no trend, so the caller shows the note instead", () => {
    expect(
      growthDeltaLine(
        parseAudienceGrowth({ ...wire, series: wire.series.slice(0, 1) }),
      ),
    ).toBeNull();
    expect(growthDeltaLine(undefined)).toBeNull();
  });
});

describe("growthSpokenSummary", () => {
  it("speaks exact numbers and the lower-bound caveat", () => {
    expect(growthSpokenSummary(parseAudienceGrowth(wire))).toBe(
      "Audience growth over 30 days. 1,412 subscribers now. 430 added. At least 18 unsubscribed.",
    );
  });

  it("drops the caveat when the metric is not partial", () => {
    expect(
      growthSpokenSummary(
        parseAudienceGrowth({ ...wire, partial_metrics: [] }),
      ),
    ).toContain("18 unsubscribed.");
  });

  it("says there is nothing rather than reading zeros", () => {
    expect(growthSpokenSummary(parseAudienceGrowth({ series: [] }))).toBe(
      "Audience growth: no snapshots yet.",
    );
  });
});
