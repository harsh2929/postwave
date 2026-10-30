import { describe, expect, it } from "vitest";

import {
  bulkOutcomeMessage,
  bulkTagBlockedReason,
  campaignSelectionLabel,
  compareBlockedReason,
  partitionDeletable,
  pruneCampaignSelection,
  selectedCampaigns,
  toggleCampaignSelection,
} from "./campaignSelection";

describe("toggleCampaignSelection", () => {
  it("adds in tap order and removes without reordering the rest", () => {
    expect(toggleCampaignSelection([], "a")).toEqual(["a"]);
    expect(toggleCampaignSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleCampaignSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("pruneCampaignSelection", () => {
  it("drops ids that left the loaded list", () => {
    expect(pruneCampaignSelection(["a", "b"], ["b", "c"])).toEqual(["b"]);
  });

  it("keeps everything when the list still holds it", () => {
    expect(pruneCampaignSelection(["a", "b"], ["a", "b", "c"])).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("selectedCampaigns", () => {
  it("returns rows in LIST order, not selection order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(selectedCampaigns(rows, ["c", "a"]).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("partitionDeletable", () => {
  it("keeps only drafts on the deletable side", () => {
    const p = partitionDeletable([
      { id: "1", status: "draft" },
      { id: "2", status: "sent" },
      { id: "3", status: "DRAFT" },
    ]);
    expect(p.deletable.map((c) => c.id)).toEqual(["1", "3"]);
    expect(p.blocked.map((c) => c.id)).toEqual(["2"]);
  });

  /**
   * The dangerous default. A row whose status never arrived is not a draft
   * until proven otherwise — assuming it was would fire a delete at something
   * that could be mid-send.
   */
  it("treats a missing status as NOT deletable", () => {
    const p = partitionDeletable([{ id: "1" }, { id: "2", status: "  " }]);
    expect(p.deletable).toEqual([]);
    expect(p.blocked).toHaveLength(2);
  });
});

describe("campaignSelectionLabel", () => {
  it("prefers name, falls back to subject, then to Untitled", () => {
    expect(campaignSelectionLabel({ id: "1", name: "Spring" })).toBe("Spring");
    expect(campaignSelectionLabel({ id: "1", subject: "Hi" })).toBe("Hi");
    expect(campaignSelectionLabel({ id: "1", name: "   " })).toBe("Untitled");
  });
});

describe("bulkOutcomeMessage", () => {
  const verb = { done: "Deleted", doing: "delete" };

  it("reports a clean run without inventing a failure clause", () => {
    expect(
      bulkOutcomeMessage({ succeeded: ["a", "b"], failed: [] }, verb),
    ).toBe("Deleted 2 campaigns.");
    expect(bulkOutcomeMessage({ succeeded: ["a"], failed: [] }, verb)).toBe(
      "Deleted 1 campaign.",
    );
  });

  it("names the single failure and the reason the server gave", () => {
    expect(
      bulkOutcomeMessage(
        { succeeded: [], failed: [{ label: "Spring", reason: "not a draft" }] },
        verb,
      ),
    ).toBe('Couldn\'t delete "Spring" — not a draft');
  });

  /** The whole point: a partial run must say WHICH ones survived. */
  it("names up to three survivors on a partial run", () => {
    const message = bulkOutcomeMessage(
      {
        succeeded: ["a", "b"],
        failed: [
          { label: "X", reason: "r" },
          { label: "Y", reason: "r" },
        ],
      },
      verb,
    );
    expect(message).toContain("Deleted 2 of 4");
    expect(message).toContain('"X", "Y"');
    expect(message).toContain("were left unchanged");
  });

  it("collapses to a count past three failures rather than quoting forty names", () => {
    const failed = Array.from({ length: 6 }, (_, i) => ({
      label: `C${i}`,
      reason: "r",
    }));
    const message = bulkOutcomeMessage({ succeeded: ["a"], failed }, verb);
    expect(message).toContain("and 3 more");
    expect(message).not.toContain("C5");
  });
});

describe("blocked reasons", () => {
  it("explains an empty or oversized tag selection instead of greying out silently", () => {
    expect(bulkTagBlockedReason(0)).toContain("Select campaigns");
    expect(bulkTagBlockedReason(1)).toBeNull();
    expect(bulkTagBlockedReason(500)).toBeNull();
    expect(bulkTagBlockedReason(501)).toContain("500");
  });

  it("requires exactly two-to-three campaigns to compare on a phone", () => {
    expect(compareBlockedReason(1)).toContain("two campaigns");
    expect(compareBlockedReason(2)).toBeNull();
    expect(compareBlockedReason(3)).toBeNull();
    expect(compareBlockedReason(4)).toContain("3 campaigns");
  });
});
