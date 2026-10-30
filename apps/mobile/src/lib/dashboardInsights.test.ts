import { describe, expect, it } from "vitest";

import {
  COUNT_FLOOR,
  MAX_INSIGHTS,
  RATE_ABSOLUTE_GATE,
  RATE_RELATIVE_GATE,
  dashboardInsights,
  type InsightInput,
} from "./dashboardInsights";

const STEADY: InsightInput = {
  rangeLabel: "Last 30 days",
  openRate: 0.24,
  previousOpenRate: 0.24,
  clickRate: 0.031,
  previousClickRate: 0.031,
  bounceRate: 0.008,
  previousBounceRate: 0.008,
  subscribersDelta: 120,
  previousSubscribersDelta: 120,
  campaignsSent: 4,
  previousCampaignsSent: 4,
};

describe("saying nothing", () => {
  it("returns nothing for a steady workspace", () => {
    expect(dashboardInsights(STEADY)).toEqual([]);
  });

  it("returns nothing when the previous window is absent", () => {
    expect(
      dashboardInsights({
        ...STEADY,
        previousOpenRate: null,
        previousClickRate: null,
        previousBounceRate: null,
        previousSubscribersDelta: null,
        previousCampaignsSent: null,
      }),
    ).toEqual([]);
  });

  it("ignores a relatively large move that is absolutely tiny", () => {
    // 0.1% → 0.2% is +100% relative and 0.1pp absolute. Reporting it as
    // "click rate doubled" would be true and useless.
    expect(
      dashboardInsights({
        ...STEADY,
        clickRate: 0.002,
        previousClickRate: 0.001,
      }),
    ).toEqual([]);
    expect(RATE_ABSOLUTE_GATE).toBeGreaterThan(0.001);
  });

  it("ignores an absolutely large move that is relatively tiny", () => {
    // A 0.6pp move on a 24% base is 2.5% relative — ordinary drift.
    expect(
      dashboardInsights({ ...STEADY, openRate: 0.246, previousOpenRate: 0.24 }),
    ).toEqual([]);
    expect(RATE_RELATIVE_GATE).toBeGreaterThan(0.025);
  });

  it("ignores a count ratio taken over a trivially small previous window", () => {
    expect(
      dashboardInsights({
        ...STEADY,
        campaignsSent: 2,
        previousCampaignsSent: COUNT_FLOOR - 1,
      }),
    ).toEqual([]);
  });
});

describe("what it reports", () => {
  it("leads with a bounce rise even when a bigger open rise is present", () => {
    const insights = dashboardInsights({
      ...STEADY,
      bounceRate: 0.02,
      previousBounceRate: 0.008,
      openRate: 0.4,
      previousOpenRate: 0.24,
    });
    expect(insights[0]?.id).toBe("bounce");
    expect(insights[0]?.tone).toBe("negative");
    expect(insights[0]?.text).toContain("2.0%");
  });

  it("colours a bounce IMPROVEMENT positive, not by arrow direction", () => {
    const insights = dashboardInsights({
      ...STEADY,
      bounceRate: 0.002,
      previousBounceRate: 0.02,
    });
    expect(insights[0]?.tone).toBe("positive");
    expect(insights[0]?.text).toContain("improved");
  });

  it("never colours send volume as a win or a loss", () => {
    const insights = dashboardInsights({
      ...STEADY,
      campaignsSent: 12,
      previousCampaignsSent: 4,
    });
    expect(insights).toHaveLength(1);
    expect(insights[0]?.id).toBe("volume");
    expect(insights[0]?.tone).toBe("neutral");
  });

  it("carries the privacy caveat with any open-rate claim", () => {
    const insights = dashboardInsights({
      ...STEADY,
      openRate: 0.4,
      previousOpenRate: 0.24,
    });
    expect(insights[0]?.text).toContain("Apple Mail privacy inflates opens");
  });

  it("caps the strip so it stays a glance", () => {
    const insights = dashboardInsights({
      rangeLabel: "Last 7 days",
      openRate: 0.4,
      previousOpenRate: 0.2,
      clickRate: 0.06,
      previousClickRate: 0.03,
      bounceRate: 0.02,
      previousBounceRate: 0.008,
      subscribersDelta: 400,
      previousSubscribersDelta: 100,
      campaignsSent: 12,
      previousCampaignsSent: 4,
    });
    expect(insights).toHaveLength(MAX_INSIGHTS);
    expect(insights.map((row) => row.id)).toEqual(["bounce", "click", "open"]);
  });
});
