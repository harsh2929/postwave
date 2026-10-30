import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "camp_1",
    tenant_id: "t",
    name: "Spring sale",
    subject: "Hello",
    status: "paused",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    ...overrides,
  };
}

describe("CampaignsResource lifecycle", () => {
  it("pauses a campaign via POST /pause and returns the campaign", async () => {
    const fetch = vi.fn(async () => json(campaign({ status: "paused" })));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    const result = await pw.campaigns.pause("camp_1");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaigns/camp_1/pause",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("paused");
  });

  it("resumes a campaign via POST /resume", async () => {
    const fetch = vi.fn(async () => json(campaign({ status: "sending" })));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    const result = await pw.campaigns.resume("camp_1");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaigns/camp_1/resume",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("sending");
  });

  it("cancels a campaign via POST /cancel", async () => {
    const fetch = vi.fn(async () => json(campaign({ status: "cancelled" })));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    const result = await pw.campaigns.cancel("camp_1");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaigns/camp_1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("cancelled");
  });

  it("URL-encodes the campaign id in lifecycle paths", async () => {
    const fetch = vi.fn(async () => json(campaign()));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.campaigns.pause("camp/a b");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/campaigns/camp%2Fa%20b/pause",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
