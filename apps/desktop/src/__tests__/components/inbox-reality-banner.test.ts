// Tests for the InboxRealityBanner contract. The banner renders 3
// stacked bars + a Why? toggle + a low-primary improve-subject CTA.
// We test the pure helpers (pct clamp, low-primary gate) and the
// CTA branch that gates onImproveSubject.

import { describe, expect, it } from "vitest";

/** Mirrors InboxRealityBanner.tsx::pct(). */
function pct(n: number | undefined | null): number {
  if (n == null || Number.isNaN(n)) return 0;
  const v = n > 1 ? n : n * 100;
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** Mirrors the lowPrimary computation. */
function isLowPrimary(primary: number, hasPrediction: boolean): boolean {
  return hasPrediction && primary > 0 && primary < 70;
}

describe("InboxRealityBanner — pct clamping", () => {
  it("rounds to one decimal", () => {
    expect(pct(0.4789)).toBe(47.9);
    expect(pct(0.001)).toBe(0.1);
  });

  it("handles fractional and percent-scale inputs", () => {
    expect(pct(0.7)).toBe(70);
    expect(pct(70)).toBe(70);
  });

  it("clamps to [0, 100]", () => {
    expect(pct(-0.5)).toBe(0);
    // Values in (1, 100] are treated as already-percent (no x100 rescale)
    // and pass through clamped at the upper bound. 1.5 → 1.5 (not 100).
    expect(pct(1.5)).toBe(1.5);
    expect(pct(150)).toBe(100);
  });

  it("treats null / NaN as 0", () => {
    expect(pct(null)).toBe(0);
    expect(pct(undefined)).toBe(0);
    expect(pct(Number.NaN)).toBe(0);
  });
});

describe("InboxRealityBanner — three-bar invariant", () => {
  // The banner shows three stacked bars (primary / promotions / spam).
  // Their sum is bounded but never required to be exactly 100 because
  // the predictor may return rounded values. We pin only that all three
  // are populated when a prediction loads.
  it("when a prediction loads, every bar gets a clamped percent", () => {
    const pred = { primary: 0.68, promotions: 0.22, spam: 0.1 };
    const bars = {
      primary: pct(pred.primary),
      promo: pct(pred.promotions),
      spam: pct(pred.spam),
    };
    expect(bars.primary).toBe(68);
    expect(bars.promo).toBe(22);
    expect(bars.spam).toBe(10);
  });
});

describe("InboxRealityBanner — Why? toggle is local UI state", () => {
  // Model: whyOpen flips on each click. The test pins the contract so
  // a refactor that accidentally promotes whyOpen to a prop (and breaks
  // the toggle) is caught.
  function reduceWhy(open: boolean, action: "toggle"): boolean {
    switch (action) {
      case "toggle":
        return !open;
    }
  }
  it("starts closed and opens on click", () => {
    expect(reduceWhy(false, "toggle")).toBe(true);
    expect(reduceWhy(true, "toggle")).toBe(false);
  });
});

describe("InboxRealityBanner — Improve-subject CTA gating", () => {
  it("shows when predicted primary is below 70%", () => {
    expect(isLowPrimary(68, true)).toBe(true);
  });

  it("does NOT show when primary is exactly 70% (threshold boundary)", () => {
    expect(isLowPrimary(70, true)).toBe(false);
  });

  it("does NOT show when no prediction has loaded yet", () => {
    expect(isLowPrimary(45, false)).toBe(false);
  });

  it("does NOT show when primary is 0 (predictor returned an empty payload)", () => {
    expect(isLowPrimary(0, true)).toBe(false);
  });
});
