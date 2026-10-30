import { describe, expect, it } from "vitest";

import { parseSegmentGrowthReport } from "../../components/segments/segment-growth-report-contract";

const report = {
  segment_id: "segment-1",
  days: 30,
  series: [],
  anomalies: [],
  total_adds: 0,
  total_drops: 0,
  net_delta: 0,
  net_pct: 0,
  note: "No snapshots yet",
};

describe("segment growth report runtime contract", () => {
  it("accepts a complete empty report", () => {
    expect(parseSegmentGrowthReport(report)).toEqual(report);
  });

  it("rejects malformed arrays and non-finite totals", () => {
    expect(parseSegmentGrowthReport({})).toBeNull();
    expect(parseSegmentGrowthReport({ ...report, anomalies: undefined })).toBeNull();
    expect(parseSegmentGrowthReport({ ...report, net_delta: Infinity })).toBeNull();
  });
});
