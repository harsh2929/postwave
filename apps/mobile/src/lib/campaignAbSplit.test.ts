import { describe, expect, it } from "vitest";

import {
  AB_SPLIT_OPTIONS,
  abHandoffBlockReason,
  evenSplitPercent,
  isValidSplitPercentage,
  splitCaption,
  splitPercentForKey,
} from "./campaignAbSplit";

describe("AB_SPLIT_OPTIONS", () => {
  it("offers Even as an omitted value so the server computes 100/N", () => {
    expect(AB_SPLIT_OPTIONS[0]).toEqual({
      key: "even",
      percent: null,
      label: "Even",
    });
    expect(splitPercentForKey("even")).toBeNull();
  });

  it("only offers percentages the Go validator accepts (0-100)", () => {
    for (const option of AB_SPLIT_OPTIONS) {
      expect(isValidSplitPercentage(option.percent)).toBe(true);
      expect(splitPercentForKey(option.key)).toBe(option.percent);
    }
  });

  it("falls back to the even split for an unknown key", () => {
    expect(splitPercentForKey("nonsense")).toBeNull();
  });
});

describe("evenSplitPercent", () => {
  it("matches the server's floor(100/n) for the common arm counts", () => {
    expect(evenSplitPercent(2)).toBe(50);
    expect(evenSplitPercent(3)).toBe(33);
    expect(evenSplitPercent(4)).toBe(25);
  });

  it("returns null below two arms — there is no split to describe", () => {
    expect(evenSplitPercent(1)).toBeNull();
    expect(evenSplitPercent(0)).toBeNull();
    expect(evenSplitPercent(Number.NaN)).toBeNull();
  });
});

describe("splitCaption", () => {
  it("names the actual even share rather than leaving 'Even' opaque", () => {
    expect(splitCaption(null, 3)).toContain("33%");
    expect(splitCaption(null, 2)).toContain("50%");
  });

  it("explains that an explicit split holds the remainder back", () => {
    expect(splitCaption(10, 3)).toContain("10%");
    expect(splitCaption(10, 3)).toContain("held for the winner");
  });
});

describe("isValidSplitPercentage", () => {
  it("rejects values the Go validator rejects", () => {
    expect(isValidSplitPercentage(-1)).toBe(false);
    expect(isValidSplitPercentage(101)).toBe(false);
    expect(isValidSplitPercentage(Number.NaN)).toBe(false);
    expect(isValidSplitPercentage("50")).toBe(false);
  });

  it("accepts the omitted case", () => {
    expect(isValidSplitPercentage(null)).toBe(true);
    expect(isValidSplitPercentage(undefined)).toBe(true);
    expect(isValidSplitPercentage(0)).toBe(true);
    expect(isValidSplitPercentage(100)).toBe(true);
  });
});

describe("abHandoffBlockReason", () => {
  it("blocks when the campaign has neither a list nor a segment", () => {
    // The server rejects this body (abtest.go:492-494), so the tap could only
    // ever end in a validation error after the variants had streamed.
    expect(abHandoffBlockReason({})).toContain("no list or segment");
    expect(abHandoffBlockReason({ list_id: "  ", segment_id: "" })).not.toBeNull();
    expect(abHandoffBlockReason(null)).not.toBeNull();
  });

  it("allows a campaign with either audience set", () => {
    expect(abHandoffBlockReason({ list_id: "l1" })).toBeNull();
    expect(abHandoffBlockReason({ segment_id: "s1" })).toBeNull();
  });
});
