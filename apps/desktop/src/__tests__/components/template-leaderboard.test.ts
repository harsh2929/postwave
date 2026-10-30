/**
 * template-leaderboard — pure logic behind the Templates page
 * "Performance" section. Contracts under test:
 *
 *   - rates arrive as 0..1 FRACTIONS from the Go handler and are
 *     multiplied by 100 exactly once (branch rate convention);
 *   - counts render locale-grouped, defensively;
 *   - the empty/caveat copy distinguishes canonical lineage from legacy;
 *   - malformed successful payloads fail closed at runtime.
 */

import { describe, expect, it } from "vitest";

import {
  LEADERBOARD_ATTRIBUTION_CAVEAT,
  LEADERBOARD_WINDOWS,
  decodeTemplateLeaderboard,
  formatLeaderboardCount,
  formatLeaderboardRate,
  leaderboardEmptyCopy,
} from "../../components/templates/template-leaderboard";

describe("formatLeaderboardRate", () => {
  it("multiplies a 0..1 fraction by 100 exactly once", () => {
    expect(formatLeaderboardRate(0.4321)).toBe("43.2%");
    expect(formatLeaderboardRate(0)).toBe("0.0%");
    expect(formatLeaderboardRate(1)).toBe("100.0%");
  });

  it("renders the server's 4dp rounding faithfully at 1dp", () => {
    // safeRate(1, 3) on the Go side → 0.3333.
    expect(formatLeaderboardRate(0.3333)).toBe("33.3%");
    // Half-up at the displayed decimal.
    expect(formatLeaderboardRate(0.0455)).toBe("4.5%");
  });

  it("never re-scales an already-fraction value (no ×10000)", () => {
    // A 2.5% open rate is 0.025 on the wire — must NOT print 250%.
    expect(formatLeaderboardRate(0.025)).toBe("2.5%");
  });

  it("is defensive against malformed rows", () => {
    expect(formatLeaderboardRate(Number.NaN)).toBe("—");
    expect(formatLeaderboardRate(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatLeaderboardCount", () => {
  it("locale-groups integers", () => {
    expect(formatLeaderboardCount(0)).toBe((0).toLocaleString());
    expect(formatLeaderboardCount(12345)).toBe((12345).toLocaleString());
  });

  it("is defensive against malformed rows", () => {
    expect(formatLeaderboardCount(Number.NaN)).toBe("0");
  });
});

describe("windows + copy", () => {
  it("offers exactly the 30/90 day windows (90 = server default)", () => {
    expect([...LEADERBOARD_WINDOWS]).toEqual([30, 90]);
  });

  it("empty copy names the active window and frames it as attribution", () => {
    expect(leaderboardEmptyCopy(30)).toContain("30 days");
    expect(leaderboardEmptyCopy(90)).toContain("90 days");
    expect(leaderboardEmptyCopy(30)).toMatch(/attributable/i);
  });

  it("caveat distinguishes canonical lineage from a legacy fallback", () => {
    expect(LEADERBOARD_ATTRIBUTION_CAVEAT).toMatch(/source-template lineage/i);
    expect(LEADERBOARD_ATTRIBUTION_CAVEAT).toMatch(/legacy/i);
  });
});

describe("decodeTemplateLeaderboard", () => {
  const valid = {
    items: [
      {
        template_id: "tpl-1",
        template_name: "Welcome",
        campaigns_used: 2,
        sent: 100,
        opens: 45,
        clicks: 8,
        open_rate: 0.45,
        click_rate: 0.08,
      },
    ],
  };

  it("accepts a complete bounded response", () => {
    expect(decodeTemplateLeaderboard(valid)).toEqual(valid.items);
  });

  it("rejects missing arrays, invalid identities, counts, and rates", () => {
    expect(decodeTemplateLeaderboard({})).toBeNull();
    expect(
      decodeTemplateLeaderboard({
        items: [{ ...valid.items[0], template_id: "" }],
      }),
    ).toBeNull();
    expect(
      decodeTemplateLeaderboard({
        items: [{ ...valid.items[0], sent: Number.NaN }],
      }),
    ).toBeNull();
    expect(
      decodeTemplateLeaderboard({
        items: [{ ...valid.items[0], open_rate: 45 }],
      }),
    ).toBeNull();
  });
});
