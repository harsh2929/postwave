import { describe, expect, it } from "vitest";

import {
  analyticsBoundaryColors,
  ANALYTICS_FOOTNOTE,
  EMPTY_CLV_SUMMARY,
  EMPTY_FUNNEL,
  rowsOf,
} from "./analyticsScreenChrome";

describe("rowsOf", () => {
  it("passes an array through unchanged", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(rowsOf(rows)).toBe(rows);
  });

  it("answers an empty array for undefined", () => {
    expect(rowsOf(undefined)).toEqual([]);
  });

  it("answers an empty array for a restored non-array cache", () => {
    // The failure this exists for: a persisted cache written by an older
    // response shape restores `{items: []}`, which is TRUTHY, so `?? []` let it
    // through and the section blew its boundary on the first `.map`.
    expect(rowsOf({ items: [] } as unknown as never[])).toEqual([]);
    expect(rowsOf({} as unknown as never[])).toEqual([]);
    expect(rowsOf(null as unknown as never[])).toEqual([]);
  });
});

describe("EMPTY_FUNNEL", () => {
  it("is a real funnel with no steps, not a partial one", () => {
    expect(EMPTY_FUNNEL.steps).toEqual([]);
    expect(EMPTY_FUNNEL.cohortCount).toBe(0);
  });
});

describe("EMPTY_CLV_SUMMARY", () => {
  it("reports every field as absent rather than as zero", () => {
    // A zero median is a measurement; a null one is the absence of one, and
    // the card renders a sentence instead of a number off exactly that.
    for (const [field, value] of Object.entries(EMPTY_CLV_SUMMARY)) {
      expect(value, `${field} must be null, not 0`).toBeNull();
    }
  });

  it("covers all seven fields the card reads", () => {
    expect(Object.keys(EMPTY_CLV_SUMMARY).sort()).toEqual([
      "atRiskAvgCents",
      "atRiskProfiles",
      "lastCalculatedAt",
      "medianTotalCents",
      "p90TotalCents",
      "profileCount",
      "scoredProfiles",
    ]);
  });
});

describe("analyticsBoundaryColors", () => {
  it("maps the three theme tokens onto the boundary's own names", () => {
    expect(
      analyticsBoundaryColors({
        surface: "#111111",
        borderSubtle: "#222222",
        fgMuted: "#333333",
      }),
    ).toEqual({ surface: "#111111", border: "#222222", text: "#333333" });
  });
});

describe("ANALYTICS_FOOTNOTE", () => {
  it("uses the straight apostrophe the JSX entity decoded to", () => {
    expect(ANALYTICS_FOOTNOTE).toContain("this device's timezone");
    expect(ANALYTICS_FOOTNOTE).not.toContain("’");
    expect(ANALYTICS_FOOTNOTE).not.toContain("&apos;");
  });

  it("is one flowing line, as JSX text collapsed it to", () => {
    expect(ANALYTICS_FOOTNOTE).not.toMatch(/\s{2,}|\n/u);
  });

  it("states all three ways a number here can disagree with the desktop", () => {
    expect(ANALYTICS_FOOTNOTE).toContain("computed on the server");
    expect(ANALYTICS_FOOTNOTE).toContain("neighbouring day");
    expect(ANALYTICS_FOOTNOTE).toContain("headline comparison");
  });
});
