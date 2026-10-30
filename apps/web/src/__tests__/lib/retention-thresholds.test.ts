// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  formatChurnThreshold,
  formatOfferDiscount,
  scoredButInert,
  type WinbackSettings,
} from "@/lib/retention-offers-api";

function settings(over: Partial<WinbackSettings> = {}): WinbackSettings {
  return {
    enabled: false,
    churn_threshold: 0.7,
    churn_profiles_scored: 0,
    ...over,
  };
}

describe("churn threshold units", () => {
  it("renders the 0..1 wire value as a percentage", () => {
    // The trap: printing the wire value raw reads as 0.7% risk.
    expect(formatChurnThreshold(0.7)).toBe("70%");
    expect(formatChurnThreshold(0.5)).toBe("50%");
  });

  it("keeps a decimal only when it carries information", () => {
    expect(formatChurnThreshold(0.755)).toBe("75.5%");
    expect(formatChurnThreshold(0.75)).toBe("75%");
  });

  it("does not invent a number when the threshold is unusable", () => {
    expect(formatChurnThreshold(Number.NaN)).toBe("—");
    expect(formatChurnThreshold(0)).toBe("—");
  });
});

describe("retention offer amount units", () => {
  it("keeps integer percent_off values as percentages", () => {
    expect(formatOfferDiscount(1)).toBe("1% off");
    expect(formatOfferDiscount(25)).toBe("25% off");
  });

  it("formats fixed amounts from cents and names a missing amount", () => {
    expect(formatOfferDiscount(undefined, 1250)).toBe(
      "1,250 minor units off; currency unavailable",
    );
    expect(formatOfferDiscount()).toBe("Discount unavailable");
  });
});

describe("scored-but-inert detection", () => {
  it("is true when scores exist and the automation is off", () => {
    expect(
      scoredButInert(settings({ enabled: false, churn_profiles_scored: 12 })),
    ).toBe(true);
  });

  it("is false once the automation is on", () => {
    expect(
      scoredButInert(settings({ enabled: true, churn_profiles_scored: 12 })),
    ).toBe(false);
  });

  it("is false before anything has been scored", () => {
    // "Off and nothing scored" is an ordinary un-set-up state, not the
    // misleading one worth calling out.
    expect(
      scoredButInert(settings({ enabled: false, churn_profiles_scored: 0 })),
    ).toBe(false);
  });
});
