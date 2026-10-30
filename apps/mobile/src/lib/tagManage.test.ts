/**
 * tagManage — the cosmetic-patch pointer semantics (only touched keys
 * travel; an empty patch is refused locally), the group bodies, and the
 * history feed's sentences.
 */
import { describe, expect, it } from "vitest";

import {
  buildGroupCreateBody,
  buildGroupRenameBody,
  buildTagPatch,
  parseTagHistory,
  tagHistoryLine,
} from "./tagManage";

describe("buildTagPatch — pointer semantics", () => {
  it("sends only the touched keys", () => {
    expect(
      buildTagPatch({ color: "teal", description: "", groupId: undefined }),
    ).toEqual({ color: "teal" });
    expect(
      buildTagPatch({ color: "", description: " VIP customers ", groupId: undefined }),
    ).toEqual({ description: "VIP customers" });
    // groupId "" is the explicit CLEAR — it must travel.
    expect(
      buildTagPatch({ color: "", description: "", groupId: "" }),
    ).toEqual({ group_id: "" });
  });

  it("refuses an empty patch (the server 400s it) with null", () => {
    expect(
      buildTagPatch({ color: "", description: "  ", groupId: undefined }),
    ).toBeNull();
  });
});

describe("group bodies", () => {
  it("create requires a name; rename is a single pointer", () => {
    expect(buildGroupCreateBody("  ")).toBeNull();
    expect(buildGroupCreateBody(" Lifecycle ")).toEqual({
      name: "Lifecycle",
      color: "",
      sort_order: 0,
    });
    expect(buildGroupRenameBody("")).toBeNull();
    expect(buildGroupRenameBody("Cohorts")).toEqual({ name: "Cohorts" });
  });
});

describe("tag history", () => {
  it("parses {items, next_cursor} and renders the event sentences", () => {
    const view = parseTagHistory({
      items: [
        {
          action: "applied",
          source: "bulk",
          occurred_at: "2026-08-01T00:00:00Z",
        },
        { action: "unapplied", source: "", reason: "erasure" },
        { action: "renamed", source: "admin" },
      ],
      next_cursor: "abc",
    });
    expect(view.nextCursor).toBe("abc");
    expect(view.items.map(tagHistoryLine)).toEqual([
      "Applied to a subscriber via bulk",
      "Removed from a subscriber — erasure",
      "renamed via admin",
    ]);
  });

  it("degrades junk to an empty feed", () => {
    expect(parseTagHistory(null)).toEqual({ items: [], nextCursor: "" });
  });
});
