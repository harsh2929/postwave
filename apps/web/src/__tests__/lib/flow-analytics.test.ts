// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  formatPercent,
  formatRevenueCents,
  hasFlowMetrics,
  readFlowMetrics,
  readNodeDropOff,
} from "@/lib/flow-analytics";

describe("readFlowMetrics", () => {
  it("returns an empty object for missing analytics", () => {
    expect(readFlowMetrics(undefined)).toEqual({});
    expect(hasFlowMetrics(readFlowMetrics(null))).toBe(false);
  });

  it("normalizes common key spellings and computes conversion rate", () => {
    const m = readFlowMetrics({
      total_entered: 100,
      in_progress: 20,
      completed: 70,
      conversions: 25,
      revenue_cents: 500000,
    });
    expect(m.entered).toBe(100);
    expect(m.active).toBe(20);
    expect(m.completed).toBe(70);
    expect(m.converted).toBe(25);
    expect(m.conversionRate).toBeCloseTo(0.25);
    expect(m.revenueCents).toBe(500000);
  });

  it("prefers an explicit conversion_rate when present", () => {
    const m = readFlowMetrics({ entered: 10, converted: 2, conversion_rate: 0.5 });
    expect(m.conversionRate).toBe(0.5);
  });

  it("coerces numeric strings", () => {
    const m = readFlowMetrics({ entered: "40", converted: "10" });
    expect(m.entered).toBe(40);
    expect(m.conversionRate).toBeCloseTo(0.25);
  });
});

describe("readNodeDropOff", () => {
  it("reads a per-node stats sub-map and computes drop-off rate", () => {
    const map = readNodeDropOff({
      node_stats: { n1: { entered: 100, dropped: 40 } },
    });
    expect(map.get("n1")?.rate).toBeCloseTo(0.4);
  });
  it("is empty when no sub-map exists", () => {
    expect(readNodeDropOff({ entered: 5 }).size).toBe(0);
  });
});

describe("formatters", () => {
  it("formats percent and revenue", () => {
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(0.05)).toBe("5.0%");
    expect(formatRevenueCents(500000)).toContain("5,000");
  });
});
