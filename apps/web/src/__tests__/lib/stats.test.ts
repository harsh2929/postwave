// SPDX-License-Identifier: AGPL-3.0-only
//
// lib/stats — the two-proportion z-test behind the campaign compare card's
// "Best · 95%" badges (port of desktop lib/stats.ts). Expectations are
// computed by hand from the textbook formula, not by calling the code.

import { describe, expect, it } from "vitest";

import {
  confidenceLabel,
  formatPValue,
  normalCdf,
  ztest,
} from "@/lib/stats";

describe("normalCdf", () => {
  it("matches the standard normal table", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normalCdf(2.576)).toBeCloseTo(0.995, 3);
    expect(normalCdf(9)).toBe(1);
    expect(normalCdf(-9)).toBe(0);
  });
});

describe("ztest (pooled, two-sided)", () => {
  it("20% vs 15% over 1,000 recipients each is significant at 99%", () => {
    // p̂ = 0.175; SE = sqrt(0.175·0.825·(2/1000)) = 0.0169926; z = 0.05/SE.
    const result = ztest(0.2, 1000, 0.15, 1000);
    expect(result.degenerate).toBe(false);
    expect(result.z).toBeCloseTo(2.9424, 3);
    expect(result.p).toBeCloseTo(0.00326, 4);
    expect(confidenceLabel(result, 1000, 1000)).toBe("99");
  });

  it("the sign follows the direction of the difference", () => {
    expect(ztest(0.15, 1000, 0.2, 1000).z).toBeCloseTo(-2.9424, 3);
  });

  it("a 95%-but-not-99% lead is labelled 95", () => {
    // p̂ = 0.11; SE = sqrt(0.11·0.89·(2/1000)) = 0.013993; z = 0.03/SE = 2.1440.
    const result = ztest(0.125, 1000, 0.095, 1000);
    expect(result.z).toBeCloseTo(2.144, 2);
    expect(result.p).toBeGreaterThan(0.01);
    expect(result.p).toBeLessThan(0.05);
    expect(confidenceLabel(result, 1000, 1000)).toBe("95");
  });

  it("a small lead on a modest sample is not significant", () => {
    const result = ztest(0.2, 200, 0.17, 200);
    expect(result.p).toBeGreaterThan(0.05);
    expect(confidenceLabel(result, 200, 200)).toBe("ns");
  });

  it("refuses to call a winner under 100 recipients on either side, whatever p says", () => {
    const result = ztest(0.9, 99, 0.1, 5000);
    expect(result.p).toBeLessThan(0.01);
    expect(confidenceLabel(result, 99, 5000)).toBe("low_sample");
  });

  it("degenerate inputs never produce NaN", () => {
    for (const result of [
      ztest(0.2, 0, 0.1, 100),
      ztest(Number.NaN, 100, 0.1, 100),
      ztest(0, 500, 0, 500), // zero standard error
    ]) {
      expect(result).toEqual({ z: 0, p: 1, degenerate: true });
    }
    expect(confidenceLabel(ztest(0, 500, 0, 500), 500, 500)).toBe("ns");
  });

  it("clamps rates that drift outside [0, 1]", () => {
    expect(ztest(1.2, 1000, 0.5, 1000).z).toBeCloseTo(
      ztest(1, 1000, 0.5, 1000).z,
      9,
    );
  });
});

describe("formatPValue", () => {
  it("collapses tiny values and keeps two or three decimals", () => {
    expect(formatPValue(0.0004)).toBe("< 0.001");
    expect(formatPValue(0.0032)).toBe("0.003");
    expect(formatPValue(0.4412)).toBe("0.44");
    expect(formatPValue(Number.NaN)).toBe("—");
  });
});
