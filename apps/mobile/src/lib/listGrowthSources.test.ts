import { describe, expect, it } from "vitest";

import {
  growthSourceLabel,
  growthSourceNote,
  parseGrowthSources,
  GROWTH_SOURCE_KEYS,
} from "./listGrowthSources";

describe("vocabulary", () => {
  it("mirrors canonicalGrowthSources plus the server's 'other' bucket", () => {
    expect([...GROWTH_SOURCE_KEYS]).toEqual([
      "form",
      "api",
      "csv",
      "integration",
      "admin",
      "migration",
      "listmonk_event",
      "other",
    ]);
  });

  it("humanises the buckets and falls back to the raw key", () => {
    expect(growthSourceLabel("form")).toBe("Signup form");
    expect(growthSourceLabel("listmonk_event")).toBe("Engine event");
    expect(growthSourceLabel("brand_new")).toBe("brand_new");
  });
});

describe("parseGrowthSources", () => {
  it("orders by size and computes shares over the recorded total", () => {
    const mix = parseGrowthSources({
      sources: { form: 75, api: 25, csv: 0 },
    });
    expect(mix.total).toBe(100);
    expect(mix.slices.map((s) => s.key)).toEqual(["form", "api"]);
    expect(mix.slices[0]!.share).toBeCloseTo(0.75);
  });

  it("drops zero buckets rather than rendering empty slices", () => {
    const mix = parseGrowthSources({ sources: { form: 3, api: 0 } });
    expect(mix.slices).toHaveLength(1);
  });

  it("reports NOTHING RECORDED as null, never as zero", () => {
    const mix = parseGrowthSources({ sources: {} });
    expect(mix.total).toBeNull();
    expect(mix.slices).toEqual([]);
    expect(growthSourceNote(mix)).toMatch(/no acquisition sources/i);
  });

  it("survives a malformed payload without inventing data", () => {
    expect(parseGrowthSources(undefined).total).toBeNull();
    expect(parseGrowthSources({ sources: "nope" }).slices).toEqual([]);
    expect(parseGrowthSources({ sources: { form: "12" } }).total).toBeNull();
  });

  it("folds an unknown server bucket in rather than dropping it", () => {
    const mix = parseGrowthSources({ sources: { form: 1, quantum: 9 } });
    expect(mix.total).toBe(10);
    expect(mix.slices[0]!.key).toBe("quantum");
  });

  it("flags the live-count fallback as a DIFFERENT measurement", () => {
    const mix = parseGrowthSources({
      sources: { form: 4 },
      fallback: "live_count",
    });
    expect(mix.isLiveCount).toBe(true);
    expect(growthSourceNote(mix)).toMatch(/reflects who is on the list now/i);
  });

  it("has nothing to disclose for an ordinary recorded mix", () => {
    expect(
      growthSourceNote(parseGrowthSources({ sources: { form: 4 } })),
    ).toBe("");
  });
});
