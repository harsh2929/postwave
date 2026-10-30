// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { Segment } from "@/lib/segments-api";
import {
  filterByFolder,
  FOLDER_ALL,
  FOLDER_UNFILED,
  filterSegments,
  paginate,
  pinnedFirst,
  sortSegments,
  totalPages,
} from "@/app/(dashboard)/app/subscribers/segments/segments-list-helpers";

function seg(partial: Partial<Segment> & { name: string }): Segment {
  return {
    id: partial.id ?? partial.name,
    tenantId: "t",
    name: partial.name,
    description: partial.description ?? "",
    queryAst: { op: "and", children: [] },
    lastCount: partial.lastCount ?? null,
    lastEvaluatedAt: partial.lastEvaluatedAt ?? null,
    folderId: partial.folderId ?? null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const data: Segment[] = [
  seg({ name: "VIPs", description: "top spenders", lastCount: 100, lastEvaluatedAt: "2026-07-01T00:00:00Z" }),
  seg({ name: "Engaged 30", description: "opened recently", lastCount: 5, lastEvaluatedAt: "2026-07-20T00:00:00Z" }),
  seg({ name: "Cold", description: "never opened", lastCount: null, lastEvaluatedAt: null }),
];

describe("filterByFolder (SEG-038)", () => {
  const folded: Segment[] = [
    seg({ name: "A", id: "a", folderId: "f1" }),
    seg({ name: "B", id: "b", folderId: "f2" }),
    seg({ name: "C", id: "c" }), // unfiled (no folderId)
    seg({ name: "D", id: "d", folderId: null }), // explicit null = unfiled
  ];

  it("passes everything through for 'all' / empty", () => {
    expect(filterByFolder(folded, FOLDER_ALL)).toHaveLength(4);
    expect(filterByFolder(folded, "")).toHaveLength(4);
  });

  it("keeps only unfiled segments for 'unfiled'", () => {
    expect(filterByFolder(folded, FOLDER_UNFILED).map((s) => s.id).sort()).toEqual([
      "c",
      "d",
    ]);
  });

  it("keeps only segments filed under a given folder id", () => {
    expect(filterByFolder(folded, "f1").map((s) => s.id)).toEqual(["a"]);
    expect(filterByFolder(folded, "f2").map((s) => s.id)).toEqual(["b"]);
    expect(filterByFolder(folded, "nope")).toHaveLength(0);
  });
});

describe("filterSegments", () => {
  it("matches name and description case-insensitively", () => {
    expect(filterSegments(data, "vip").map((s) => s.name)).toEqual(["VIPs"]);
    expect(filterSegments(data, "opened").map((s) => s.name).sort()).toEqual([
      "Cold",
      "Engaged 30",
    ]);
  });
  it("returns all on empty query", () => {
    expect(filterSegments(data, "  ").length).toBe(3);
  });
  it("returns none on no match", () => {
    expect(filterSegments(data, "zzz")).toEqual([]);
  });
});

describe("sortSegments", () => {
  it("sorts by name asc/desc", () => {
    expect(sortSegments(data, "name", "asc").map((s) => s.name)).toEqual([
      "Cold",
      "Engaged 30",
      "VIPs",
    ]);
    expect(sortSegments(data, "name", "desc").map((s) => s.name)).toEqual([
      "VIPs",
      "Engaged 30",
      "Cold",
    ]);
  });
  it("sorts by count with nulls always last", () => {
    expect(sortSegments(data, "count", "desc").map((s) => s.name)).toEqual([
      "VIPs",
      "Engaged 30",
      "Cold",
    ]);
    // asc: null STILL sinks to the bottom, not the top.
    expect(sortSegments(data, "count", "asc").map((s) => s.name)).toEqual([
      "Engaged 30",
      "VIPs",
      "Cold",
    ]);
  });
  it("sorts by evaluated recency with nulls last", () => {
    expect(sortSegments(data, "evaluated", "desc").map((s) => s.name)).toEqual([
      "Engaged 30",
      "VIPs",
      "Cold",
    ]);
  });
  it("does not mutate the input", () => {
    const copy = [...data];
    sortSegments(data, "count", "asc");
    expect(data).toEqual(copy);
  });
});

describe("pinnedFirst", () => {
  it("floats pinned segments to the top, preserving order within partitions", () => {
    const sorted = sortSegments(data, "name", "asc"); // Cold, Engaged 30, VIPs
    const pinned = new Set(["VIPs"]);
    expect(pinnedFirst(sorted, pinned).map((s) => s.name)).toEqual([
      "VIPs",
      "Cold",
      "Engaged 30",
    ]);
  });
  it("returns input unchanged when nothing is pinned", () => {
    const sorted = sortSegments(data, "name", "asc");
    expect(pinnedFirst(sorted, new Set())).toBe(sorted);
  });
});

describe("paginate + totalPages", () => {
  it("slices the current page", () => {
    expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2]);
    expect(paginate([1, 2, 3, 4, 5], 3, 2)).toEqual([5]);
  });
  it("computes total pages (min 1)", () => {
    expect(totalPages(0, 25)).toBe(1);
    expect(totalPages(26, 25)).toBe(2);
  });
});
