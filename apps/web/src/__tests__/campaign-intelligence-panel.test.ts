// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_PANEL_LIMITS,
  previewItems,
} from "@/components/mailchimp-parity/campaign-intelligence-panel";

describe("CampaignIntelligencePanel helpers", () => {
  it("limits campaign preview collections without mutating the source", () => {
    const tasks = Array.from({ length: CAMPAIGN_PANEL_LIMITS.tasks + 2 }, (_, index) => ({
      id: `task-${index}`,
    }));

    expect(previewItems(tasks, CAMPAIGN_PANEL_LIMITS.tasks)).toEqual(tasks.slice(0, 5));
    expect(tasks).toHaveLength(7);
  });

  it("returns an empty preview for missing optional collections", () => {
    expect(previewItems(undefined, CAMPAIGN_PANEL_LIMITS.links)).toEqual([]);
  });
});
