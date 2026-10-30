import { describe, expect, it } from "vitest";

import type { CampaignReport } from "@/hooks/useCampaigns";
import {
  effectiveEngagementMode,
  engagementCaption,
  engagementFigures,
  hasHumanEngagement,
  reportRates,
} from "./campaignEngagement";

/**
 * The wire shape a STOCK deployment returns: POSTWAVE_HUMAN_ENGAGEMENT is off
 * by default (apps/api/main.go), so every human_* field is serialised as zero
 * next to real raw numbers.
 */
function flagOffReport(): CampaignReport {
  return {
    campaign_id: "c1",
    sent: 1000,
    delivered: 980,
    opens: 520,
    unique_opens: 410,
    clicks: 90,
    unique_clicks: 61,
    bounces: 20,
    complaints: 1,
    unsubscribes: 4,
    open_rate: 0.4183,
    click_rate: 0.0622,
    click_to_open_rate: 0.1487,
    bounce_rate: 0.02,
    unsub_rate: 0.004,
    human_opens: 0,
    human_unique_opens: 0,
    human_clicks: 0,
    human_unique_clicks: 0,
    human_open_rate: 0,
    human_click_rate: 0,
    human_click_to_open_rate: 0,
    bot_signatures_applied: [],
  };
}

function flagOnReport(): CampaignReport {
  return {
    ...flagOffReport(),
    human_opens: 300,
    human_unique_opens: 250,
    human_clicks: 70,
    human_unique_clicks: 50,
    human_open_rate: 0.2551,
    human_click_rate: 0.051,
    bot_signatures_applied: ["Apple Mail Privacy Protection"],
  };
}

describe("hasHumanEngagement", () => {
  it("is FALSE when the fields are present but all zero (flag off)", () => {
    // The regression this module exists for: `typeof x === "number"` is always
    // true on the wire, so a presence check reports human data that isn't there.
    expect(hasHumanEngagement(flagOffReport())).toBe(false);
  });

  it("is true when the server names the signatures it stripped", () => {
    expect(hasHumanEngagement(flagOnReport())).toBe(true);
  });

  it("is true on a stripped count even with no signature list", () => {
    expect(
      hasHumanEngagement({ ...flagOffReport(), human_unique_opens: 12 }),
    ).toBe(true);
  });

  it("tolerates a malformed bot_signatures_applied", () => {
    const bad = {
      ...flagOffReport(),
      bot_signatures_applied: "Apple MPP",
    } as unknown as CampaignReport;
    expect(hasHumanEngagement(bad)).toBe(false);
  });

  it("is false for a missing report", () => {
    expect(hasHumanEngagement(null)).toBe(false);
    expect(hasHumanEngagement(undefined)).toBe(false);
  });
});

describe("effectiveEngagementMode", () => {
  it("degrades a human preference to raw when there is no human data", () => {
    expect(effectiveEngagementMode(flagOffReport(), "human")).toBe("raw");
  });

  it("honours a human preference when the server stripped something", () => {
    expect(effectiveEngagementMode(flagOnReport(), "human")).toBe("human");
  });

  it("never promotes raw to human", () => {
    expect(effectiveEngagementMode(flagOnReport(), "raw")).toBe("raw");
  });
});

describe("engagementFigures", () => {
  it("NEVER reports 0% for a campaign with real opens when the flag is off", () => {
    const report = flagOffReport();
    const mode = effectiveEngagementMode(report, "human");
    const figures = engagementFigures(report, mode);
    expect(figures.openRate).toBeCloseTo(0.4183, 4);
    expect(figures.clickRate).toBeCloseTo(0.0622, 4);
    expect(figures.uniqueOpens).toBe(410);
    expect(figures.uniqueClicks).toBe(61);
  });

  it("uses the stripped figures when they exist", () => {
    const report = flagOnReport();
    const figures = engagementFigures(
      report,
      effectiveEngagementMode(report, "human"),
    );
    expect(figures.openRate).toBeCloseTo(0.2551, 4);
    expect(figures.uniqueOpens).toBe(250);
  });

  it("raw mode always reads the raw fields", () => {
    const figures = engagementFigures(flagOnReport(), "raw");
    expect(figures.openRate).toBeCloseTo(0.4183, 4);
    expect(figures.uniqueOpens).toBe(410);
  });

  it("falls back per-field for an older gateway that omits one", () => {
    const partial = { ...flagOnReport() };
    delete (partial as { human_click_rate?: number }).human_click_rate;
    const figures = engagementFigures(partial, "human");
    expect(figures.clickRate).toBeCloseTo(0.0622, 4);
    expect(figures.openRate).toBeCloseTo(0.2551, 4);
  });

  it("returns all-undefined for a missing report so tiles render a dash", () => {
    expect(engagementFigures(null, "human")).toEqual({
      opens: undefined,
      uniqueOpens: undefined,
      uniqueClicks: undefined,
      openRate: undefined,
      clickRate: undefined,
      clickToOpenRate: undefined,
    });
  });
});

describe("reportRates", () => {
  it("returns the three rates the phone never rendered", () => {
    const report = flagOffReport();
    const rates = reportRates(report, engagementFigures(report, "raw"));
    expect(rates).toEqual({
      clickToOpen: 0.1487,
      bounce: 0.02,
      unsub: 0.004,
    });
  });

  it("reads the HUMAN click-to-open against the human denominator", () => {
    const report = { ...flagOnReport(), human_click_to_open_rate: 0.2 };
    const rates = reportRates(report, engagementFigures(report, "human"));
    expect(rates.clickToOpen).toBe(0.2);
  });

  it("says 'not computable' rather than 0% when nobody opened", () => {
    // The Go builder guards `click_to_open_rate` on unique_opens > 0 and
    // leaves the field at its zero value otherwise, so a wire 0 here means
    // "no denominator", not "of the openers, none clicked".
    const report = {
      ...flagOffReport(),
      unique_opens: 0,
      click_to_open_rate: 0,
    };
    expect(reportRates(report, engagementFigures(report, "raw")).clickToOpen)
      .toBeNull();
  });

  it("blanks bounce rate for a campaign that never sent", () => {
    const report = { ...flagOffReport(), sent: 0, bounce_rate: 0 };
    expect(reportRates(report, engagementFigures(report, "raw")).bounce)
      .toBeNull();
  });

  it("keeps the unsubscribe rate on a legacy path that reports no delivered", () => {
    // analytics.go falls back to `sent` when `delivered` is absent; treating
    // that as a zero denominator would blank the rate for every such campaign.
    const report = { ...flagOffReport(), delivered: 0 };
    expect(reportRates(report, engagementFigures(report, "raw")).unsub)
      .toBe(0.004);
  });

  it("blanks the unsubscribe rate when nothing was delivered OR sent", () => {
    const report = { ...flagOffReport(), delivered: 0, sent: 0, unsub_rate: 0 };
    expect(reportRates(report, engagementFigures(report, "raw")).unsub)
      .toBeNull();
  });

  it("returns three nulls for no report at all", () => {
    expect(reportRates(null, engagementFigures(null, "raw"))).toEqual({
      clickToOpen: null,
      bounce: null,
      unsub: null,
    });
  });
});

describe("engagementCaption", () => {
  it("names how many signatures were applied", () => {
    expect(engagementCaption(flagOnReport(), "human")).toContain(
      "1 signature applied",
    );
  });

  it("pluralises correctly", () => {
    const two = {
      ...flagOnReport(),
      bot_signatures_applied: ["Apple MPP", "Google Image Proxy"],
    };
    expect(engagementCaption(two, "human")).toContain("2 signatures applied");
  });

  it("says what raw includes", () => {
    expect(engagementCaption(flagOnReport(), "raw")).toContain(
      "Apple Mail Privacy Protection",
    );
  });
});
