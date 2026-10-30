// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { mockGetAB, mockListVariants } from "@/lib/abtests-mocks";
import { mockCreateCampaignABTest } from "@/lib/campaigns-mocks";

describe("campaign A/B demo integration", () => {
  it("opens a newly-created parent with its generated subjects and empty results", async () => {
    const created = await mockCreateCampaignABTest({
      name: "August launch",
      subject_variants: ["First idea", "Second idea", "Third idea"],
      audience_segment_id: "segment-demo",
      body_html: "<p>Draft body</p>",
    });

    const view = mockGetAB(created.parent.id);
    expect(view.settings.campaign_id).toBe(created.parent.id);
    expect(view.variants.map((variant) => variant.subject)).toEqual([
      "First idea",
      "Second idea",
      "Third idea",
    ]);
    expect(view.variants.map((variant) => variant.campaign_id)).toEqual([
      created.parent.id,
      created.parent.id,
      created.parent.id,
    ]);
    expect(view.results).toEqual([]);
    expect(mockListVariants(created.parent.id)).toEqual(view.variants);
  });
});
