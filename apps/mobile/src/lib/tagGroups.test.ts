import { describe, expect, it } from "vitest";

import { parseTagGroups, tagGroupName } from "./tagGroups";

describe("parseTagGroups", () => {
  it("reads the {items} envelope in sort/name order", () => {
    expect(
      parseTagGroups({
        items: [
          { id: "b", name: "Beta", sort_order: 2 },
          { id: "a", name: "Alpha", sort_order: 1 },
          { id: "c", name: "Aardvark", sort_order: 1 },
        ],
      }).map((g) => g.name),
    ).toEqual(["Aardvark", "Alpha", "Beta"]);
  });

  it("accepts a bare array", () => {
    expect(parseTagGroups([{ id: "a", name: "Alpha" }])).toEqual([
      { id: "a", name: "Alpha", sortOrder: 0 },
    ]);
  });

  it("drops rows that would render as an unlabelled chip", () => {
    expect(
      parseTagGroups({ items: [{ id: "", name: "x" }, { id: "y" }, 4, null] }),
    ).toEqual([]);
  });

  it("degrades to empty on junk", () => {
    expect(parseTagGroups(null)).toEqual([]);
    expect(parseTagGroups({ items: "nope" })).toEqual([]);
  });
});

describe("tagGroupName", () => {
  const groups = [{ id: "a", name: "Alpha", sortOrder: 0 }];
  it("resolves a selection", () => {
    expect(tagGroupName(groups, "a")).toBe("Alpha");
  });
  it("is empty for no selection or an unknown id", () => {
    expect(tagGroupName(groups, "")).toBe("");
    expect(tagGroupName(groups, "zzz")).toBe("");
  });
});
