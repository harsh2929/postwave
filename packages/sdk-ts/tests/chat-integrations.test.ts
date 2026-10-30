import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ChatIntegrationsResource", () => {
  it("routes Slack, Discord, and Teams to first-party integration endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({ id: "chat/1", ok: true });
    });
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.chatIntegrations.slack.list();
    await pw.chatIntegrations.discord.create({
      url: "https://discord.com/api/webhooks/123/token",
      channel_hint: "#growth",
      events: ["subscriber.created"],
    });
    await pw.teamsIntegrations.update("teams/1", {
      enabled: false,
      events: ["campaign.sent"],
    });
    await pw.discordIntegrations.delete("discord/1");

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/integrations/slack",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/discord",
        method: "POST",
        body: {
          url: "https://discord.com/api/webhooks/123/token",
          channel_hint: "#growth",
          events: ["subscriber.created"],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/teams/teams%2F1",
        method: "PATCH",
        body: {
          enabled: false,
          events: ["campaign.sent"],
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/integrations/discord/discord%2F1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("selects channel resources by provider", () => {
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch: vi.fn(), retries: 0 });

    expect(pw.chatIntegrations.forProvider("slack").provider).toBe("slack");
    expect(pw.chatIntegrations.forProvider("discord").provider).toBe("discord");
    expect(pw.chatIntegrations.forProvider("teams").provider).toBe("teams");
  });
});
