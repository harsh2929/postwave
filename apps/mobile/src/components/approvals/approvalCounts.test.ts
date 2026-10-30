import { describe, expect, it } from "vitest";

import { approvalCountLine } from "./approvalCounts";

describe("approvalCountLine", () => {
  it("names the active filter so a chip tap changes the spoken text", () => {
    // The whole point: the two chips must not produce the same string, or the
    // polite live region announces nothing when the filter changes.
    const pending = approvalCountLine({
      filter: "pending",
      shown: 12,
      loaded: 12,
      searching: false,
    });
    const all = approvalCountLine({
      filter: "all",
      shown: 12,
      loaded: 12,
      searching: false,
    });
    expect(pending).toBe("12 requests awaiting a decision");
    expect(all).toBe("12 requests · all statuses");
    expect(pending).not.toBe(all);
  });

  it("states both numbers while a search narrows the list", () => {
    expect(
      approvalCountLine({
        filter: "pending",
        shown: 3,
        loaded: 48,
        searching: true,
      }),
    ).toBe("3 of 48 requests awaiting a decision");
  });

  it("does not state a range when the search matched everything", () => {
    expect(
      approvalCountLine({
        filter: "all",
        shown: 4,
        loaded: 4,
        searching: true,
      }),
    ).toBe("4 requests · all statuses");
  });

  it("stays singular for one row", () => {
    expect(
      approvalCountLine({
        filter: "pending",
        shown: 1,
        loaded: 1,
        searching: false,
      }),
    ).toBe("1 request awaiting a decision");
  });

  it("says nothing at all for an empty queue — the EmptyState already does", () => {
    expect(
      approvalCountLine({
        filter: "pending",
        shown: 0,
        loaded: 0,
        searching: false,
      }),
    ).toBeNull();
  });

  it("never claims more shown than loaded", () => {
    // Defensive: `shown` and `loaded` come from two different memos on the
    // screen and can disagree for one render after a refetch.
    expect(
      approvalCountLine({
        filter: "all",
        shown: 99,
        loaded: 5,
        searching: true,
      }),
    ).toBe("5 requests · all statuses");
  });
});
