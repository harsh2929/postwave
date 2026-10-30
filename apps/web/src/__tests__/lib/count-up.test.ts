// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";

import { easeOutCubic, interpolateCount } from "@/components/delight/count-up";

describe("easeOutCubic", () => {
  it("anchors the endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
  it("clamps out-of-range progress", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
  it("is ahead of linear in the first half (ease-out)", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("interpolateCount", () => {
  it("returns the endpoints exactly", () => {
    expect(interpolateCount(0, 100, 0)).toBe(0);
    expect(interpolateCount(0, 100, 1)).toBe(100);
  });
  it("rounds to an integer mid-tween", () => {
    const v = interpolateCount(0, 100, 0.5);
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(50); // ease-out overshoots the midpoint
    expect(v).toBeLessThan(100);
  });
  it("counts down when to < from", () => {
    expect(interpolateCount(100, 0, 1)).toBe(0);
    expect(interpolateCount(100, 0, 0)).toBe(100);
  });
});
