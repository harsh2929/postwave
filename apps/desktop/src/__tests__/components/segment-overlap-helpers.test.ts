// Segment overlap geometry (R11 full-surface wiring): exact lens-area
// math, the bisection distance solver, the proportional two-circle
// layout (area ∝ count, lens ∝ intersection), jaccard formatting and
// the honest summary line.

import { describe, expect, it } from "vitest";

import {
  fmtJaccard,
  lensArea,
  overlapLayout,
  overlapSummary,
  solveDistance,
} from "../../components/segments/overlap-helpers";

describe("lensArea", () => {
  it("is zero for disjoint circles", () => {
    expect(lensArea(1, 1, 2)).toBe(0);
    expect(lensArea(1, 1, 5)).toBe(0);
  });

  it("equals the smaller circle's area under containment", () => {
    expect(lensArea(3, 1, 0.5)).toBeCloseTo(Math.PI, 10);
  });

  it("equal circles at zero distance share their full area", () => {
    expect(lensArea(2, 2, 0)).toBeCloseTo(Math.PI * 4, 10);
  });

  it("known half-overlap case is monotonic in d", () => {
    const wide = lensArea(1, 1, 1.5);
    const close = lensArea(1, 1, 0.5);
    expect(close).toBeGreaterThan(wide);
    expect(wide).toBeGreaterThan(0);
  });
});

describe("solveDistance", () => {
  it("round-trips: lensArea(solveDistance(target)) ≈ target", () => {
    const r1 = 2;
    const r2 = 1.5;
    const max = lensArea(r1, r2, Math.abs(r1 - r2));
    for (const frac of [0.1, 0.5, 0.9]) {
      const target = max * frac;
      const d = solveDistance(r1, r2, target);
      expect(lensArea(r1, r2, d)).toBeCloseTo(target, 6);
    }
  });

  it("clamps: zero target → tangent+, full target → containment distance", () => {
    expect(solveDistance(1, 1, 0)).toBe(2);
    expect(solveDistance(2, 1, Math.PI * 100)).toBe(1);
  });
});

describe("overlapLayout", () => {
  it("scales radii so AREA is proportional to member count", () => {
    const l = overlapLayout(400, 100, 0, 320, 160);
    // area ratio 4:1 → radius ratio 2:1.
    expect(l.a.r / l.b.r).toBeCloseTo(2, 6);
    expect(l.degenerate).toBe(false);
  });

  it("disjoint segments leave a visible gap between circles", () => {
    const l = overlapLayout(100, 100, 0, 320, 160);
    const d = Math.hypot(l.b.cx - l.a.cx, l.b.cy - l.a.cy);
    expect(d).toBeGreaterThan(l.a.r + l.b.r);
  });

  it("overlapping segments intersect; full containment nests them", () => {
    const half = overlapLayout(100, 100, 50, 320, 160);
    const dHalf = half.b.cx - half.a.cx;
    expect(dHalf).toBeLessThan(half.a.r + half.b.r);
    expect(dHalf).toBeGreaterThan(0);

    const nested = overlapLayout(1000, 100, 100, 320, 160);
    const dNest = nested.b.cx - nested.a.cx;
    expect(dNest).toBeLessThanOrEqual(nested.a.r - nested.b.r + 1e-6);
  });

  it("clamps an impossible intersection to min(a, b)", () => {
    // Server should never send this, but we must not NaN the SVG.
    const l = overlapLayout(100, 50, 500, 320, 160);
    expect(Number.isFinite(l.a.cx)).toBe(true);
    expect(Number.isFinite(l.b.cx)).toBe(true);
  });

  it("stays inside the viewport", () => {
    const l = overlapLayout(100000, 3, 1, 320, 160);
    expect(l.a.cx - l.a.r).toBeGreaterThanOrEqual(0);
    expect(l.b.cx + l.b.r).toBeLessThanOrEqual(320);
    expect(l.a.cy - l.a.r).toBeGreaterThanOrEqual(0);
    expect(l.a.cy + l.a.r).toBeLessThanOrEqual(160);
  });

  it("flags empty sets as degenerate instead of drawing a misleading dot", () => {
    expect(overlapLayout(0, 50, 0).degenerate).toBe(true);
    expect(overlapLayout(0, 0, 0).degenerate).toBe(true);
  });
});

describe("fmtJaccard", () => {
  it("formats with one decimal, stripping a trailing .0", () => {
    expect(fmtJaccard(0.375)).toBe("37.5%");
    expect(fmtJaccard(0.5)).toBe("50%");
    expect(fmtJaccard(0)).toBe("0%");
    expect(fmtJaccard(1)).toBe("100%");
  });

  it("clamps junk", () => {
    expect(fmtJaccard(Number.NaN)).toBe("—");
    expect(fmtJaccard(2)).toBe("100%");
  });
});

describe("overlapSummary", () => {
  it("covers empty / disjoint / overlapping states honestly", () => {
    expect(overlapSummary(0, 0, 0)).toMatch(/both segments are empty/i);
    expect(overlapSummary(10, 5, 0)).toMatch(/no subscribers in common/i);
    expect(overlapSummary(10, 5, 1)).toBe("1 subscriber in both segments.");
    expect(overlapSummary(10, 5, 3)).toBe("3 subscribers in both segments.");
  });
});
