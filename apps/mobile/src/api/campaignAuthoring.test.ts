/**
 * The online-only authoring writes: the PATCH passes its body through
 * UNTOUCHED (the delivery_settings replace is built upstream and must not be
 * reshaped here), and the freeze is a bare POST to the freeze route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { freezeCampaignAudience, patchCampaignAuthoring } from "./campaignAuthoring";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
});

describe("authoring transport", () => {
  it("PATCH /api/v1/campaigns/{id} with the body verbatim", async () => {
    const body = {
      audience_mode: "static",
      delivery_settings: { from_email: "a@b.com", rate_limit: 5 },
    };
    await patchCampaignAuthoring("c 1", body);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/campaigns/c%201",
      body,
    );
  });

  it("POST /api/v1/campaigns/{id}/audience/freeze", async () => {
    await freezeCampaignAudience("c1");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/campaigns/c1/audience/freeze",
    );
  });
});
