import { describe, expect, it } from "vitest";

import { buildAnalyticsExportPlan } from "./analyticsExportSeries";

function source(over: Record<string, unknown> = {}) {
  return {
    growth: { rows: [{ date: "2026-07-01", count: 120 }], failed: false },
    leaderboard: {
      rows: [
        {
          name: "Weekly digest",
          campaignsUsed: 4,
          sent: 1000,
          opens: 400,
          clicks: 50,
          openRate: 0.4,
          clickRate: null,
        },
      ],
      failed: false,
    },
    revenue: {
      rows: [
        {
          name: "Spring sale",
          conversions: 12,
          revenueCents: 123456,
          emailsSent: 900,
          revenuePerSendCents: null,
        },
      ],
      currency: "EUR",
      failed: false,
    },
    bands: {
      rows: [{ label: "Champions", profiles: 60, share: 0.6 }],
      failed: false,
    },
    ...over,
  } as Parameters<typeof buildAnalyticsExportPlan>[0];
}

describe("analytics export plan", () => {
  it("exports the four tabular sections and nothing single-figure", () => {
    const plan = buildAnalyticsExportPlan(source());
    expect(plan.series.map((s) => s.section)).toEqual([
      "Audience growth",
      "Top templates",
      "Revenue by campaign",
      "Customer bands",
    ]);
    expect(plan.unavailable).toEqual([]);
    // Customer value / model coverage are deliberately absent — a figure that
    // needs a paragraph of caveats does not survive a paste into Sheets.
    expect(JSON.stringify(plan.series)).not.toContain("Customer value");
  });

  it("names a failed section instead of exporting it as empty", () => {
    const plan = buildAnalyticsExportPlan(
      source({ revenue: { rows: [], currency: null, failed: true } }),
    );
    expect(plan.series.map((s) => s.section)).not.toContain(
      "Revenue by campaign",
    );
    expect(plan.unavailable).toContain("Revenue by campaign");
  });

  it("treats a genuinely empty section the same way a failed one is treated", () => {
    // From the reader's side both carry the same risk: missing rows read as
    // measured zeroes.
    const plan = buildAnalyticsExportPlan(
      source({ bands: { rows: [], failed: false } }),
    );
    expect(plan.unavailable).toContain("Customer bands");
  });

  it("keeps an unreported rate null so a spreadsheet cannot average it as zero", () => {
    const plan = buildAnalyticsExportPlan(source());
    const leaderboard = plan.series.find((s) => s.section === "Top templates");
    expect(leaderboard?.rows[0]).toEqual([
      "Weekly digest",
      4,
      1000,
      400,
      50,
      0.4,
      null,
    ]);
  });

  it("puts the currency in the column name, never beside each figure", () => {
    // The attribution payload establishes ONE dominant currency for the whole
    // window; repeating it per row would imply it was established per row.
    const withCurrency = buildAnalyticsExportPlan(source());
    expect(
      withCurrency.series.find((s) => s.section === "Revenue by campaign")
        ?.columns,
    ).toContain("revenue_eur");

    const noCurrency = buildAnalyticsExportPlan(
      source({
        revenue: {
          rows: [
            {
              name: "Spring sale",
              conversions: 1,
              revenueCents: 100,
              emailsSent: 10,
              revenuePerSendCents: 10,
            },
          ],
          currency: null,
          failed: false,
        },
      }),
    );
    expect(
      noCurrency.series.find((s) => s.section === "Revenue by campaign")
        ?.columns,
    ).toContain("revenue");
  });

  it("converts cents to major units as a summable number", () => {
    const plan = buildAnalyticsExportPlan(source());
    const revenue = plan.series.find((s) => s.section === "Revenue by campaign");
    expect(revenue?.rows[0]?.[2]).toBe(1234.56);
    // A null per-send figure stays null — there was no honest denominator.
    expect(revenue?.rows[0]?.[4]).toBeNull();
  });

  it("writes band share as a percentage with one decimal", () => {
    const plan = buildAnalyticsExportPlan(
      source({
        bands: {
          rows: [{ label: "Hibernating", profiles: 1, share: 0.3333 }],
          failed: false,
        },
      }),
    );
    expect(
      plan.series.find((s) => s.section === "Customer bands")?.rows[0],
    ).toEqual(["Hibernating", 1, 33.3]);
  });
});
