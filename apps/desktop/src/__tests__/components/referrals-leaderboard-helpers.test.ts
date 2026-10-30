// Referral leaderboard helpers (roadmap R12): milestone badge renders
// only for unlocked tiers (0 = honest "—"), and the empty-state copy
// reflects the RESPONSE window_days (server falls back to 90 on
// invalid input) rather than what the client asked for.

import { describe, expect, it } from "vitest";

import {
  LEADERBOARD_DEFAULT_WINDOW,
  LEADERBOARD_WINDOWS,
  leaderboardEmptyCopy,
  milestoneBadge,
} from "../../components/referrals/leaderboard-helpers";

describe("LEADERBOARD_WINDOWS", () => {
  it("offers the 30/90/365 day chips with the default present", () => {
    expect(LEADERBOARD_WINDOWS.map((w) => w.value)).toEqual([
      "30d",
      "90d",
      "365d",
    ]);
    expect(
      LEADERBOARD_WINDOWS.some((w) => w.value === LEADERBOARD_DEFAULT_WINDOW),
    ).toBe(true);
  });
});

describe("milestoneBadge", () => {
  it("returns tier copy for unlocked milestones", () => {
    expect(milestoneBadge(10)).toBe("10-referral tier");
    expect(milestoneBadge(1000)).toBe("1,000-referral tier");
  });

  it("returns null for zero / invalid (no fabricated tier)", () => {
    expect(milestoneBadge(0)).toBeNull();
    expect(milestoneBadge(-3)).toBeNull();
    expect(milestoneBadge(Number.NaN)).toBeNull();
  });
});

describe("leaderboardEmptyCopy", () => {
  it("uses the server-echoed window day count", () => {
    expect(leaderboardEmptyCopy(30)).toContain("last 30 days");
    expect(leaderboardEmptyCopy(1)).toContain("last 1 day");
    expect(leaderboardEmptyCopy(1)).not.toContain("1 days");
  });

  it("falls back to 90 on a missing/invalid window", () => {
    expect(leaderboardEmptyCopy(0)).toContain("last 90 days");
    expect(leaderboardEmptyCopy(Number.NaN)).toContain("last 90 days");
  });

  it("labels the report as historical without claiming live signup qualification", () => {
    expect(leaderboardEmptyCopy(90)).toContain("historical credited records");
    expect(leaderboardEmptyCopy(90)).toContain(
      "Live signup qualification and attribution remain review-gated",
    );
  });
});
