// Tests for the ClippingMeter contract. The meter renders a single
// progress bar, a verdict label, and a one-line copy explaining why
// (warn) or what will be hidden (critical). It is advisory only —
// it never disables Save / Publish.
//
// We test the pure helpers that drive colour + label selection and
// the contract that the meter renders only when HTML is loaded.

import { describe, expect, it } from "vitest";

import {
  GMAIL_CLIP_THRESHOLD_BYTES,
  measureEmailByteSize,
} from "../../lib/email-byte-size";

// Mirrors ClippingMeter.tsx::verdictColor() — we keep a local copy so
// the test doesn't reach into a component file (no JSX dependency
// from the test harness).
function verdictColor(v: "ok" | "warn" | "critical"): string {
  switch (v) {
    case "critical":
      return "var(--pw-danger)";
    case "warn":
      return "var(--pw-warning)";
    default:
      return "var(--pw-success)";
  }
}

// Mirrors ClippingMeter.tsx::verdictLabel().
function verdictLabel(v: "ok" | "warn" | "critical"): string {
  switch (v) {
    case "critical":
      return "Will be clipped in Gmail";
    case "warn":
      return "Approaching Gmail clip limit";
    default:
      return "Under Gmail clip limit";
  }
}

// Mirrors ClippingMeter.tsx visibility gate. The meter must not flash
// "0 B" while the slideover is still lazy-loading the preview HTML.
function shouldRender(html: string | null): boolean {
  return html !== null && html.length > 0;
}

describe("ClippingMeter — colour selection", () => {
  it("ok → green", () => {
    expect(verdictColor("ok")).toBe("var(--pw-success)");
  });
  it("warn → amber", () => {
    expect(verdictColor("warn")).toBe("var(--pw-warning)");
  });
  it("critical → red", () => {
    expect(verdictColor("critical")).toBe("var(--pw-danger)");
  });
});

describe("ClippingMeter — label copy", () => {
  it("ok label is reassuring", () => {
    expect(verdictLabel("ok")).toMatch(/under/i);
  });
  it("warn label calls out the threshold without alarmism", () => {
    expect(verdictLabel("warn")).toMatch(/approaching/i);
    expect(verdictLabel("warn")).toMatch(/Gmail/i);
  });
  it("critical label is action-oriented", () => {
    expect(verdictLabel("critical")).toMatch(/clipped/i);
  });
});

describe("ClippingMeter — visibility gating", () => {
  it("hides while preview is null (lazy-load in progress)", () => {
    expect(shouldRender(null)).toBe(false);
  });
  it("hides for an empty payload", () => {
    expect(shouldRender("")).toBe(false);
  });
  it("renders once HTML is loaded", () => {
    expect(shouldRender("<p>x</p>")).toBe(true);
  });
});

describe("ClippingMeter — verdict bucket integration", () => {
  it("typical newsletter (~20KB) is ok", () => {
    const m = measureEmailByteSize("x".repeat(20_000));
    expect(m.verdict).toBe("ok");
  });
  it("85% body trips warn", () => {
    const m = measureEmailByteSize(
      "x".repeat(Math.floor(GMAIL_CLIP_THRESHOLD_BYTES * 0.85)),
    );
    expect(m.verdict).toBe("warn");
  });
  it("over-threshold trips critical and reports overage", () => {
    const m = measureEmailByteSize(
      "x".repeat(GMAIL_CLIP_THRESHOLD_BYTES + 4096),
    );
    expect(m.verdict).toBe("critical");
    expect(m.remainingBytes).toBeLessThan(0);
  });
});

describe("ClippingMeter — fill-width cap", () => {
  // The bar caps at 110% so a 5x-over body doesn't render an
  // overflowing visual. The text already conveys magnitude.
  function fillPct(ratio: number): number {
    return Math.min(110, ratio * 100);
  }
  it("caps at 110 for very large bodies", () => {
    expect(fillPct(5)).toBe(110);
  });
  it("scales linearly under the cap", () => {
    expect(fillPct(0.5)).toBe(50);
    expect(fillPct(1)).toBe(100);
  });
});
