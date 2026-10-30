import { describe, expect, it } from "vitest";

import { parseSegmentPnl } from "../../components/segments/segment-pnl-contract";

const payload = {
  segment_id: "segment-1",
  member_count: 10,
  window_days: 90,
  currency: "USD",
  currencies: [{ currency: "USD", conversions: 2, revenue_cents: 2000 }],
  revenue_cents: 2000,
  revenue_conversions: 2,
  revenue_scope: "member_all_sources",
  revenue_provenance: {
    explicit: 1,
    last_touch: 1,
    none: 0,
    code_redemption: 1,
    campaign_vanity_path: 1,
    unclassified: 0,
  },
  aov_cents: 1000,
  aov_order_count: 2,
  aov_currency: "USD",
  clv_members_scored: 10,
  clv_historic_sum_cents: 10000,
  clv_predicted_sum_cents: 12000,
  clv_realised_vs_predicted: 0.83,
  unsub_count: 0,
  complaint_count: 0,
  total_cost_cents: 0,
  cost_currency: "USD",
  cost_config_present: true,
  net_contribution_cents: 2000,
  net_contribution_per_member_cents: 200,
  lift: null,
  sequence_attribution_unsupported: true,
  cross_currency_revenue_excluded: false,
  generated_at: "2026-07-14T00:00:00.000Z",
};

describe("segment P&L runtime contract", () => {
  it("accepts a complete finite payload", () => {
    expect(parseSegmentPnl(payload)).toEqual(payload);
  });

  it("rejects missing nested provenance and non-finite metrics", () => {
    expect(parseSegmentPnl({})).toBeNull();
    expect(parseSegmentPnl({ ...payload, revenue_provenance: undefined })).toBeNull();
    expect(parseSegmentPnl({ ...payload, revenue_cents: Number.NaN })).toBeNull();
  });
});
