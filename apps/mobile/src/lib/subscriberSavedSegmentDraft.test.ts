/**
 * The save-this-view rules: what may be bookmarked, the exact predicate that
 * round-trips on desktop AND this phone, and the server text limits mirrored
 * client-side.
 */
import { describe, expect, it } from "vitest";

import { reduceSegmentToListView } from "./savedSegments";
import {
  buildSavedViewPredicate,
  deleteSegmentConfirmCopy,
  saveableViewProblem,
  savedSegmentTextProblem,
  savedViewSummary,
} from "./subscriberSavedSegmentDraft";

describe("saveableViewProblem", () => {
  it("accepts a narrowed view", () => {
    expect(
      saveableViewProblem({
        query: "acme",
        statusKey: "all",
        includeArchived: false,
      }),
    ).toBeNull();
    expect(
      saveableViewProblem({
        query: "",
        statusKey: "unsubscribed",
        includeArchived: false,
      }),
    ).toBeNull();
  });

  it("refuses the unfiltered directory and archived-widened views", () => {
    expect(
      saveableViewProblem({ query: " ", statusKey: "all", includeArchived: false }),
    ).toMatch(/Narrow the list/);
    expect(
      saveableViewProblem({
        query: "acme",
        statusKey: "all",
        includeArchived: true,
      }),
    ).toMatch(/archived/);
  });
});

describe("buildSavedViewPredicate", () => {
  it("writes the compatibility filters shape with the ENGINE status", () => {
    expect(
      buildSavedViewPredicate({
        query: " acme ",
        statusKey: "unsubscribed",
        includeArchived: false,
      }),
    ).toEqual({ filters: { status: "blocklisted", q: "acme" } });
  });

  it("never emits a predicate for a refused view", () => {
    expect(
      buildSavedViewPredicate({
        query: "acme",
        statusKey: "all",
        includeArchived: true,
      }),
    ).toBeNull();
  });

  it("round-trips through mobile's own reducer", () => {
    const predicate = buildSavedViewPredicate({
      query: "vip",
      statusKey: "subscribed",
      includeArchived: false,
    });
    const application = reduceSegmentToListView(predicate);
    expect(application).toEqual({
      applicable: true,
      q: "vip",
      statusKey: "subscribed",
    });
  });
});

describe("savedSegmentTextProblem", () => {
  it("mirrors the server's limits", () => {
    expect(savedSegmentTextProblem("Engaged EU", "notes")).toBeNull();
    expect(savedSegmentTextProblem("  ", "")).toMatch(/Name/);
    expect(savedSegmentTextProblem("x".repeat(121), "")).toMatch(/120/);
    expect(savedSegmentTextProblem("ok", "y".repeat(1001))).toMatch(/1,000/);
    expect(savedSegmentTextProblem("bad\u0007name", "")).toMatch(/control/);
    // \n is legal in a description (the server allows it there, not in names).
    expect(savedSegmentTextProblem("ok", "line\nline")).toBeNull();
  });
});

describe("copy", () => {
  it("summarises what the bookmark reproduces", () => {
    expect(
      savedViewSummary({
        query: "acme",
        statusKey: "unsubscribed",
        includeArchived: false,
      }),
    ).toBe("Saves the current view: search “acme” and status unsubscribed.");
  });

  it("says a workspace delete removes the shortcut for everyone", () => {
    const copy = deleteSegmentConfirmCopy({
      name: "Engaged EU",
      visibility: "workspace",
    });
    expect(copy.message).toMatch(/everyone/);
    expect(copy.message).toMatch(/No subscribers are affected/);
    const personal = deleteSegmentConfirmCopy({
      name: "Mine",
      visibility: "personal",
    });
    expect(personal.message).not.toMatch(/everyone/);
  });
});
