// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { summarizeTemplateOutcomes } from "@/lib/template-outcomes";
import type { CampaignReport } from "@/lib/campaign-analytics-api";

function report(delivered: number, unique_opens: number, unique_clicks: number): CampaignReport {
  return { delivered, unique_opens, unique_clicks } as CampaignReport;
}

describe("template outcomes", () => {
  it("weights observed rates by delivered messages across reports", () => {
    const summary = summarizeTemplateOutcomes([report(100, 50, 20), report(300, 60, 15)]);
    expect(summary).toMatchObject({
      campaigns: 2,
      delivered: 400,
      uniqueOpens: 110,
      uniqueClicks: 35,
      clickRate: 8.75,
    });
    expect(summary.openRate).toBeCloseTo(27.5);
  });

  it("does not invent a rate when no delivery denominator exists", () => {
    expect(summarizeTemplateOutcomes([report(0, 0, 0)])).toMatchObject({
      delivered: 0,
      openRate: null,
      clickRate: null,
    });
  });
});
