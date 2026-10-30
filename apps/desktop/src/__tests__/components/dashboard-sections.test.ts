import { describe, expect, it } from "vitest";

import {
  DASHBOARD_SECTIONS,
  DEFAULT_SECTION_ORDER,
  STAT_CARD_KEYS,
  mergeLayoutOrder,
  moveKey,
  resolveSectionOrder,
  resolveStatOrder,
} from "../../components/dashboard/dashboard-sections";

describe("registries", () => {
  it("stat keys and section keys never collide (they share one saved list)", () => {
    const stats = new Set<string>(STAT_CARD_KEYS);
    for (const s of DASHBOARD_SECTIONS) {
      expect(stats.has(s.key)).toBe(false);
    }
  });
  it("combined key count stays inside the server's 1..16 bound", () => {
    expect(STAT_CARD_KEYS.length + DASHBOARD_SECTIONS.length).toBeLessThanOrEqual(
      16,
    );
  });
  it("every key satisfies the server's per-key rules (non-empty, ≤64)", () => {
    for (const k of [...STAT_CARD_KEYS, ...DEFAULT_SECTION_ORDER]) {
      expect(k.length).toBeGreaterThan(0);
      expect(k.length).toBeLessThanOrEqual(64);
    }
  });
});

describe("resolveSectionOrder", () => {
  it("null/empty saved layout → default order", () => {
    expect(resolveSectionOrder(null)).toEqual([...DEFAULT_SECTION_ORDER]);
    expect(resolveSectionOrder([])).toEqual([...DEFAULT_SECTION_ORDER]);
  });
  it("respects saved order and appends missing sections at the end", () => {
    const out = resolveSectionOrder(["goals", "forecast"]);
    expect(out.slice(0, 2)).toEqual(["goals", "forecast"]);
    expect(out).toHaveLength(DEFAULT_SECTION_ORDER.length);
    // Remaining sections keep default relative order.
    expect(out.slice(2)).toEqual(
      DEFAULT_SECTION_ORDER.filter((k) => k !== "goals" && k !== "forecast"),
    );
  });
  it("skips unknown keys (incl. stat keys from the shared list) and dedupes", () => {
    const out = resolveSectionOrder([
      "subs",
      "opens",
      "goals",
      "goals",
      "made-up-card",
      "parity",
    ]);
    expect(out.slice(0, 2)).toEqual(["goals", "parity"]);
    expect(out).toHaveLength(DEFAULT_SECTION_ORDER.length);
    expect(out).not.toContain("subs");
    expect(out).not.toContain("made-up-card");
  });
});

describe("resolveStatOrder", () => {
  it("filters the mixed list down to stat keys, appending defaults", () => {
    expect(resolveStatOrder(["bounces", "goals", "subs"])).toEqual([
      "bounces",
      "subs",
      "opens",
      "clicks",
    ]);
    expect(resolveStatOrder(null)).toEqual([...STAT_CARD_KEYS]);
  });
});

describe("moveKey", () => {
  it("swaps a key with its neighbour", () => {
    expect(moveKey(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveKey(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });
  it("returns null for edge / unknown moves so callers skip the save", () => {
    expect(moveKey(["a", "b"], "a", -1)).toBeNull();
    expect(moveKey(["a", "b"], "b", 1)).toBeNull();
    expect(moveKey(["a", "b"], "zz", 1)).toBeNull();
  });
  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    moveKey(input, "b", 1);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

describe("mergeLayoutOrder", () => {
  it("no saved layout + section reorder → defaults stats first, then sections", () => {
    const sections = [...DEFAULT_SECTION_ORDER].reverse();
    expect(mergeLayoutOrder(null, { sections })).toEqual([
      ...STAT_CARD_KEYS,
      ...sections,
    ]);
  });
  it("stat reorder preserves the saved SECTION order", () => {
    const saved = ["opens", "subs", "clicks", "bounces", "goals", "forecast"];
    const out = mergeLayoutOrder(saved, {
      stats: ["bounces", "opens", "subs", "clicks"],
    });
    expect(out.slice(0, 4)).toEqual(["bounces", "opens", "subs", "clicks"]);
    // Sections: saved ones first, missing appended in default order.
    expect(out.slice(4, 6)).toEqual(["goals", "forecast"]);
    expect(out).toHaveLength(
      STAT_CARD_KEYS.length + DEFAULT_SECTION_ORDER.length,
    );
  });
  it("section reorder preserves the saved STAT order", () => {
    const saved = ["opens", "subs", "clicks", "bounces"];
    const out = mergeLayoutOrder(saved, {
      sections: ["parity", ...DEFAULT_SECTION_ORDER.filter((k) => k !== "parity")],
    });
    expect(out.slice(0, 4)).toEqual(["opens", "subs", "clicks", "bounces"]);
    expect(out[4]).toBe("parity");
  });
  it("legacy stat-only saved layout (pre-sections build) upgrades cleanly", () => {
    const out = mergeLayoutOrder(["bounces", "subs", "opens", "clicks"], {
      sections: resolveSectionOrder(null),
    });
    expect(out).toEqual([
      "bounces",
      "subs",
      "opens",
      "clicks",
      ...DEFAULT_SECTION_ORDER,
    ]);
  });
  it("output always satisfies the server's 1..16 / ≤64-char rules", () => {
    const out = mergeLayoutOrder(null, {});
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(16);
    for (const k of out) expect(k.length).toBeLessThanOrEqual(64);
  });
});
