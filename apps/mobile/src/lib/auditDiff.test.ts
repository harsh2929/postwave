import { describe, expect, it } from "vitest";

import {
  auditMetadataSummary,
  buildAuditMetadataView,
  formatAuditValue,
  pickAuditPair,
} from "./auditDiff";

describe("formatAuditValue", () => {
  it("renders null/undefined as an em dash and empty strings visibly", () => {
    expect(formatAuditValue(null)).toBe("—");
    expect(formatAuditValue(undefined)).toBe("—");
    expect(formatAuditValue("")).toBe('""');
    expect(formatAuditValue(0)).toBe("0");
    expect(formatAuditValue(false)).toBe("false");
  });

  it("survives a value JSON.stringify cannot serialise", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatAuditValue(cyclic)).not.toThrow();
  });
});

describe("pickAuditPair", () => {
  it("accepts all three emitter spellings", () => {
    expect(pickAuditPair({ before: { a: 1 }, after: { a: 2 } })).not.toBeNull();
    expect(pickAuditPair({ old: { a: 1 }, new: { a: 2 } })).not.toBeNull();
    expect(
      pickAuditPair({ previous: { a: 1 }, current: { a: 2 } }),
    ).not.toBeNull();
  });

  it("rejects a half pair or a non-object pair", () => {
    expect(pickAuditPair({ before: { a: 1 } })).toBeNull();
    expect(pickAuditPair({ before: "x", after: "y" })).toBeNull();
    expect(pickAuditPair({ before: [1], after: [2] })).toBeNull();
  });
});

describe("buildAuditMetadataView", () => {
  it("returns an empty view for missing metadata", () => {
    const view = buildAuditMetadataView(null);
    expect(view.diff).toEqual([]);
    expect(view.entries).toEqual([]);
    expect(auditMetadataSummary(view)).toBeNull();
  });

  it("diffs nested leaves by dot path, not whole objects", () => {
    const view = buildAuditMetadataView({
      before: { settings: { notify: { email: true, sms: false } } },
      after: { settings: { notify: { email: false, sms: false } } },
    });
    expect(view.hasPair).toBe(true);
    expect(view.diff).toEqual([
      {
        kind: "changed",
        key: "settings.notify.email",
        before: "true",
        after: "false",
      },
    ]);
    expect(auditMetadataSummary(view)).toBe("1 field changed");
  });

  it("classifies added and removed leaves", () => {
    const view = buildAuditMetadataView({
      before: { a: 1, gone: "x" },
      after: { a: 1, fresh: "y" },
    });
    expect(view.diff).toEqual([
      { kind: "added", key: "fresh", after: "y" },
      { kind: "removed", key: "gone", before: "x" },
    ]);
  });

  it("indexes array elements so a single element change is pinpointed", () => {
    const view = buildAuditMetadataView({
      before: { tags: ["a", "b"] },
      after: { tags: ["a", "c"] },
    });
    expect(view.diff).toEqual([
      { kind: "changed", key: "tags[1]", before: "b", after: "c" },
    ]);
  });

  it("treats empty objects and arrays as leaves rather than vanishing", () => {
    const view = buildAuditMetadataView({
      before: { list: [], obj: {} },
      after: { list: ["x"], obj: { k: 1 } },
    });
    const keys = view.diff.map((r) => r.key).sort();
    expect(keys).toEqual(["list", "list[0]", "obj", "obj.k"]);
  });

  it("does not recurse without bound on a self-referential blob", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() =>
      buildAuditMetadataView({ before: cyclic, after: cyclic }),
    ).not.toThrow();
  });

  it("caps the diff and reports how many leaves it hid", () => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (let i = 0; i < 90; i += 1) {
      before[`k${String(i).padStart(3, "0")}`] = i;
      after[`k${String(i).padStart(3, "0")}`] = i + 1;
    }
    const view = buildAuditMetadataView({ before, after });
    expect(view.diff).toHaveLength(60);
    expect(view.truncatedRows).toBe(30);
    expect(auditMetadataSummary(view)).toBe("90 fields changed");
  });

  it("falls back to a flattened raw readout with no pair", () => {
    const view = buildAuditMetadataView({
      campaign_id: "c1",
      nested: { count: 3 },
    });
    expect(view.hasPair).toBe(false);
    expect(view.entries).toEqual([
      { key: "campaign_id", value: "c1" },
      { key: "nested.count", value: "3" },
    ]);
    expect(auditMetadataSummary(view)).toBe("2 details");
  });

  it("drops unchanged leaves so the answer is only what moved", () => {
    const view = buildAuditMetadataView({
      before: { a: 1, b: 2, c: 3 },
      after: { a: 1, b: 2, c: 4 },
    });
    expect(view.diff).toHaveLength(1);
    expect(view.diff[0]?.key).toBe("c");
  });

  it("reports a no-op change as nothing to open", () => {
    const view = buildAuditMetadataView({ before: { a: 1 }, after: { a: 1 } });
    expect(view.hasPair).toBe(true);
    expect(auditMetadataSummary(view)).toBeNull();
  });
});
