// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";

import { niceScale, buildLinePath, buildAreaPath } from "@/lib/chart-scale";

describe("niceScale", () => {
  it("produces a rounded domain covering the data", () => {
    const s = niceScale(3, 97, 4);
    expect(s.min).toBeLessThanOrEqual(3);
    expect(s.max).toBeGreaterThanOrEqual(97);
    expect(s.ticks[0]).toBe(s.min);
    expect(s.ticks[s.ticks.length - 1]).toBe(s.max);
  });

  it("returns ascending ticks with a positive step", () => {
    const s = niceScale(0, 1000, 5);
    for (let i = 1; i < s.ticks.length; i += 1) {
      expect(s.ticks[i]!).toBeGreaterThan(s.ticks[i - 1]!);
    }
    expect(s.max).toBeGreaterThan(s.min);
  });

  it("handles a flat series (min == max) without NaN/zero-span", () => {
    const s = niceScale(5, 5, 4);
    expect(Number.isFinite(s.min)).toBe(true);
    expect(Number.isFinite(s.max)).toBe(true);
    expect(s.max).toBeGreaterThan(s.min);
  });

  it("handles all-zero data", () => {
    const s = niceScale(0, 0, 4);
    expect(s.min).toBe(0);
    expect(s.max).toBeGreaterThan(0);
  });
});

describe("buildLinePath", () => {
  it("maps values into a width/height box, y-inverted", () => {
    const path = buildLinePath([0, 10], { width: 100, height: 50 });
    // First point at left edge; higher value => smaller y (top).
    expect(path.startsWith("M0")).toBe(true);
    expect(path).toContain("L100");
  });

  it("returns an empty string for <2 points", () => {
    expect(buildLinePath([], { width: 100, height: 50 })).toBe("");
    expect(buildLinePath([5], { width: 100, height: 50 })).toBe("");
  });

  it("keeps a flat series on a horizontal mid-line (no divide-by-zero)", () => {
    const path = buildLinePath([7, 7, 7], { width: 100, height: 40 });
    // All y equal; parse the y of the first coordinate.
    const ys = [...path.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeCloseTo(20, 0);
  });
});

describe("buildAreaPath", () => {
  it("closes the path down to the baseline", () => {
    const area = buildAreaPath([1, 2, 3], { width: 90, height: 30 });
    expect(area.startsWith("M0")).toBe(true);
    expect(area.trim().endsWith("Z")).toBe(true);
  });
  it("is empty for <2 points", () => {
    expect(buildAreaPath([1], { width: 90, height: 30 })).toBe("");
  });
});
