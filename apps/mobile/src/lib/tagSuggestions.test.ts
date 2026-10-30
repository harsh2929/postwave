import { describe, expect, it } from "vitest";

import {
  filterTagSuggestions,
  parseTagSuggestions,
  tagSuggestionLabel,
  taxonomyCaseVariant,
} from "./tagSuggestions";

describe("parseTagSuggestions", () => {
  it("reads the handler's {items} envelope", () => {
    expect(
      parseTagSuggestions({
        q: "vi",
        items: [
          { tag: "vip", subscribers: 1204, registered: true },
          { tag: "video", subscribers: 3, registered: true },
        ],
      }),
    ).toEqual([
      { tag: "vip", subscribers: 1204 },
      { tag: "video", subscribers: 3 },
    ]);
  });

  it("accepts a bare array in case the envelope ever changes", () => {
    expect(parseTagSuggestions([{ tag: "vip", subscribers: 2 }])).toEqual([
      { tag: "vip", subscribers: 2 },
    ]);
  });

  it("degrades to empty instead of throwing on junk", () => {
    expect(parseTagSuggestions(null)).toEqual([]);
    expect(parseTagSuggestions(undefined)).toEqual([]);
    expect(parseTagSuggestions("nope")).toEqual([]);
    expect(parseTagSuggestions({ items: "nope" })).toEqual([]);
    expect(parseTagSuggestions({ items: [null, 4, { tag: "  " }] })).toEqual([]);
  });

  it("defaults a missing/NaN count to zero rather than dropping the tag", () => {
    expect(
      parseTagSuggestions({ items: [{ tag: "fresh" }, { tag: "odd", subscribers: Number.NaN }] }),
    ).toEqual([
      { tag: "fresh", subscribers: 0 },
      { tag: "odd", subscribers: 0 },
    ]);
  });
});

describe("filterTagSuggestions", () => {
  const items = [
    { tag: "vip", subscribers: 900 },
    { tag: "video", subscribers: 40 },
    { tag: "vinyl", subscribers: 2 },
  ];

  it("preserves the server's most-used-first ranking", () => {
    expect(filterTagSuggestions(items, []).map((s) => s.tag)).toEqual([
      "vip",
      "video",
      "vinyl",
    ]);
  });

  it("drops tags already on this subscriber, case-insensitively", () => {
    expect(filterTagSuggestions(items, ["VIP", " vinyl "]).map((s) => s.tag)).toEqual([
      "video",
    ]);
  });

  it("keeps an exact case-insensitive match so tapping adopts taxonomy casing", () => {
    // The user typed "VIP"; the taxonomy says "vip". Offering it is the
    // whole point — tapping prevents the fork.
    expect(filterTagSuggestions(items, undefined).map((s) => s.tag)).toContain(
      "vip",
    );
  });

  it("de-duplicates an already-forked taxonomy", () => {
    expect(
      filterTagSuggestions(
        [
          { tag: "VIP", subscribers: 900 },
          { tag: "vip", subscribers: 4 },
        ],
        [],
      ),
    ).toEqual([{ tag: "VIP", subscribers: 900 }]);
  });

  it("caps the row", () => {
    expect(filterTagSuggestions(items, [], 2)).toHaveLength(2);
    expect(filterTagSuggestions(items, [], 0)).toEqual([]);
  });

  it("is empty for missing input", () => {
    expect(filterTagSuggestions(undefined, ["a"])).toEqual([]);
    expect(filterTagSuggestions([], ["a"])).toEqual([]);
  });
});

describe("tagSuggestionLabel", () => {
  it("speaks the exact count beside the compacted badge", () => {
    expect(tagSuggestionLabel({ tag: "vip", subscribers: 1204 })).toBe(
      "Add tag vip, used by 1,204 subscribers",
    );
  });

  it("singularises one", () => {
    expect(tagSuggestionLabel({ tag: "vip", subscribers: 1 })).toBe(
      "Add tag vip, used by 1 subscriber",
    );
  });

  it("says 'not used yet' rather than 'used by 0'", () => {
    expect(tagSuggestionLabel({ tag: "new", subscribers: 0 })).toBe(
      "Add tag new, not used yet",
    );
  });
});

describe("taxonomyCaseVariant", () => {
  const items = [{ tag: "vip", subscribers: 9 }];

  it("flags a case-only fork", () => {
    expect(taxonomyCaseVariant("VIP", items)).toBe("vip");
    expect(taxonomyCaseVariant("  Vip ", items)).toBe("vip");
  });

  it("stays silent on an exact match", () => {
    expect(taxonomyCaseVariant("vip", items)).toBeNull();
  });

  it("stays silent on a genuinely new tag", () => {
    expect(taxonomyCaseVariant("vips", items)).toBeNull();
    expect(taxonomyCaseVariant("", items)).toBeNull();
    expect(taxonomyCaseVariant("vip", undefined)).toBeNull();
  });
});
