/**
 * The per-cohort funnel's contract, pinned against
 * apps/api/internal/analytics/service.go:1090-1160.
 *
 * Every assertion here is about a way the table could lie: a tag UUID sent
 * where the server matches names, a rate printed against the wrong
 * denominator, a filtered table read against unfiltered bars, or a dropped
 * measurement drawn as a zero.
 */
import { describe, expect, it } from "vitest";

import {
  COHORT_MATURITY_NOTE,
  audienceOptions,
  cohortCell,
  cohortFunnelEmptyCopy,
  cohortFunnelPath,
  cohortRate,
  cohortRowSpoken,
  cohortScopeLabel,
  cohortScopeSummary,
  parseCohortFunnel,
  type CohortFunnelRow,
} from "./cohortFunnel";

const PAYLOAD = {
  bucket: "month",
  cohort_by: "created_at_month",
  steps: [
    { stage: "signup", label: "Signed Up", count: 500, conversion_rate: 100 },
    {
      stage: "first_purchase",
      label: "First Purchase",
      count: 40,
      conversion_rate: 8,
    },
    {
      stage: "repeat_purchase",
      label: "Repeat Purchase",
      count: 10,
      conversion_rate: 25,
    },
  ],
  cohorts: [
    {
      cohort_label: "2026-08",
      signup_count: 200,
      first_purchase_count: 6,
      repeat_purchase_count: 1,
      first_purchase_rate: 3,
      repeat_purchase_rate: 16.666,
    },
    {
      cohort_label: "2026-07",
      signup_count: 300,
      first_purchase_count: 34,
      repeat_purchase_count: 9,
      first_purchase_rate: 11.333,
      repeat_purchase_rate: 26.47,
    },
  ],
};

describe("cohortFunnelPath", () => {
  it("omits audience_id entirely when nothing is scoped", () => {
    expect(cohortFunnelPath(12, "")).toBe(
      "/api/v1/analytics/subscribers/funnel?bucket=month&cohort_by=created_at_month&weeks=12",
    );
  });

  it("sends the tag NAME, url-encoded — the server matches ANY(s.tags)", () => {
    expect(cohortFunnelPath(12, "VIP buyers")).toContain(
      "&audience_id=VIP%20buyers",
    );
  });

  it("falls back to 12 months rather than sending weeks=NaN", () => {
    expect(cohortFunnelPath(Number.NaN, "")).toContain("weeks=12");
    expect(cohortFunnelPath(0, "")).toContain("weeks=12");
  });
});

describe("parseCohortFunnel", () => {
  it("keeps the server's newest-first order (ORDER BY cohort DESC)", () => {
    const view = parseCohortFunnel(PAYLOAD);
    expect(view.rows.map((row) => row.label)).toEqual(["2026-08", "2026-07"]);
  });

  it("reads both rates and every count off one row", () => {
    const row = parseCohortFunnel(PAYLOAD).rows[0];
    expect(row).toMatchObject({
      label: "2026-08",
      signups: 200,
      firstPurchases: 6,
      repeatPurchases: 1,
      firstRatePct: 3,
    });
  });

  it("returns an empty view for every non-payload rather than throwing", () => {
    for (const raw of [null, undefined, 7, "no", [], { cohorts: "nope" }]) {
      expect(parseCohortFunnel(raw)).toEqual({ rows: [], stages: [] });
    }
  });

  it("drops an unlabelled or non-object cohort instead of rendering a blank row", () => {
    const view = parseCohortFunnel({
      cohorts: [null, { signup_count: 4 }, { cohort_label: "  " }, ...PAYLOAD.cohorts],
    });
    expect(view.rows).toHaveLength(2);
  });

  it("keeps an unreported count NULL — an absent measure is not a zero", () => {
    const view = parseCohortFunnel({
      cohorts: [{ cohort_label: "2026-08", signup_count: "200" }],
    });
    expect(view.rows[0]).toMatchObject({
      signups: null,
      firstPurchases: null,
      firstRatePct: null,
    });
  });

  it("clamps an impossible rate to 100 rather than printing it", () => {
    const view = parseCohortFunnel({
      cohorts: [{ cohort_label: "2026-08", repeat_purchase_rate: 180 }],
    });
    expect(view.rows[0]?.repeatRatePct).toBe(100);
  });
});

describe("scope copy", () => {
  it("names the audience the filter actually sent", () => {
    expect(cohortScopeLabel("vip")).toBe("audience “vip”");
    expect(cohortScopeLabel("  ")).toBe("all subscribers");
  });

  it("says nothing when nothing is scoped — there is no discrepancy", () => {
    expect(cohortScopeSummary(parseCohortFunnel(PAYLOAD), "")).toBeNull();
  });

  it("states the scoped totals AND that the bars above are unscoped", () => {
    const line = cohortScopeSummary(parseCohortFunnel(PAYLOAD), "vip");
    expect(line).toContain("Scoped to audience “vip”");
    expect(line).toContain("500 signed up");
    expect(line).toContain("40 first purchase");
    expect(line).toContain("The stage bars above cover all subscribers.");
  });

  it("still warns about the mismatch when the scoped totals are missing", () => {
    const line = cohortScopeSummary({ rows: [], stages: [] }, "vip");
    expect(line).toContain("The stage bars above cover all subscribers.");
  });

  it("names the window and the scope when no cohort came back", () => {
    expect(cohortFunnelEmptyCopy("vip", 12)).toContain(
      "the last 12 signup months",
    );
    expect(cohortFunnelEmptyCopy("vip", 12)).toContain("audience “vip”");
    expect(cohortFunnelEmptyCopy("", 1)).toContain("the last signup month");
  });

  it("keeps the maturity caveat, which is why the newest row reads worst", () => {
    expect(COHORT_MATURITY_NOTE).toContain("Newest cohort first");
    expect(COHORT_MATURITY_NOTE).toContain("least time");
  });
});

describe("cells", () => {
  it("renders an unreported measure as an em dash, never 0", () => {
    expect(cohortCell(null)).toBe("—");
    expect(cohortRate(null)).toBe("—");
    expect(cohortCell(0)).toBe("0");
  });

  it("reads wire rates as PERCENTAGES — pct() already multiplied by 100", () => {
    expect(cohortRate(11.333)).toBe("11%");
    expect(cohortRate(3)).toBe("3.0%");
  });

  it("speaks both denominators, because the payload's two rates differ", () => {
    const july = parseCohortFunnel(PAYLOAD).rows[1];
    const spoken = cohortRowSpoken(july as CohortFunnelRow);
    expect(spoken).toContain("300 signups");
    expect(spoken).toContain("34 first purchases, 11% of signups");
    expect(spoken).toContain("9 repeat purchases, 26% of first purchasers");
  });

  it("says which measure is missing rather than speaking a zero", () => {
    expect(
      cohortRowSpoken({
        label: "2026-08",
        signups: null,
        firstPurchases: null,
        repeatPurchases: null,
        firstRatePct: null,
        repeatRatePct: null,
      }),
    ).toBe(
      "2026-08: signups not reported, first purchases not reported, repeat purchases not reported.",
    );
  });
});

describe("audienceOptions", () => {
  it("always offers the unfiltered read first, valued empty", () => {
    expect(audienceOptions([])[0]).toEqual({
      value: "",
      label: "All subscribers",
    });
  });

  it("uses the tag NAME as the value: audience_id matches ANY(s.tags)", () => {
    const options = audienceOptions([{ name: "vip" }]);
    expect(options[1]).toEqual({ value: "vip", label: "vip" });
  });

  it("survives a restored snapshot that is not an array", () => {
    expect(
      audienceOptions({ items: [] } as unknown as { name?: string }[]),
    ).toHaveLength(1);
    expect(audienceOptions(undefined)).toHaveLength(1);
  });

  it("drops blanks and case-insensitive duplicates, and sorts by name", () => {
    const options = audienceOptions([
      { name: "  " },
      { name: "zeta" },
      { name: "Alpha" },
      { name: "alpha" },
      {},
    ]);
    expect(options.map((option) => option.label)).toEqual([
      "All subscribers",
      "Alpha",
      "zeta",
    ]);
  });

  it("caps the row so a thousand-tag workspace cannot render a thousand chips", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      name: `tag-${String(i).padStart(3, "0")}`,
    }));
    expect(audienceOptions(rows)).toHaveLength(41);
  });
});
