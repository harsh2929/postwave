// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));

import { createHoldout, deleteHoldout } from "@/lib/holdout-lift";

beforeEach(() => vi.clearAllMocks());

describe("holdout mutation transport", () => {
  it("never queues or automatically repeats experiment contract changes", async () => {
    mocks.post.mockResolvedValue({ campaign_id: "campaign-1" });
    await createHoldout("campaign-1", {
      percent: 10,
      conversionWindowDays: 7,
      minimumRelativeEffect: 0.05,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign-1/holdout",
      {
        percent: 10,
        conversion_window_days: 7,
        minimum_relative_effect: 0.05,
      },
      { requireOnline: true, maxAttempts: 1 },
    );

    mocks.delete.mockResolvedValue(undefined);
    await deleteHoldout("campaign-1");
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/campaigns/campaign-1/holdout",
      { requireOnline: true, maxAttempts: 1 },
    );
  });
});
