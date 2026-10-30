// decay-helpers (feature #5, Segment Decay Radar) — pure-logic tests:
// anomaly labelling, cliff-percent divide-by-zero guard, attribution-bar
// normalisation (incl. all-zero), definition-diff summary, and the
// honest bounded-leaver cap copy.

import { describe, expect, it } from "vitest";

import {
  anomalyKindLabel,
  anomalyKindTone,
  attributionBars,
  attributionLowConfidence,
  boundedLeaverNote,
  cliffPercent,
  deltaLabel,
  definitionDiffSummary,
} from "../lib/decay-helpers";

describe("anomalyKindLabel", () => {
  it("labels all four kinds with non-empty strings", () => {
    for (const k of [
      "size_cliff",
      "zero_match",
      "everyone_match",
      "definition_changed",
    ]) {
      expect(anomalyKindLabel(k).length).toBeGreaterThan(0);
    }
  });
  it("humanises unknown kinds", () => {
    expect(anomalyKindLabel("weird_kind")).toBe("Weird kind");
    expect(anomalyKindLabel("")).toBe("Anomaly");
  });
});

describe("anomalyKindTone", () => {
  it("flags severe collapses as warn, others info", () => {
    expect(anomalyKindTone("zero_match")).toBe("warn");
    expect(anomalyKindTone("size_cliff")).toBe("warn");
    expect(anomalyKindTone("everyone_match")).toBe("info");
    expect(anomalyKindTone("definition_changed")).toBe("info");
  });
});

describe("cliffPercent", () => {
  it("computes the drop magnitude", () => {
    expect(cliffPercent(1000, 600)).toBe(40);
  });
  it("guards prior=0 (no NaN/Infinity)", () => {
    expect(cliffPercent(0, 100)).toBe(0);
    expect(Number.isFinite(cliffPercent(0, 100))).toBe(true);
  });
  it("returns 0 for growth/stable", () => {
    expect(cliffPercent(100, 100)).toBe(0);
    expect(cliffPercent(100, 200)).toBe(0);
  });
  it("rounds to one decimal", () => {
    expect(cliffPercent(3, 2)).toBe(33.3);
  });
});

describe("deltaLabel", () => {
  it("signs decreases with pct", () => {
    expect(deltaLabel(1000, 400)).toBe("−600 (−60.0%)");
  });
  it("handles growth and no-change", () => {
    expect(deltaLabel(100, 105)).toBe("+5");
    expect(deltaLabel(100, 100)).toBe("no change");
  });
  it("handles prior=0 without pct", () => {
    expect(deltaLabel(0, 50)).toBe("+50");
  });
});

describe("attributionBars", () => {
  it("normalises counts to percentages, highest first", () => {
    const bars = attributionBars({ 0: 100, 1: 200 });
    expect(bars).toEqual([
      { clauseIndex: 1, count: 200, pct: 67 },
      { clauseIndex: 0, count: 100, pct: 33 },
    ]);
  });
  it("handles all-zero without divide-by-zero", () => {
    const bars = attributionBars({ 0: 0, 1: 0 });
    expect(bars.every((b) => b.pct === 0)).toBe(true);
    expect(bars).toHaveLength(2);
  });
  it("returns [] for empty/nullish input", () => {
    expect(attributionBars(undefined)).toEqual([]);
    expect(attributionBars(null)).toEqual([]);
    expect(attributionBars({})).toEqual([]);
  });
});

describe("attributionLowConfidence", () => {
  it("flags small samples", () => {
    expect(attributionLowConfidence(5)).toBe(true);
    expect(attributionLowConfidence(10)).toBe(false);
    expect(attributionLowConfidence(0)).toBe(true);
  });
});

describe("definitionDiffSummary", () => {
  it("reports created/deleted", () => {
    expect(definitionDiffSummary(null, { name: "x" })).toBe(
      "Segment definition created.",
    );
    expect(definitionDiffSummary({ name: "x" }, null)).toBe("Segment deleted.");
  });
  it("reports rename + predicate change", () => {
    const s = definitionDiffSummary(
      { name: "Active 30d", queryAst: { op: "and", children: [] } },
      { name: "Active 60d", queryAst: { op: "or", children: [] } },
    );
    expect(s).toContain("renamed");
    expect(s).toContain("predicate changed");
  });
  it("returns a non-empty string for no field-level diff", () => {
    const s = definitionDiffSummary({ name: "x" }, { name: "x" });
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("boundedLeaverNote", () => {
  it("warns the full set may be larger when capped", () => {
    const note = boundedLeaverNote(50, 1000, true);
    expect(note).toContain("may be larger");
  });
  it("plain count when not capped", () => {
    const note = boundedLeaverNote(50, 312, false);
    expect(note).toContain("50");
    expect(note).toContain("312");
    expect(note).not.toContain("may be larger");
  });
  it("handles zero logged", () => {
    expect(boundedLeaverNote(0, 0, false)).toContain("No leavers");
  });
});
