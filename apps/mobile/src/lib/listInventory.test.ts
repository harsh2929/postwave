import { describe, expect, it } from "vitest";

import {
  computeListsInventory,
  listsCountLabel,
  listsCoverageNote,
  readListCatalogueTotal,
  subscriberSumLabel,
  subscriberSumSpoken,
} from "./listInventory";

describe("readListCatalogueTotal", () => {
  it("reads Listmonk's nested envelope total", () => {
    expect(
      readListCatalogueTotal({ data: { results: [], total: 143, per_page: 20 } }),
    ).toBe(143);
  });

  it("reads a flattened top-level total", () => {
    expect(readListCatalogueTotal({ items: [], total: 7 })).toBe(7);
  });

  it("is null for every shape that does not carry one", () => {
    expect(readListCatalogueTotal([{ id: 1 }])).toBeNull();
    expect(readListCatalogueTotal(null)).toBeNull();
    expect(readListCatalogueTotal(undefined)).toBeNull();
    expect(readListCatalogueTotal({ data: [{ id: 1 }] })).toBeNull();
    expect(readListCatalogueTotal({ data: { results: [] } })).toBeNull();
  });

  it("rejects non-counts rather than coercing them", () => {
    expect(readListCatalogueTotal({ total: "143" })).toBeNull();
    expect(readListCatalogueTotal({ total: Number.NaN })).toBeNull();
    expect(readListCatalogueTotal({ total: -3 })).toBeNull();
    expect(readListCatalogueTotal({ total: 12.7 })).toBe(12);
  });
});

describe("computeListsInventory", () => {
  const rows = [
    { type: "public", optin: "double", count: 100 },
    { type: "private", optin: "single", count: 20 },
    { count: 5 }, // defaults: private / single
  ];

  it("sums counts and classifies type/optin with the documented defaults", () => {
    const inv = computeListsInventory(rows);
    expect(inv.loaded).toBe(3);
    expect(inv.subscribers).toBe(125);
    expect(inv.publicLists).toBe(1);
    expect(inv.doubleOptin).toBe(1);
  });

  it("ignores non-finite counts instead of producing NaN", () => {
    const inv = computeListsInventory([
      { count: 10 },
      { count: Number.NaN },
      {},
    ]);
    expect(inv.subscribers).toBe(10);
  });

  it("is `unknown` when the gateway echoed no total", () => {
    expect(computeListsInventory(rows).coverage).toBe("unknown");
    expect(computeListsInventory(rows).serverTotal).toBeNull();
  });

  it("is `partial` when the server holds more than we loaded", () => {
    expect(computeListsInventory(rows, 143).coverage).toBe("partial");
  });

  it("is `complete` only when every row is in hand", () => {
    expect(computeListsInventory(rows, 3).coverage).toBe("complete");
    // A total BELOW what we hold still counts as complete: we are not missing
    // rows, and claiming "partial" there would be a second kind of lie.
    expect(computeListsInventory(rows, 1).coverage).toBe("complete");
  });
});

describe("the honesty invariant", () => {
  const rows = [{ count: 100 }, { count: 20 }];

  it("NEVER labels a truncated sum as a workspace fact", () => {
    for (const total of [null, 143]) {
      const inv = computeListsInventory(rows, total);
      expect(subscriberSumLabel(inv)).toBe("On loaded lists");
      expect(listsCountLabel(inv)).toBe("Lists loaded");
      expect(listsCoverageNote(inv)).not.toBeNull();
    }
  });

  it("uses the plain noun only when coverage is proven", () => {
    const inv = computeListsInventory(rows, 2);
    expect(subscriberSumLabel(inv)).toBe("Subscribers");
    expect(listsCountLabel(inv)).toBe("Lists");
    expect(listsCoverageNote(inv)).toBeNull();
  });

  it("carries the caveat in the spoken value, not only in a footnote", () => {
    const partial = computeListsInventory(rows, 143);
    expect(subscriberSumSpoken(partial, "120 subscribers")).toBe(
      "120 subscribers across the 2 lists loaded",
    );
    const complete = computeListsInventory(rows, 2);
    expect(subscriberSumSpoken(complete, "120 subscribers")).toBe(
      "120 subscribers",
    );
  });

  it("names the real numbers in the partial note", () => {
    expect(listsCoverageNote(computeListsInventory(rows, 143))).toBe(
      "Counts cover the 2 of 143 lists this screen has loaded.",
    );
  });

  it("admits ignorance rather than implying completeness", () => {
    expect(listsCoverageNote(computeListsInventory(rows))).toContain(
      "does not report a workspace total",
    );
  });

  it("says nothing at all when there are no rows to qualify", () => {
    expect(listsCoverageNote(computeListsInventory([]))).toBeNull();
  });
});
