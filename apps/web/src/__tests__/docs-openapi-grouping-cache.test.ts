// SPDX-License-Identifier: AGPL-3.0-only
//
// SRV-02: the docs layout calls operationsByTag() on every render and
// /docs/api calls it a second time in the same request. listOperations()
// memoizes its flat list; the grouping did not, so ~1,900 operations were
// re-grouped and every tag group re-sorted on the critical path of every docs
// page render, producing a byte-identical result each time.

import { describe, expect, it } from "vitest";

import { listOperations, operationsByTag } from "@/lib/docs/loadOpenAPI";

describe("operationsByTag", () => {
  it("returns the identical grouping on repeat calls instead of rebuilding it", () => {
    const first = operationsByTag();
    const second = operationsByTag();

    // Guard the guard: an empty spec would satisfy identity trivially.
    expect(first.length).toBeGreaterThan(10);
    expect(first).toBe(second);
    expect(first[0]!.operations).toBe(second[0]!.operations);
  });

  it("still groups every operation under a sorted, uniquely-anchored tag", () => {
    const groups = operationsByTag();
    const total = groups.reduce((n, g) => n + g.operations.length, 0);

    expect(total).toBe(listOperations().length);
    expect(new Set(groups.map((g) => g.slug)).size).toBe(groups.length);
    expect(groups.map((g) => g.tag)).toEqual(
      [...groups.map((g) => g.tag)].sort((a, b) => a.localeCompare(b)),
    );
    for (const group of groups) {
      const paths = group.operations.map((op) => op.path);
      expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    }
  });
});
