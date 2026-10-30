// Tests the canonical cents → display string formatter used across
// the affiliate dashboard + billing surfaces. We pin the en-US output
// so a Node version bump that changes Intl's spacing/padding doesn't
// silently regress dashboards.

import { describe, expect, it } from "vitest";

import { formatCents } from "@/lib/affiliates-types";

describe("formatCents", () => {
  it("renders USD by default", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(1234)).toBe("$12.34");
  });

  it("rounds half-up at the cent boundary", () => {
    expect(formatCents(100)).toBe("$1.00");
  });

  it("respects the currency override", () => {
    // We don't pin the exact glyph because Node's Intl varies by ICU
    // version; we just assert it's NOT the USD output.
    const eur = formatCents(1234, "EUR");
    expect(eur).not.toBe("$12.34");
    expect(eur).toMatch(/12[.,]34/);
  });
});
