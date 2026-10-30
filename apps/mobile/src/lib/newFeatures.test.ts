import { describe, expect, it } from "vitest";

import {
  NEW_FEATURES,
  NEW_FEATURE_DAYS_VISIBLE,
  activeNewFeatureKeys,
  isFeatureNew,
  newFeatureLabel,
  type NewFeatureEntry,
} from "@/lib/newFeatures";

const DAY_MS = 24 * 60 * 60 * 1000;

const registry: readonly NewFeatureEntry[] = [
  { key: "fresh", label: "Fresh thing", shippedAt: "2026-08-01" },
  { key: "stale", label: "Old thing", shippedAt: "2026-05-01" },
  { key: "typo", label: "Broken date", shippedAt: "not a date" },
];

const shipped = Date.parse("2026-08-01");

describe("isFeatureNew", () => {
  it("badges a fresh entry", () => {
    expect(isFeatureNew("fresh", shipped + DAY_MS, registry)).toBe(true);
  });

  it("expires after exactly the visibility window (inclusive)", () => {
    const edge = shipped + NEW_FEATURE_DAYS_VISIBLE * DAY_MS;
    expect(isFeatureNew("fresh", edge, registry)).toBe(true);
    expect(isFeatureNew("fresh", edge + DAY_MS, registry)).toBe(false);
  });

  it("a future ship date is a typo, not a badge", () => {
    expect(isFeatureNew("fresh", shipped - 1, registry)).toBe(false);
  });

  it("an unparseable date reads as not-new, never new-forever", () => {
    expect(isFeatureNew("typo", shipped, registry)).toBe(false);
  });

  it("an unknown key is not new", () => {
    expect(isFeatureNew("nope", shipped, registry)).toBe(false);
  });
});

describe("activeNewFeatureKeys", () => {
  it("returns only in-window keys, in registry order", () => {
    expect(activeNewFeatureKeys(Date.parse("2026-08-15"), registry)).toEqual([
      "fresh",
    ]);
  });
});

describe("newFeatureLabel", () => {
  it("returns the registry label, empty for unknown keys", () => {
    expect(newFeatureLabel("fresh", registry)).toBe("Fresh thing");
    expect(newFeatureLabel("nope", registry)).toBe("");
  });
});

describe("the real registry", () => {
  it("carries parseable dates, non-empty labels, unique keys", () => {
    for (const item of NEW_FEATURES) {
      expect(Number.isFinite(Date.parse(item.shippedAt))).toBe(true);
      expect(item.key.trim()).not.toBe("");
      expect(item.label.trim()).not.toBe("");
    }
    expect(new Set(NEW_FEATURES.map((item) => item.key)).size).toBe(
      NEW_FEATURES.length,
    );
  });
});
