// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { neighborsOf } from "@/lib/subscriber-nav-context";

describe("neighborsOf", () => {
  const order = ["a", "b", "c"];

  it("returns null prev at the start and null next at the end", () => {
    expect(neighborsOf(order, "a")).toEqual({
      prev: null,
      next: "b",
      index: 0,
      total: 3,
    });
    expect(neighborsOf(order, "c")).toEqual({
      prev: "b",
      next: null,
      index: 2,
      total: 3,
    });
  });

  it("returns both neighbors in the middle", () => {
    expect(neighborsOf(order, "b")).toEqual({
      prev: "a",
      next: "c",
      index: 1,
      total: 3,
    });
  });

  it("returns no neighbors when the id isn't in the order", () => {
    expect(neighborsOf(order, "z")).toEqual({
      prev: null,
      next: null,
      index: -1,
      total: 3,
    });
  });
});
