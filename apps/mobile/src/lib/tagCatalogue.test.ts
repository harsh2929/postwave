import { describe, expect, it } from "vitest";

import {
  asTagSortMode,
  isTagArchived,
  normalizeTagCatalogue,
  resolveTagColor,
  sortTags,
  tagSpokenLabel,
  type TagCatalogueRow,
} from "./tagCatalogue";

describe("resolveTagColor", () => {
  it("resolves the server's named presets", () => {
    expect(resolveTagColor("teal")).toBe("#14b8a6");
    expect(resolveTagColor("  Amber ")).toBe("#f59e0b");
  });

  it("accepts a well-formed hex triple in either length", () => {
    expect(resolveTagColor("#ABC")).toBe("#abc");
    expect(resolveTagColor("#1a2b3c")).toBe("#1a2b3c");
  });

  it("refuses anything it cannot trust rather than styling with it", () => {
    // The column is free text server-side. A junk value spliced into a
    // style prop renders an invisible chip instead of falling back.
    for (const bad of [
      "",
      "   ",
      "not-a-colour",
      "#12",
      "#12345",
      "red; background: url(x)",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(resolveTagColor(bad)).toBeNull();
    }
  });
});

describe("isTagArchived", () => {
  it("treats only a non-blank archived_at as archived", () => {
    expect(isTagArchived({ id: "1", name: "a" })).toBe(false);
    expect(isTagArchived({ id: "1", name: "a", archived_at: "" })).toBe(false);
    expect(isTagArchived({ id: "1", name: "a", archived_at: "  " })).toBe(false);
    expect(
      isTagArchived({ id: "1", name: "a", archived_at: "2026-01-01T00:00:00Z" }),
    ).toBe(true);
  });
});

describe("tagSpokenLabel", () => {
  it("speaks the compliance and lifecycle facts, never the colour", () => {
    const spoken = tagSpokenLabel(
      {
        id: "1",
        name: "VIP",
        color: "#f43f5e",
        description: "High spenders",
        pii: true,
        archived_at: "2026-01-01T00:00:00Z",
      },
      "Jan 1, 2026",
    );
    expect(spoken).toContain("Tag VIP");
    expect(spoken).toContain("High spenders");
    expect(spoken).toContain("contains personal data");
    expect(spoken).toContain("archived");
    expect(spoken).toContain("created Jan 1, 2026");
    expect(spoken).not.toContain("#f43f5e");
  });

  it("omits what the row does not carry", () => {
    const spoken = tagSpokenLabel({ id: "1", name: "beta" }, "");
    expect(spoken).toContain("Tag beta");
    expect(spoken).not.toContain("personal data");
    expect(spoken).not.toContain("archived");
    expect(spoken).not.toContain("created");
  });
});

describe("sortTags", () => {
  const rows: TagCatalogueRow[] = [
    { id: "1", name: "beta", created_at: "2026-01-02T00:00:00Z" },
    { id: "2", name: "Alpha", created_at: "2026-03-02T00:00:00Z" },
    { id: "3", name: "gamma" },
  ];

  it("sorts A–Z case-insensitively", () => {
    expect(sortTags(rows, "name").map((r) => r.name)).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
  });

  it("sorts newest first and sinks undated rows", () => {
    expect(sortTags(rows, "newest").map((r) => r.name)).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
  });

  it("never mutates the cache array it was handed", () => {
    const original = [...rows];
    sortTags(rows, "name");
    expect(rows).toEqual(original);
  });
});

describe("asTagSortMode", () => {
  it("falls back for a preference written by an older build", () => {
    expect(asTagSortMode("newest")).toBe("newest");
    expect(asTagSortMode("name")).toBe("name");
    expect(asTagSortMode("usage")).toBe("name");
    expect(asTagSortMode("")).toBe("name");
  });
});

describe("normalizeTagCatalogue", () => {
  it("reads the {items} envelope the handler writes", () => {
    const rows = normalizeTagCatalogue({
      items: [
        {
          id: "t1",
          name: "VIP",
          color: "rose",
          description: " High spenders ",
          group_id: "g1",
          pii: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(rows).toEqual([
      {
        id: "t1",
        name: "VIP",
        color: "#f43f5e",
        description: "High spenders",
        group_id: "g1",
        pii: true,
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("accepts a bare array from an older gateway", () => {
    expect(normalizeTagCatalogue([{ id: "t1", name: "beta" }])).toHaveLength(1);
  });

  it("omits optional keys entirely rather than setting them undefined", () => {
    // exactOptionalPropertyTypes: `{color: undefined}` is not assignable.
    const [row] = normalizeTagCatalogue({ items: [{ id: "t1", name: "b" }] });
    expect(Object.keys(row!).sort()).toEqual(["id", "name"]);
  });

  it("drops junk without throwing", () => {
    expect(normalizeTagCatalogue({ items: [null, 4, "x", {}] })).toEqual([]);
    expect(normalizeTagCatalogue(undefined)).toEqual([]);
    expect(normalizeTagCatalogue({ nope: 1 })).toEqual([]);
  });

  it("does not trust an unknown colour string", () => {
    const [row] = normalizeTagCatalogue({
      items: [{ id: "t1", name: "b", color: "chartreuse" }],
    });
    expect(row?.color).toBeUndefined();
  });
});
