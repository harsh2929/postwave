import { describe, expect, it } from "vitest";

import {
  attributionCoverage,
  attributionVerdict,
  centsToUnits,
  excludedCurrencies,
  excludedCurrencyNotice,
  lastTouchNotice,
  provenanceShares,
  rollupNotice,
  unclassifiedNotice,
} from "@/lib/attributionVerdict";
import {
  ATTRIBUTION_WINDOWS,
  attributionWindowFromKey,
  attributionWindowKey,
  normalizeAttributionTimeseries,
  normalizeCampaignAttribution,
  ROLLUP_CAMPAIGN_NAME,
} from "@/lib/conversionAttribution";

/**
 * These tests pin the six server facts named at the top of
 * lib/conversionAttribution.ts. Each one is a place where the obvious
 * implementation states something the server never said.
 */

function wire(over: Record<string, unknown> = {}) {
  return {
    items: [
      {
        campaign_id: "c1",
        campaign_name: "Spring sale",
        conversions: 40,
        revenue_cents: 250_000,
        emails_sent: 10_000,
        revenue_per_send_cents: 25,
      },
      {
        campaign_id: "c2",
        campaign_name: "Welcome",
        conversions: 5,
        revenue_cents: 5_000,
        emails_sent: 0,
      },
    ],
    provenance: { explicit: 30, last_touch: 15, none: 4, unclassified: 1 },
    total_revenue_cents: 300_000,
    unattributed_cents: 45_000,
    unattributed_conversions: 4,
    currency: "USD",
    currencies: [
      { currency: "USD", conversions: 45, revenue_cents: 300_000 },
      { currency: "EUR", conversions: 3, revenue_cents: 12_000 },
    ],
    total_campaigns: 2,
    days: 30,
    ...over,
  };
}

describe("normalizeCampaignAttribution", () => {
  it("keeps a missing revenue_per_send_cents as null, never as 0", () => {
    // The Go pointer is nil when emails_sent == 0 — an honest "no denominator".
    const data = normalizeCampaignAttribution(wire());
    expect(data.items[0]?.revenuePerSendCents).toBe(25);
    expect(data.items[1]?.revenuePerSendCents).toBeNull();
  });

  it("recognises the server's folded tail row as an aggregate, not a campaign", () => {
    const data = normalizeCampaignAttribution(
      wire({
        items: [
          { campaign_id: "c1", campaign_name: "Spring sale", conversions: 1, revenue_cents: 1 },
          { campaign_id: "", campaign_name: ROLLUP_CAMPAIGN_NAME, conversions: 9, revenue_cents: 900 },
        ],
      }),
    );
    expect(data.items[0]?.isRollup).toBe(false);
    expect(data.items[1]?.isRollup).toBe(true);
  });

  it("does not mistake a deleted campaign for the roll-up row", () => {
    const data = normalizeCampaignAttribution(
      wire({
        items: [{ campaign_id: "", campaign_name: "(deleted campaign)", conversions: 2, revenue_cents: 5 }],
      }),
    );
    expect(data.items[0]?.isRollup).toBe(false);
  });

  it("sums the provenance buckets into the window's own denominator", () => {
    const data = normalizeCampaignAttribution(wire());
    expect(data.provenance.total).toBe(50);
  });

  it("reports hasMonetary=false when no conversion carried an amount", () => {
    const data = normalizeCampaignAttribution(wire({ currencies: [], currency: "" }));
    expect(data.hasMonetary).toBe(false);
  });

  it("survives a payload that is not an object at all", () => {
    const data = normalizeCampaignAttribution(undefined);
    expect(data.items).toEqual([]);
    expect(data.provenance.total).toBe(0);
    expect(data.hasMonetary).toBe(false);
  });
});

describe("attributionCoverage", () => {
  it("derives attributed revenue from total minus unattributed", () => {
    const coverage = attributionCoverage(normalizeCampaignAttribution(wire()));
    expect(coverage.attributedCents).toBe(255_000);
    expect(coverage.attributedShare).toBeCloseTo(0.85, 5);
  });

  it("returns a null share rather than 0% when there is no revenue at all", () => {
    const coverage = attributionCoverage(
      normalizeCampaignAttribution(wire({ total_revenue_cents: 0, unattributed_cents: 0 })),
    );
    expect(coverage.attributedShare).toBeNull();
  });

  it("never reports negative attributed revenue from an inconsistent payload", () => {
    const coverage = attributionCoverage(
      normalizeCampaignAttribution(wire({ total_revenue_cents: 100, unattributed_cents: 900 })),
    );
    expect(coverage.attributedCents).toBe(0);
  });
});

describe("provenance disclosures", () => {
  it("computes shares against every conversion in the window", () => {
    const shares = provenanceShares(normalizeCampaignAttribution(wire()).provenance);
    expect(shares?.explicit).toBeCloseTo(0.6, 5);
    expect(shares?.lastTouch).toBeCloseTo(0.3, 5);
  });

  it("returns null shares for an empty window instead of dividing by zero", () => {
    const data = normalizeCampaignAttribution(
      wire({ provenance: { explicit: 0, last_touch: 0, none: 0, unclassified: 0 } }),
    );
    expect(provenanceShares(data.provenance)).toBeNull();
  });

  it("names last touch as a 7-day click heuristic whenever any row used it", () => {
    const notice = lastTouchNotice(normalizeCampaignAttribution(wire()).provenance);
    expect(notice).toContain("15 of these conversions");
    expect(notice).toContain("7 days");
  });

  it("says nothing about last touch when nothing used it", () => {
    const data = normalizeCampaignAttribution(
      wire({ provenance: { explicit: 5, last_touch: 0, none: 0, unclassified: 0 } }),
    );
    expect(lastTouchNotice(data.provenance)).toBeNull();
  });

  it("keeps unclassified separate from unattributed", () => {
    const notice = unclassifiedNotice(normalizeCampaignAttribution(wire()).provenance);
    expect(notice).toContain("1 conversions predate");
    expect(notice).toContain("neither attributed nor known to be unattributed");
  });
});

describe("currency disclosure", () => {
  it("names the money excluded from every figure on the screen", () => {
    const data = normalizeCampaignAttribution(wire());
    expect(excludedCurrencies(data).map((row) => row.currency)).toEqual(["EUR"]);
    expect(excludedCurrencyNotice(data)).toContain("120.00 EUR");
  });

  it("names an unlabelled currency rather than rendering a blank", () => {
    const data = normalizeCampaignAttribution(
      wire({
        currencies: [
          { currency: "USD", conversions: 1, revenue_cents: 100 },
          { currency: "", conversions: 1, revenue_cents: 700 },
        ],
      }),
    );
    expect(excludedCurrencyNotice(data)).toContain("no currency recorded");
  });

  it("says nothing when the window is single-currency", () => {
    const data = normalizeCampaignAttribution(
      wire({ currencies: [{ currency: "USD", conversions: 1, revenue_cents: 100 }] }),
    );
    expect(excludedCurrencyNotice(data)).toBeNull();
  });
});

describe("rollupNotice", () => {
  it("says nothing when the list is the whole picture", () => {
    expect(rollupNotice(normalizeCampaignAttribution(wire()))).toBeNull();
  });

  it("counts named rows rather than assuming the server's cap of 50", () => {
    const data = normalizeCampaignAttribution(
      wire({
        items: [
          { campaign_id: "c1", campaign_name: "A", conversions: 1, revenue_cents: 1 },
          { campaign_id: "", campaign_name: ROLLUP_CAMPAIGN_NAME, conversions: 9, revenue_cents: 9 },
        ],
        total_campaigns: 80,
      }),
    );
    expect(rollupNotice(data)).toBe(
      "Showing the top 1 of 80 campaigns with attributed conversions. The rest are summed into one row so the totals stay exact.",
    );
  });
});

describe("attributionVerdict", () => {
  it("separates 'no conversions' from 'no money'", () => {
    const silent = normalizeCampaignAttribution(
      wire({ provenance: { explicit: 0, last_touch: 0, none: 0, unclassified: 0 }, currencies: [] }),
    );
    expect(attributionVerdict(silent, 30).headline).toBe("No conversions in the last 30 days");

    const nonMonetary = normalizeCampaignAttribution(
      wire({ provenance: { explicit: 3, last_touch: 0, none: 0, unclassified: 0 }, currencies: [], currency: "" }),
    );
    expect(attributionVerdict(nonMonetary, 30).headline).toBe(
      "3 conversions, none carrying an amount",
    );
  });

  it("warns when under half of revenue could be tied to a campaign", () => {
    const data = normalizeCampaignAttribution(
      wire({ total_revenue_cents: 100_000, unattributed_cents: 80_000 }),
    );
    const verdict = attributionVerdict(data, 30);
    expect(verdict.tone).toBe("warn");
    expect(verdict.detail).toContain("20%");
  });

  it("is ok on a well-attributed window", () => {
    expect(attributionVerdict(normalizeCampaignAttribution(wire()), 30).tone).toBe("ok");
  });

  it("reports 'no reading yet' rather than inventing an empty window", () => {
    expect(attributionVerdict(null, 30).tone).toBe("idle");
  });
});

describe("normalizeAttributionTimeseries", () => {
  it("keeps the server's zero-filled days — an empty day is a fact", () => {
    const series = normalizeAttributionTimeseries({
      points: [
        { date: "2026-07-24", revenue_cents: 0, conversions: 0 },
        { date: "2026-07-25", revenue_cents: 5_000, conversions: 2 },
      ],
      currency: "USD",
      currencies: [{ currency: "USD", conversions: 2, revenue_cents: 5_000 }],
      days: 2,
    });
    expect(series.points).toHaveLength(2);
    expect(series.points[0]?.conversions).toBe(0);
    expect(series.days).toBe(2);
  });

  it("drops a point with no date rather than plotting it at an unknown day", () => {
    expect(
      normalizeAttributionTimeseries({ points: [{ date: "", revenue_cents: 9 }] }).points,
    ).toEqual([]);
  });
});

describe("centsToUnits", () => {
  it("converts to whole currency units for the render edge", () => {
    expect(centsToUnits(250_000)).toBe(2500);
    expect(centsToUnits(1)).toBe(0.01);
  });
});

describe("window keys", () => {
  it("round-trips every offered window through the segmented control's string", () => {
    for (const days of ATTRIBUTION_WINDOWS) {
      expect(attributionWindowFromKey(attributionWindowKey(days))).toBe(days);
    }
  });

  it("lands on the default window rather than NaN for an unexpected key", () => {
    // Total by construction: the control can only emit the three keys, and a
    // future fourth must not become `Number(undefined)` days on the wire.
    expect(attributionWindowFromKey("30")).toBe(30);
  });
});
