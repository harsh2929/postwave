// Win-back settings helpers (roadmap R13): percent ↔ fraction
// conversion at the UI edge mirrors the server's (0, 1] validation,
// and the data-gap explainer only renders when churn_profiles_scored
// is actually 0. Stored state never becomes a runtime-delivery claim.

import { describe, expect, it } from "vitest";

import {
  parsePercentInput,
  thresholdToPercentInput,
  winbackDataGapCopy,
  winbackStatusCopy,
} from "../../components/retention/winback-helpers";

describe("thresholdToPercentInput", () => {
  it("renders the stored fraction as whole percent", () => {
    expect(thresholdToPercentInput(0.7)).toBe("70");
    expect(thresholdToPercentInput(1)).toBe("100");
    expect(thresholdToPercentInput(0.05)).toBe("5");
  });

  it("avoids float artifacts on awkward fractions", () => {
    expect(thresholdToPercentInput(0.07)).toBe("7");
    expect(thresholdToPercentInput(0.355)).toBe("35.5");
  });

  it("returns empty for out-of-range values", () => {
    expect(thresholdToPercentInput(0)).toBe("");
    expect(thresholdToPercentInput(1.5)).toBe("");
    expect(thresholdToPercentInput(Number.NaN)).toBe("");
  });
});

describe("parsePercentInput", () => {
  it("accepts 1–100 and converts to a fraction", () => {
    expect(parsePercentInput("70")).toEqual({ ok: true, threshold: 0.7 });
    expect(parsePercentInput("100")).toEqual({ ok: true, threshold: 1 });
    expect(parsePercentInput(" 5 ")).toEqual({ ok: true, threshold: 0.05 });
  });

  it("rounds the fraction to avoid float noise on the wire", () => {
    const r = parsePercentInput("33.33");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.threshold).toBe(0.3333);
  });

  it("rejects empty, non-numeric, and out-of-range input", () => {
    expect(parsePercentInput("").ok).toBe(false);
    expect(parsePercentInput("abc").ok).toBe(false);
    expect(parsePercentInput("0").ok).toBe(false);
    expect(parsePercentInput("-5").ok).toBe(false);
    expect(parsePercentInput("101").ok).toBe(false);
  });
});

describe("winbackDataGapCopy", () => {
  it("returns the explainer only when nothing is scored", () => {
    const copy = winbackDataGapCopy(0);
    expect(copy).not.toBeNull();
    expect(copy).toContain("scoring coverage only");
    expect(copy).toContain("ASSURE-F15-WINBACK-DISPATCH-UNWIRED");
    expect(winbackDataGapCopy(12)).toBeNull();
  });
});

describe("winbackStatusCopy", () => {
  it("reports only stored state and scoring coverage", () => {
    expect(winbackStatusCopy(false, 0)).toContain("Stored switch disabled");
    expect(winbackStatusCopy(true, 0)).toContain("no churn-risk profiles");
    expect(winbackStatusCopy(true, 1)).toContain(
      "1 subscriber profile recorded as scored",
    );
    expect(winbackStatusCopy(true, 2500)).toContain(
      "2,500 subscriber profiles",
    );
    expect(winbackStatusCopy(true, 2500)).toContain(
      "ASSURE-F15-WINBACK-DISPATCH-UNWIRED",
    );
  });

  it("treats a missing scored count as absent coverage (no .toLocaleString crash)", () => {
    // The wrapper may omit churn_profiles_scored on a populated GET —
    // `undefined <= 0` is false, so without coercion this reached
    // .toLocaleString() on undefined and crashed the card.
    expect(winbackStatusCopy(true, undefined as unknown as number)).toContain(
      "no churn-risk profiles",
    );
    expect(winbackStatusCopy(true, Number.NaN)).toContain(
      "no churn-risk profiles",
    );
  });
});
