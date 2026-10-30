// Segment growth helpers (R11 full-surface wiring): SVG path
// projection over (possibly sparse) snapshot series, the
// delta/delta_pct copy — including the "<2 snapshots" honesty case
// the server zero-fills — and the caption.

import { describe, expect, it } from "vitest";

import type { SegmentGrowthPoint } from "../../lib/api-client";
import {
  buildGrowthPath,
  growthCaption,
  growthDeltaCopy,
} from "../../components/segments/segment-growth-helpers";

function pt(date: string, count: number): SegmentGrowthPoint {
  return { date, evaluated_at: `${date}T03:00:00Z`, count };
}

describe("buildGrowthPath", () => {
  it("empty series → no path, zeroed bounds", () => {
    const g = buildGrowthPath([]);
    expect(g.path).toBeNull();
    expect(g.points).toEqual([]);
    expect(g.maxCount).toBe(0);
  });

  it("a single snapshot can't make a line (no fake trend)", () => {
    const g = buildGrowthPath([pt("2026-06-01", 42)]);
    expect(g.path).toBeNull();
    expect(g.points).toHaveLength(1);
    expect(g.minCount).toBe(42);
    expect(g.maxCount).toBe(42);
  });

  it("projects min→bottom, max→top with vertical padding", () => {
    const g = buildGrowthPath(
      [pt("2026-06-01", 10), pt("2026-06-02", 20), pt("2026-06-03", 15)],
      300,
      100,
    );
    expect(g.path).toMatch(/^M0\.0,/);
    expect(g.minCount).toBe(10);
    expect(g.maxCount).toBe(20);
    const ys = g.points.map((p) => p.y);
    // count 10 (min) sits lowest, count 20 (max) highest.
    expect(ys[0]).toBeGreaterThan(ys[1]!);
    expect(ys[2]).toBeGreaterThan(ys[1]!);
    expect(ys[2]).toBeLessThan(ys[0]!);
    // 10% padding respected.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...ys)).toBeLessThanOrEqual(90);
    // Uniform x spacing across the width.
    expect(g.points.map((p) => p.x)).toEqual([0, 150, 300]);
  });

  it("a flat series doesn't divide by zero", () => {
    const g = buildGrowthPath([pt("2026-06-01", 5), pt("2026-06-02", 5)]);
    expect(g.path).not.toBeNull();
    expect(g.points.every((p) => Number.isFinite(p.y))).toBe(true);
  });
});

describe("growthDeltaCopy", () => {
  it("<2 snapshots is 'insufficient', not a misleading 'no change'", () => {
    const c = growthDeltaCopy([pt("2026-06-01", 5)], 0, 0);
    expect(c.insufficient).toBe(true);
    expect(c.label).toMatch(/not enough snapshots/i);
    expect(c.tone).toBe("flat");
  });

  it("formats up / down / flat with signed counts + pct", () => {
    const series = [pt("2026-06-01", 100), pt("2026-06-08", 112)];
    expect(growthDeltaCopy(series, 12, 12)).toEqual({
      label: "+12 (+12.0%)",
      tone: "up",
      insufficient: false,
    });
    expect(growthDeltaCopy(series, -3, -2.68)).toEqual({
      label: "−3 (−2.7%)",
      tone: "down",
      insufficient: false,
    });
    expect(growthDeltaCopy(series, 0, 0)).toEqual({
      label: "no change",
      tone: "flat",
      insufficient: false,
    });
  });
});

describe("growthCaption", () => {
  it("covers empty and populated windows", () => {
    expect(growthCaption([], 90)).toBe("No snapshots in the last 90 days.");
    expect(growthCaption([pt("2026-06-01", 1)], 30)).toBe(
      "1 snapshot over the last 30 days",
    );
    expect(
      growthCaption([pt("2026-06-01", 1), pt("2026-06-02", 2)], 30),
    ).toBe("2 snapshots over the last 30 days");
  });
});
