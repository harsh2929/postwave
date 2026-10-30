import { describe, expect, it } from "vitest";

import {
  parseSavedSegments,
  reduceSegmentToListView,
  savedSegmentLabel,
  type SavedSegmentRow,
} from "./savedSegments";

describe("parseSavedSegments", () => {
  it("reads the {items} envelope and pins first, then name order", () => {
    const rows = parseSavedSegments({
      total_items: 3,
      max_items: 200,
      items: [
        { id: "2", name: "Zeta", last_count: 4 },
        { id: "1", name: "Alpha", last_count: null },
        { id: "3", name: "Pinned", is_pinned: true },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(["Pinned", "Alpha", "Zeta"]);
  });

  it("keeps 'never evaluated' distinct from zero", () => {
    const [row] = parseSavedSegments({ items: [{ id: "1", name: "A" }] });
    expect(row?.lastCount).toBeNull();
    const [zero] = parseSavedSegments({
      items: [{ id: "1", name: "A", last_count: 0 }],
    });
    expect(zero?.lastCount).toBe(0);
  });

  it("drops rows with no id or no name", () => {
    expect(
      parseSavedSegments({ items: [{ id: "", name: "x" }, { id: "1" }, null] }),
    ).toEqual([]);
  });

  it("degrades to empty on junk", () => {
    expect(parseSavedSegments(null)).toEqual([]);
    expect(parseSavedSegments({ items: "nope" })).toEqual([]);
  });
});

describe("reduceSegmentToListView", () => {
  it("reduces the legacy flat {status, q} blob", () => {
    expect(reduceSegmentToListView({ status: "enabled", q: "acme" })).toEqual({
      applicable: true,
      q: "acme",
      statusKey: "subscribed",
    });
  });

  it("reduces the structured {filters} snapshot", () => {
    expect(
      reduceSegmentToListView({ filters: { q: "acme", status: "blocklisted" } }),
    ).toEqual({ applicable: true, q: "acme", statusKey: "unsubscribed" });
  });

  it("prefers the snapshot's applied_query as the authoritative term", () => {
    const out = reduceSegmentToListView({
      filters: { q: "stale", status: "subscribed" },
      snapshot: { applied_query: "fresh" },
    });
    expect(out).toEqual({ applicable: true, q: "fresh", statusKey: "subscribed" });
  });

  it("refuses a compiled AST rather than approximating it", () => {
    const out = reduceSegmentToListView({ ast: { op: "and", nodes: [] } });
    expect(out.applicable).toBe(false);
    expect(out.applicable === false && out.reason).toContain("rule tree");
  });

  it.each(["tags", "engagement", "custom_fields", "date_range"] as const)(
    "refuses a segment that filters by %s",
    (key) => {
      const filters =
        key === "tags"
          ? { q: "x", tags: ["vip"] }
          : { q: "x", [key]: { any: 1 } };
      const out = reduceSegmentToListView({ filters });
      expect(out.applicable).toBe(false);
    },
  );

  it("treats an EMPTY tags array as no tag filter", () => {
    expect(
      reduceSegmentToListView({ filters: { q: "acme", tags: [] } }),
    ).toEqual({ applicable: true, q: "acme", statusKey: "all" });
  });

  it("refuses an archive-scoped segment rather than silently narrowing it", () => {
    const out = reduceSegmentToListView({
      filters: { q: "acme" },
      snapshot: { include_archived: true },
    });
    expect(out.applicable).toBe(false);
    expect(out.applicable === false && out.reason).toContain("archived");
  });

  it("refuses a status with no mobile chip", () => {
    const out = reduceSegmentToListView({ filters: { status: "transactional" } });
    expect(out.applicable).toBe(false);
    expect(out.applicable === false && out.reason).toContain("transactional");
  });

  it("refuses an empty predicate — applying it would be a no-op named as a segment", () => {
    expect(reduceSegmentToListView({}).applicable).toBe(false);
    expect(reduceSegmentToListView({ filters: {} }).applicable).toBe(false);
    expect(reduceSegmentToListView(null).applicable).toBe(false);
  });

  it("accepts a status-only segment", () => {
    expect(reduceSegmentToListView({ status: "unconfirmed" })).toEqual({
      applicable: true,
      q: "",
      statusKey: "unconfirmed",
    });
  });
});

describe("savedSegmentLabel", () => {
  const row: SavedSegmentRow = {
    id: "1",
    name: "Engaged EU",
    description: "",
    visibility: "workspace",
    isPinned: false,
    lastCount: 1204,
    lastEvaluatedAt: null,
    predicate: null,
  };

  it("speaks the exact size beside a compacted chip", () => {
    expect(
      savedSegmentLabel(row, { applicable: true, q: "eu", statusKey: "all" }),
    ).toBe("Apply segment Engaged EU, 1,204 members");
  });

  it("says an unevaluated segment has no size rather than reading zero", () => {
    expect(
      savedSegmentLabel({ ...row, lastCount: null }, {
        applicable: true,
        q: "eu",
        statusKey: "all",
      }),
    ).toBe("Apply segment Engaged EU, size not evaluated yet");
  });

  it("announces why an inapplicable segment cannot be tapped", () => {
    expect(
      savedSegmentLabel(row, { applicable: false, reason: "Nope." }),
    ).toBe("Engaged EU, 1,204 members. Not available on mobile. Nope.");
  });
});
