import { describe, expect, it } from "vitest";

import {
  badgeCountFromFeed,
  boundedBadgeCount,
  MAX_APP_BADGE_COUNT,
} from "./badgeCount";

describe("boundedBadgeCount", () => {
  it("passes through a plain count", () => {
    expect(boundedBadgeCount(3)).toBe(3);
  });

  it("clamps negatives and zero to zero", () => {
    expect(boundedBadgeCount(0)).toBe(0);
    expect(boundedBadgeCount(-12)).toBe(0);
  });

  it("caps an absurd count so the icon stays readable", () => {
    expect(boundedBadgeCount(10_000)).toBe(MAX_APP_BADGE_COUNT);
  });

  it("floors fractions and rejects non-numbers", () => {
    expect(boundedBadgeCount(4.9)).toBe(4);
    expect(boundedBadgeCount("7")).toBe(0);
    expect(boundedBadgeCount(Number.NaN)).toBe(0);
    expect(boundedBadgeCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(boundedBadgeCount(null)).toBe(0);
  });
});

describe("badgeCountFromFeed", () => {
  it("reads unread_count from a feed response", () => {
    expect(badgeCountFromFeed({ items: [], unread_count: 5 })).toBe(5);
    expect(badgeCountFromFeed({ items: [], unread_count: 0 })).toBe(0);
  });

  it("returns null for a payload that is not a feed", () => {
    // Null (not 0) so a malformed response never silently clears a real badge.
    expect(badgeCountFromFeed(null)).toBeNull();
    expect(badgeCountFromFeed("{}")).toBeNull();
    expect(badgeCountFromFeed({ items: [] })).toBeNull();
    expect(badgeCountFromFeed({ unread_count: "3" })).toBeNull();
  });

  it("clamps a hostile count", () => {
    expect(badgeCountFromFeed({ unread_count: -4 })).toBe(0);
    expect(badgeCountFromFeed({ unread_count: 1e9 })).toBe(
      MAX_APP_BADGE_COUNT,
    );
  });
});
