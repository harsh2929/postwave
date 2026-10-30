import { describe, expect, it } from "vitest";

import {
  normalizeThreshold,
  thresholdOptions,
  thresholdPatch,
  thresholdSummary,
  USAGE_ALERT_PRESETS,
} from "./usageAlertThreshold";

describe("normalizeThreshold", () => {
  it("treats an ABSENT threshold as no alert, never as 0%", () => {
    // The Go field is `*int` with omitempty: unset means the key is missing.
    expect(normalizeThreshold(undefined)).toBeNull();
    expect(normalizeThreshold(null)).toBeNull();
  });

  it("treats an explicit 0 as no alert (the server's own 'clear' sentinel)", () => {
    expect(normalizeThreshold(0)).toBeNull();
  });

  it("keeps a configured percent", () => {
    expect(normalizeThreshold(80)).toBe(80);
    expect(normalizeThreshold(100)).toBe(100);
    expect(normalizeThreshold(1)).toBe(1);
  });

  it("refuses values outside the server's 1..100 contract", () => {
    expect(normalizeThreshold(-5)).toBeNull();
    expect(normalizeThreshold(101)).toBeNull();
    expect(normalizeThreshold(Number.NaN)).toBeNull();
    expect(normalizeThreshold(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("thresholdOptions", () => {
  it("offers the presets when the stored value is one of them", () => {
    expect(thresholdOptions(80).map((o) => o.value)).toEqual([
      ...USAGE_ALERT_PRESETS,
    ]);
    expect(thresholdOptions(null).map((o) => o.value)).toEqual([
      ...USAGE_ALERT_PRESETS,
    ]);
  });

  it("splices a value set elsewhere in, in order, so it stays visible", () => {
    // Somebody typed 83 into the web number input. The phone must not snap
    // it to 80 or show the control sitting on Off.
    expect(thresholdOptions(83).map((o) => o.value)).toEqual([
      0, 75, 80, 83, 90, 100,
    ]);
  });

  it("labels 0 as Off and speaks every option with its unit", () => {
    const options = thresholdOptions(90);
    expect(options[0]).toEqual({
      value: 0,
      label: "Off",
      accessibilityLabel: "No usage alert",
    });
    const ninety = options.find((o) => o.value === 90);
    expect(ninety?.label).toBe("90%");
    expect(ninety?.accessibilityLabel).toBe(
      "Alert at 90 percent of a plan limit",
    );
  });
});

describe("thresholdSummary", () => {
  it("says there is NO alert rather than naming a number when unset", () => {
    const text = thresholdSummary({ threshold: null, emailOnAlert: true });
    expect(text).toContain("No usage alert");
    expect(text).not.toContain("0%");
  });

  it("names the consequence and the email channel", () => {
    expect(
      thresholdSummary({ threshold: 90, emailOnAlert: true }),
    ).toContain("You also get an email.");
    expect(
      thresholdSummary({ threshold: 90, emailOnAlert: false }),
    ).toContain("email is off");
  });
});

describe("thresholdPatch", () => {
  it("sends an EXPLICIT 0 for Off — a missing key means 'leave as-is'", () => {
    expect(thresholdPatch(0)).toEqual({ usage_alert_threshold_pct: 0 });
    expect("usage_alert_threshold_pct" in thresholdPatch(0)).toBe(true);
  });

  it("clamps to the server's 0..100 range", () => {
    expect(thresholdPatch(140)).toEqual({ usage_alert_threshold_pct: 100 });
    expect(thresholdPatch(-3)).toEqual({ usage_alert_threshold_pct: 0 });
    expect(thresholdPatch(Number.NaN)).toEqual({
      usage_alert_threshold_pct: 0,
    });
  });
});
