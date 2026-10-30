// Revenue attribution pure logic (full-surface wiring): cents
// formatting, rollup-row handling, the mixed-currency disclosure, the
// timeseries → LineChart mapping, and UUID-safe campaign filter
// options.

import { describe, expect, it } from "vitest";

import {
  campaignFilterOptions,
  currencyDisclosure,
  fmtMoneyCents,
  isRollupRow,
  revenuePerSendText,
  revenueTickStride,
  revenueTimeseriesHasActivity,
  revenueTimeseriesPoints,
  revenueTimeseriesTotalCents,
} from "../../components/analytics/revenue-attribution";
import type { RevenueAttributionItem } from "../../lib/api-client";

function item(
  partial: Partial<RevenueAttributionItem>,
): RevenueAttributionItem {
  return {
    campaign_id: "11111111-2222-3333-4444-555555555555",
    campaign_name: "Spring sale",
    conversions: 3,
    revenue_cents: 12_345,
    emails_sent: 100,
    ...partial,
  };
}

describe("fmtMoneyCents", () => {
  it("formats whole-major amounts without decimals (en-US)", () => {
    expect(fmtMoneyCents(120_000, "USD", "en-US")).toBe("$1,200");
  });

  it("keeps cents when the amount isn't whole", () => {
    expect(fmtMoneyCents(12_345, "USD", "en-US")).toBe("$123.45");
  });

  it("renders a plain number with NO symbol when currency is unknown", () => {
    // Mixed-currency totals arrive without a dominant currency —
    // inventing a symbol would misstate the unit.
    expect(fmtMoneyCents(12_345, undefined, "en-US")).toBe("123.45");
    expect(fmtMoneyCents(120_000, "", "en-US")).toBe("1,200");
  });

  it("falls back to a plain number for invalid ISO codes", () => {
    expect(fmtMoneyCents(5_000, "NOTACODE", "en-US")).toBe("50");
  });

  it("treats a missing/non-numeric cents field as 0 (never NaN)", () => {
    // Populated-data click-through can surface a row whose cents field
    // the wrapper omitted — format 0, don't render "NaN"/"$NaN".
    expect(fmtMoneyCents(undefined, "USD", "en-US")).toBe("$0");
    expect(fmtMoneyCents(null, undefined, "en-US")).toBe("0");
    expect(fmtMoneyCents(Number.NaN, "USD", "en-US")).toBe("$0");
  });
});

describe("isRollupRow / revenuePerSendText", () => {
  it("detects the '(other campaigns)' rollup by its empty id", () => {
    expect(
      isRollupRow(
        item({ campaign_id: "", campaign_name: "(other campaigns)" }),
      ),
    ).toBe(true);
    expect(isRollupRow(item({}))).toBe(false);
  });

  it("renders an explicit em-dash when the backend omitted rev/send", () => {
    expect(revenuePerSendText(item({}), "USD", "en-US")).toBe("—");
  });

  it("formats rev/send when present", () => {
    expect(
      revenuePerSendText(item({ revenue_per_send_cents: 123 }), "USD", "en-US"),
    ).toBe("$1.23");
  });
});

describe("currencyDisclosure", () => {
  it("returns no label when there are no conversions at all", () => {
    expect(currencyDisclosure({ currencies: [] })).toEqual({
      mixed: false,
      label: null,
    });
  });

  it("single currency → simple 'all amounts in X' line", () => {
    const d = currencyDisclosure({
      currency: "EUR",
      currencies: [{ currency: "EUR", conversions: 4, revenue_cents: 100 }],
    });
    expect(d.mixed).toBe(false);
    expect(d.label).toBe("All amounts in EUR.");
  });

  it("mixed currencies → full breakdown + 'not converted' honesty", () => {
    const d = currencyDisclosure(
      {
        currencies: [
          { currency: "USD", conversions: 2, revenue_cents: 10_000 },
          { currency: "EUR", conversions: 1, revenue_cents: 5_000 },
        ],
      },
      "en-US",
    );
    expect(d.mixed).toBe(true);
    expect(d.label).toContain("2 currencies were recorded");
    expect(d.label).toContain("USD");
    expect(d.label).toContain("EUR");
    expect(d.label).toContain("not converted");
  });

  it("mixed but with a dominant currency still discloses the mix", () => {
    const d = currencyDisclosure(
      {
        currency: "USD",
        currencies: [
          { currency: "USD", conversions: 9, revenue_cents: 90_000 },
          { currency: "EUR", conversions: 1, revenue_cents: 1_000 },
        ],
      },
      "en-US",
    );
    expect(d.mixed).toBe(true);
    expect(d.label).toContain("Primary net total and campaign rows use USD");
    expect(d.label).toContain("2 currencies were recorded");
  });
});

describe("revenueTimeseriesPoints", () => {
  it("maps cents to major units on LineChart's {date,count} shape", () => {
    expect(
      revenueTimeseriesPoints([
        { date: "2026-06-01", revenue_cents: 12_345, conversions: 2 },
        { date: "2026-06-02", revenue_cents: 0, conversions: 0 },
      ]),
    ).toEqual([
      { date: "2026-06-01", count: 123.45 },
      { date: "2026-06-02", count: 0 },
    ]);
  });

  it("keeps zero-filled gap days so the x-axis stays continuous", () => {
    const pts = revenueTimeseriesPoints([
      { date: "2026-06-01", revenue_cents: 100, conversions: 1 },
      { date: "2026-06-02", revenue_cents: 0, conversions: 0 },
      { date: "2026-06-03", revenue_cents: 200, conversions: 1 },
    ]);
    expect(pts).toHaveLength(3);
    expect(pts[1]?.count).toBe(0);
  });

  it("totals drive the honest empty state", () => {
    expect(
      revenueTimeseriesTotalCents([
        { date: "2026-06-01", revenue_cents: 0, conversions: 0 },
        { date: "2026-06-02", revenue_cents: 0, conversions: 0 },
      ]),
    ).toBe(0);
    expect(
      revenueTimeseriesTotalCents([
        { date: "2026-06-01", revenue_cents: 5, conversions: 1 },
      ]),
    ).toBe(5);
  });

  it("keeps refund-only and offsetting windows visible", () => {
    const refundOnly = [
      { date: "2026-06-01", revenue_cents: -2500, conversions: 1 },
    ];
    const offsetting = [
      { date: "2026-06-01", revenue_cents: 5000, conversions: 1 },
      { date: "2026-06-02", revenue_cents: -5000, conversions: 1 },
    ];
    expect(revenueTimeseriesHasActivity(refundOnly)).toBe(true);
    expect(revenueTimeseriesTotalCents(refundOnly)).toBe(-2500);
    expect(revenueTimeseriesHasActivity(offsetting)).toBe(true);
    expect(revenueTimeseriesTotalCents(offsetting)).toBe(0);
    expect(revenueTimeseriesHasActivity([])).toBe(false);
  });

  it("returns empty/zero (no crash) when the wrapper omits points", () => {
    // `.map`/`for…of` over an absent points array is the populated-data
    // crash class — guard it gracefully.
    expect(revenueTimeseriesPoints(undefined)).toEqual([]);
    expect(revenueTimeseriesPoints(null)).toEqual([]);
    expect(revenueTimeseriesTotalCents(undefined)).toBe(0);
    expect(revenueTimeseriesTotalCents(null)).toBe(0);
  });

  it("coerces a missing per-point cents field to 0 (never NaN)", () => {
    const pts = revenueTimeseriesPoints([
      // @ts-expect-error — simulating a wire row missing revenue_cents.
      { date: "2026-06-01", conversions: 1 },
    ]);
    expect(pts).toEqual([{ date: "2026-06-01", count: 0 }]);
    expect(
      revenueTimeseriesTotalCents([
        // @ts-expect-error — simulating a wire row missing revenue_cents.
        { date: "2026-06-01", conversions: 1 },
      ]),
    ).toBe(0);
  });
});

describe("revenueTickStride", () => {
  it("mirrors the page's per-range tick density", () => {
    expect(revenueTickStride(7)).toBe(1);
    expect(revenueTickStride(30)).toBe(5);
    expect(revenueTickStride(90)).toBe(15);
  });
});

describe("campaignFilterOptions", () => {
  it("excludes the rollup row — an empty id isn't filterable", () => {
    const opts = campaignFilterOptions([
      item({ campaign_id: "aaaa", campaign_name: "A" }),
      item({ campaign_id: "", campaign_name: "(other campaigns)" }),
      item({ campaign_id: "bbbb", campaign_name: "B" }),
    ]);
    expect(opts).toEqual([
      { id: "aaaa", name: "A" },
      { id: "bbbb", name: "B" },
    ]);
  });

  it("returns no options (no crash) when items is absent", () => {
    expect(campaignFilterOptions(undefined)).toEqual([]);
    expect(campaignFilterOptions(null)).toEqual([]);
  });
});
