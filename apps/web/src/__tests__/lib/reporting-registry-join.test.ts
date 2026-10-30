// SPDX-License-Identifier: AGPL-3.0-only
//
// Pins the join that matters: blocked entries attach to metrics by KEY, never
// by product_area. The area join is the tempting one and it is wrong — it
// marks supported metrics as unable to report.

import { describe, expect, it } from "vitest";

import {
  blockFor,
  unavailableMetrics,
  type BlockedProduct,
  type RegisteredMetric,
} from "@/lib/reporting-registry-api";

const metric = (o: Partial<RegisteredMetric>): RegisteredMetric => ({
  key: "campaign.sent",
  label: "Campaign sent",
  product_area: "campaign",
  source: "campaign_report_events",
  aggregation: "count",
  value_type: "number",
  runtime_status: "supported",
  dimensions: [],
  ...o,
});

// Shaped after the live response: the deliverability block names ONE metric,
// while three other deliverability-area metrics are supported.
const deliverabilityBlock: BlockedProduct = {
  product_area: "deliverability",
  initiative: "KLV-14-deliverability-routing-and-entitlements",
  blocked_note: "Provider / domain / country / client breakdowns require …",
  metrics: ["deliverability.provider_breakdown"],
  statuses: ["planned"],
};

const supportedInBlockedArea = metric({
  key: "campaign.bounce_rate",
  product_area: "deliverability",
  runtime_status: "supported",
});

const namedByBlock = metric({
  key: "deliverability.provider_breakdown",
  product_area: "deliverability",
  runtime_status: "planned",
});

describe("blocked-product join", () => {
  it("does not attach a block to a supported metric that merely shares the area", () => {
    expect(blockFor(supportedInBlockedArea.key, [deliverabilityBlock])).toBeNull();
  });

  it("attaches the block to the metric it actually names", () => {
    expect(blockFor(namedByBlock.key, [deliverabilityBlock])?.initiative).toBe(
      "KLV-14-deliverability-routing-and-entitlements",
    );
  });

  it("counts only the named metric as unavailable, not the whole area", () => {
    const all = [supportedInBlockedArea, namedByBlock];
    const out = unavailableMetrics(all, [deliverabilityBlock]);
    expect(out.map((m) => m.key)).toEqual(["deliverability.provider_breakdown"]);
  });

  it("keeps `partial` out of the unavailable set", () => {
    // A partial metric returns some data. Lumping it with `planned` loses the
    // difference between a number to read carefully and no number at all.
    const partial = metric({
      key: "flow.executions",
      product_area: "flow",
      runtime_status: "partial",
    });
    expect(unavailableMetrics([partial], [])).toEqual([]);
  });

  it("still treats a planned metric as unavailable with no block present", () => {
    const planned = metric({ key: "push.sent", runtime_status: "planned" });
    expect(unavailableMetrics([planned], []).map((m) => m.key)).toEqual([
      "push.sent",
    ]);
  });
});
