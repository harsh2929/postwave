// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  parseCampaignRevenueAttribution,
  parseCampaignRevenueTimeseries,
  parseSubscriberLifecycleFunnel,
} from "@/lib/analytics-api";

const CAMPAIGN_ID = "018f0000-0000-7000-8000-000000000001";

function funnelFixture() {
  return {
    bucket: "month",
    cohort_by: "created_at_month",
    steps: [
      {
        stage: "signup",
        label: "Signed Up",
        count: 10,
        conversion_rate: 100,
      },
      {
        stage: "first_purchase",
        label: "First Purchase",
        count: 4,
        conversion_rate: 40,
      },
      {
        stage: "repeat_purchase",
        label: "Repeat Purchase",
        count: 2,
        conversion_rate: 50,
      },
    ],
    cohorts: [
      {
        cohort_label: "2026-08",
        signup_count: 6,
        first_purchase_count: 3,
        repeat_purchase_count: 1,
        first_purchase_rate: 50,
        repeat_purchase_rate: 33.3,
      },
      {
        cohort_label: "2026-07",
        signup_count: 4,
        first_purchase_count: 1,
        repeat_purchase_count: 1,
        first_purchase_rate: 25,
        repeat_purchase_rate: 100,
      },
    ],
  };
}

function attributionFixture() {
  return {
    items: [
      {
        campaign_id: CAMPAIGN_ID,
        campaign_name: "Launch",
        conversions: 2,
        revenue_cents: 1000,
        emails_sent: 100,
        revenue_per_send_cents: 10,
        operator_email: "must-not-enter-state@example.test",
      },
    ],
    provenance: {
      explicit: 1,
      last_touch: 1,
      none: 1,
      code_redemption: 0,
      campaign_vanity_path: 0,
      unclassified: 0,
    },
    total_revenue_cents: 1500,
    unattributed_cents: 500,
    unattributed_conversions: 1,
    currency: "USD",
    currencies: [{ currency: "USD", conversions: 3, revenue_cents: 1500 }],
    total_campaigns: 1,
    days: 30,
  };
}

describe("subscriber lifecycle funnel contract", () => {
  it("accepts a reconciled three-stage cohort response", () => {
    expect(parseSubscriberLifecycleFunnel(funnelFixture())).toMatchObject({
      steps: [
        { stage: "signup", count: 10 },
        { stage: "first_purchase", count: 4 },
        { stage: "repeat_purchase", count: 2 },
      ],
    });
  });

  it("rejects impossible hierarchy and aggregate/cohort drift", () => {
    const impossible = funnelFixture();
    impossible.cohorts[0]!.repeat_purchase_count = 4;
    expect(() => parseSubscriberLifecycleFunnel(impossible)).toThrow(
      /hierarchy/i,
    );

    const drifted = funnelFixture();
    drifted.steps[0]!.count = 11;
    expect(() => parseSubscriberLifecycleFunnel(drifted)).toThrow(/reconcile/i);
  });
});

describe("campaign revenue attribution contract", () => {
  it("reconciles totals/provenance and strips unknown identity fields", () => {
    const parsed = parseCampaignRevenueAttribution(attributionFixture(), 30);
    expect(parsed.total_revenue_cents).toBe(1500);
    expect(parsed.items[0]).toEqual({
      campaign_id: CAMPAIGN_ID,
      campaign_name: "Launch",
      conversions: 2,
      revenue_cents: 1000,
      emails_sent: 100,
      revenue_per_send_cents: 10,
    });
    expect(JSON.stringify(parsed)).not.toContain("operator_email");
  });

  it("rejects provenance, currency, and monetary total drift", () => {
    const provenance = attributionFixture();
    provenance.provenance.explicit = 2;
    expect(() => parseCampaignRevenueAttribution(provenance, 30)).toThrow(
      /provenance/i,
    );

    const money = attributionFixture();
    money.total_revenue_cents = 1600;
    expect(() => parseCampaignRevenueAttribution(money, 30)).toThrow(
      /reconcile/i,
    );
  });

  it("reconciles code-redemption and campaign vanity-path linkage", () => {
    const linked = attributionFixture();
    linked.provenance.explicit = 0;
    linked.provenance.last_touch = 0;
    linked.provenance.code_redemption = 1;
    linked.provenance.campaign_vanity_path = 1;

    expect(parseCampaignRevenueAttribution(linked, 30).provenance).toMatchObject(
      {
        code_redemption: 1,
        campaign_vanity_path: 1,
      },
    );
  });
});

describe("campaign revenue timeseries contract", () => {
  it("requires the exact window, ordered dates, and campaign identity", () => {
    const parsed = parseCampaignRevenueTimeseries(
      {
        points: [
          { date: "2026-08-29", revenue_cents: -50, conversions: 1 },
          { date: "2026-08-30", revenue_cents: 250, conversions: 2 },
        ],
        currency: "USD",
        currencies: [{ currency: "USD", conversions: 3, revenue_cents: 200 }],
        days: 2,
        campaign_id: CAMPAIGN_ID,
      },
      { days: 2, campaignId: CAMPAIGN_ID },
    );
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[0]?.revenue_cents).toBe(-50);

    expect(() =>
      parseCampaignRevenueTimeseries(
        {
          ...parsed,
          points: [...parsed.points].reverse(),
        },
        { days: 2, campaignId: CAMPAIGN_ID },
      ),
    ).toThrow(/date sequence/i);
  });
});
