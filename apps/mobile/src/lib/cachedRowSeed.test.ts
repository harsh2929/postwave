import { describe, expect, it } from "vitest";

import { cachedRows, cachedString, findCachedRow } from "./cachedRowSeed";

describe("findCachedRow", () => {
  it("reads a bare array (the segments cache shape)", () => {
    const entries = [[{ id: "a", name: "VIPs" }, { id: "b", name: "Churned" }]];
    expect(findCachedRow(entries, "b")?.name).toBe("Churned");
  });

  it("reads an infinite-query cache (pages → items)", () => {
    const entries = [
      {
        pages: [
          { items: [{ id: "1", email: "one@example.com" }] },
          { items: [{ id: "2", email: "two@example.com" }] },
        ],
      },
    ];
    expect(cachedString(findCachedRow(entries, "2"), "email")).toBe(
      "two@example.com",
    );
  });

  it("reads a snapshot-backed entry (value → pages → items)", () => {
    const entries = [
      { value: { pages: [{ items: [{ id: "7", email: "x@example.com" }] }] } },
    ];
    expect(cachedString(findCachedRow(entries, "7"), "email")).toBe(
      "x@example.com",
    );
  });

  it("searches across several cache entries (one per filter/sort variant)", () => {
    const entries = [
      { pages: [{ items: [{ id: "1" }] }] },
      { pages: [{ items: [{ id: "9", email: "found@example.com" }] }] },
    ];
    expect(cachedString(findCachedRow(entries, "9"), "email")).toBe(
      "found@example.com",
    );
  });

  it("matches EXACTLY — a prefix must never put another person in the header", () => {
    const entries = [[{ id: "abc", email: "a@example.com" }]];
    expect(findCachedRow(entries, "ab")).toBeNull();
    expect(findCachedRow(entries, "abcd")).toBeNull();
  });

  it("returns null for a missing id, an empty id and an unreadable shape", () => {
    expect(findCachedRow([[{ id: "a" }]], "z")).toBeNull();
    expect(findCachedRow([[{ id: "a" }]], "")).toBeNull();
    expect(findCachedRow([[{ id: "a" }]], undefined)).toBeNull();
    expect(findCachedRow([undefined, null, 42, "str"], "a")).toBeNull();
  });

  it("supports a non-id key (suppressions are addressed by email)", () => {
    const entries = [{ items: [{ email: "b@example.com", reason: "bounce" }] }];
    expect(
      cachedString(findCachedRow(entries, "b@example.com", "email"), "reason"),
    ).toBe("bounce");
  });

  it("does not walk unrelated nested objects into row candidates", () => {
    // `meta.owner` has an id too; matching it would render the wrong entity.
    const entries = [{ meta: { owner: { id: "a", name: "Wrong" } }, items: [] }];
    expect(findCachedRow(entries, "a")).toBeNull();
  });

  it("terminates on a self-referential cache entry", () => {
    const loop: Record<string, unknown> = { items: [] };
    loop.value = loop;
    expect(() => cachedRows([loop])).not.toThrow();
    expect(cachedRows([loop])).toEqual([]);
  });
});

describe("cachedString", () => {
  it("rejects blanks and non-strings so a header never shows an empty pill", () => {
    expect(cachedString({ email: "  " }, "email")).toBeUndefined();
    expect(cachedString({ email: 12 }, "email")).toBeUndefined();
    expect(cachedString(null, "email")).toBeUndefined();
    expect(cachedString({ email: " a@b.co " }, "email")).toBe("a@b.co");
  });
});
