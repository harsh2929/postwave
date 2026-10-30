// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  LABEL_VALUE_BUCKETS,
  parseLabelImport,
  summarizeLabelCoverage,
} from "@/lib/voice-labels-helpers";
import type { VoiceLabel } from "@/lib/voice-labels-api";

function label(patch: Partial<VoiceLabel> = {}): VoiceLabel {
  return {
    id: "l1",
    tenant_id: "t1",
    sample_text: "Sample",
    axis: "humor",
    value: 0.5,
    created_at: "2026-01-01T00:00:00Z",
    ...patch,
  };
}

describe("summarizeLabelCoverage", () => {
  it("counts per axis and distributes into value buckets", () => {
    const summary = summarizeLabelCoverage([
      label({ axis: "humor", value: 0.1 }),
      label({ axis: "humor", value: 0.95 }),
      label({ axis: "warmth", value: 0.5 }),
    ]);
    expect(summary.total).toBe(3);
    const humor = summary.perAxis.find((a) => a.axis === "humor")!;
    expect(humor.count).toBe(2);
    expect(humor.buckets[0]).toBe(1); // 0.1 → first bucket
    expect(humor.buckets[LABEL_VALUE_BUCKETS.length - 1]).toBe(1); // 0.95 → last
    const warmth = summary.perAxis.find((a) => a.axis === "warmth")!;
    expect(warmth.count).toBe(1);
    expect(warmth.buckets[2]).toBe(1); // 0.5 → middle bucket
    const optimism = summary.perAxis.find((a) => a.axis === "optimism")!;
    expect(optimism.count).toBe(0); // gap surfaced
  });

  it("always returns all five axes even when empty", () => {
    const summary = summarizeLabelCoverage([]);
    expect(summary.perAxis).toHaveLength(5);
    expect(summary.total).toBe(0);
  });
});

describe("parseLabelImport", () => {
  it("parses a valid array and rounds values", () => {
    const result = parseLabelImport(
      JSON.stringify([
        { sample_text: "Hi there", axis: "humor", value: 0.756, notes: "witty" },
        { sample_text: "Formal note", axis: "formality", value: 1 },
      ]),
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toEqual([
      { sample_text: "Hi there", axis: "humor", value: 0.76, notes: "witty" },
      { sample_text: "Formal note", axis: "formality", value: 1 },
    ]);
  });

  it("accepts the export { items: [...] } wrapper", () => {
    const result = parseLabelImport(
      JSON.stringify({ items: [{ sample_text: "x", axis: "warmth", value: 0.2 }] }),
    );
    expect(result.valid).toHaveLength(1);
  });

  it("reports per-row errors without dropping them silently", () => {
    const result = parseLabelImport(
      JSON.stringify([
        { sample_text: "", axis: "humor", value: 0.5 },
        { sample_text: "ok", axis: "bogus", value: 0.5 },
        { sample_text: "ok", axis: "humor", value: 5 },
        { sample_text: "good", axis: "humor", value: 0.5 },
      ]),
    );
    expect(result.valid).toHaveLength(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("Row 1");
    expect(result.errors[1]).toContain("axis");
    expect(result.errors[2]).toContain("between 0 and 1");
  });

  it("rejects non-JSON and non-arrays", () => {
    expect(parseLabelImport("{bad").errors[0]).toContain("not valid JSON");
    expect(parseLabelImport(JSON.stringify({ foo: 1 })).errors[0]).toContain(
      "Expected a JSON array",
    );
  });
});
