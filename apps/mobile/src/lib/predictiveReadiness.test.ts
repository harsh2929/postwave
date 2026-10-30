import { describe, expect, it } from "vitest";

import {
  parseDataSufficiency,
  parseRfmSegments,
  rfmSegmentLabel,
  sufficiencyHeadline,
} from "./predictiveReadiness";

/** Shaped exactly like `DataSufficiencyReport` (predictive/repo.go:332). */
const SUFFICIENCY = {
  insufficient: { count: 400, percentage: 40 },
  limited: { count: 200, percentage: 20 },
  sufficient: { count: 400, percentage: 40 },
  total: 1000,
  last_updated: "2026-07-24T02:00:00Z",
};

/** Shaped exactly like `RFMSegments` (predictive/repo.go:440). */
const RFM = {
  items: [
    { segment_key: "hibernating", profiles: 500, avg_monetary_cents: 1200 },
    { segment_key: "champions", profiles: 300, avg_monetary_cents: 48000 },
    { segment_key: "a_brand_new_band", profiles: 200, avg_monetary_cents: 0 },
  ],
};

describe("data sufficiency", () => {
  it("reads a real rollup", () => {
    const report = parseDataSufficiency(SUFFICIENCY);
    expect(report?.total).toBe(1000);
    expect(report?.sufficient).toEqual({ count: 400, percentage: 40 });
    expect(report?.lastUpdated).toBe("2026-07-24T02:00:00Z");
  });

  // The load-bearing case. `GetDataSufficiency` (predictive/repo.go:360)
  // answers a never-recomputed tenant with a ZEROED report and HTTP 200, so a
  // naive renderer says "0% of profiles are ready" about a measurement that
  // was never taken.
  it("treats a zeroed report as no measurement, not as zero coverage", () => {
    expect(
      parseDataSufficiency({
        insufficient: { count: 0, percentage: 0 },
        limited: { count: 0, percentage: 0 },
        sufficient: { count: 0, percentage: 0 },
        total: 0,
      }),
    ).toBeNull();
    const copy = sufficiencyHeadline(null);
    expect(copy.headline).toBe("No prediction snapshot yet");
    expect(copy.tone).toBe("neutral");
    expect(copy.detail).toContain("not the same as reporting zero coverage");
  });

  it("returns null for a payload that is not a report at all", () => {
    expect(parseDataSufficiency(null)).toBeNull();
    expect(parseDataSufficiency("nope")).toBeNull();
    expect(parseDataSufficiency([])).toBeNull();
  });

  it("headlines on the confidently-scored band alone", () => {
    // `limited` is explicitly the band scored WITHOUT enough history; folding
    // it into the headline would inflate the claim from 40% to 60%.
    const high = sufficiencyHeadline(parseDataSufficiency(SUFFICIENCY));
    expect(high.headline).toBe("Only 40% of profiles are confidently scored");
    expect(high.tone).toBe("attention");
    expect(high.detail).toContain("400 of 1000");

    const ok = sufficiencyHeadline(
      parseDataSufficiency({
        ...SUFFICIENCY,
        sufficient: { count: 900, percentage: 90 },
      }),
    );
    expect(ok.headline).toBe("90% of profiles are confidently scored");
    expect(ok.tone).toBe("ok");
  });
});

describe("RFM segments", () => {
  it("preserves the server's descending order and computes each share", () => {
    const rows = parseRfmSegments(RFM);
    expect(rows.map((row) => row.key)).toEqual([
      "hibernating",
      "champions",
      "a_brand_new_band",
    ]);
    expect(rows[0]?.share).toBeCloseTo(0.5);
    expect(rows[1]?.share).toBeCloseTo(0.3);
  });

  it("renders a segment key this build has never seen", () => {
    expect(rfmSegmentLabel("champions")).toBe("Champions");
    expect(rfmSegmentLabel("insufficient_data")).toBe("Insufficient data");
    expect(rfmSegmentLabel("a_brand_new_band")).toBe("a brand new band");
    expect(parseRfmSegments(RFM)[2]?.label).toBe("a brand new band");
  });

  it("drops a row with no key or no count rather than rendering a phantom", () => {
    expect(
      parseRfmSegments({
        items: [
          { segment_key: "", profiles: 5 },
          { segment_key: "champions" },
          { segment_key: "loyal_customers", profiles: 2 },
        ],
      }).map((row) => row.key),
    ).toEqual(["loyal_customers"]);
  });

  it("is an empty list, never a throw, for a missing payload", () => {
    expect(parseRfmSegments(null)).toEqual([]);
    expect(parseRfmSegments({})).toEqual([]);
    expect(parseRfmSegments({ items: "nope" })).toEqual([]);
  });

  it("never divides by zero when nothing is scored", () => {
    const rows = parseRfmSegments({
      items: [{ segment_key: "champions", profiles: 0 }],
    });
    expect(rows[0]?.share).toBe(0);
  });
});
