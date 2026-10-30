import { describe, expect, it } from "vitest";

import type { McpTrendPoint } from "@/lib/mcpActivity";
import { mcpTrendNotice, mcpTrendSeries } from "@/lib/mcpTrend";

function hourly(
  count: number,
  callsAt: Record<number, number> = {},
): McpTrendPoint[] {
  const out: McpTrendPoint[] = [];
  const start = Date.parse("2026-07-01T00:00:00Z");
  for (let i = 0; i < count; i += 1) {
    out.push({
      bucket: new Date(start + i * 3_600_000).toISOString(),
      calls: callsAt[i] ?? 0,
    });
  }
  return out;
}

describe("mcpTrendSeries", () => {
  it("keeps hourly granularity for a 24-hour window", () => {
    const series = mcpTrendSeries(hourly(24, { 3: 5 }), "24h");
    expect(series.granularity).toBe("hour");
    expect(series.values).toHaveLength(24);
    expect(series.total).toBe(5);
  });

  it("rolls a 30-day window up into UTC days by SUMMING, never sampling", () => {
    // A spike in a single hour must survive the roll-up: sampling every Nth
    // point is what would lose it, and that hour is the whole reason the
    // operator opened the screen.
    const series = mcpTrendSeries(hourly(720, { 100: 42 }), "30d");
    expect(series.granularity).toBe("day");
    expect(series.values).toHaveLength(30);
    expect(series.values.reduce((sum, v) => sum + v, 0)).toBe(42);
    expect(series.total).toBe(42);
    // Hour 100 is on 2026-07-05 UTC (96h = day 4 boundary).
    expect(series.buckets[4]).toBe("2026-07-05T00:00:00.000Z");
    expect(series.values[4]).toBe(42);
  });

  it("stays hourly for a 7-day window the server truncated below the ceiling", () => {
    const series = mcpTrendSeries(hourly(40), "7d");
    expect(series.granularity).toBe("hour");
    expect(series.values).toHaveLength(40);
  });

  it("rolls up a full 7-day window", () => {
    const series = mcpTrendSeries(hourly(168, { 0: 1, 167: 2 }), "7d");
    expect(series.granularity).toBe("day");
    expect(series.buckets).toHaveLength(7);
    expect(series.values[0]).toBe(1);
    expect(series.values[6]).toBe(2);
  });

  it("counts an unparseable bucket in the total but not on the axis", () => {
    const points = [
      ...hourly(100, { 1: 3 }),
      { bucket: "not-a-date", calls: 9 },
    ];
    const series = mcpTrendSeries(points, "7d");
    expect(series.total).toBe(12);
    expect(series.values.reduce((sum, v) => sum + v, 0)).toBe(3);
  });

  it("handles an empty payload without inventing a point", () => {
    const series = mcpTrendSeries([], "24h");
    expect(series.values).toEqual([]);
    expect(series.total).toBe(0);
  });
});

describe("mcpTrendNotice", () => {
  it("says nothing when the series is drawn exactly as the server sent it", () => {
    expect(mcpTrendNotice(mcpTrendSeries(hourly(24), "24h"))).toBeNull();
  });

  it("discloses the roll-up", () => {
    const notice = mcpTrendNotice(mcpTrendSeries(hourly(168), "7d"));
    expect(notice).toContain("summed into whole UTC days");
  });

  it("discloses calls that could not be placed on the axis", () => {
    const points = [...hourly(100), { bucket: "nope", calls: 4 }];
    const notice = mcpTrendNotice(mcpTrendSeries(points, "7d"));
    expect(notice).toContain("4 calls");
  });
});
