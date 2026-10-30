import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AudienceSyncsResource", () => {
  it("routes sync lifecycle and run-history calls to first-party endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        id: "sync/1",
        sync_id: "sync/1",
        name: "Ads sync",
        source: { list_id: "list_123" },
        destination: { type: "google_ads", config: {} },
        schedule: "manual",
        enabled: true,
        status: "succeeded",
        rows_exported: 42,
        batches_sent: 1,
        started_at: "2026-06-29T00:00:00Z",
        excluded_count: 3,
        items: [],
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.audienceSyncs.list();
    await pw.audienceSyncs.create({
      name: "Ads sync",
      source: { list_id: "list_123" },
      destination: {
        type: "google_ads",
        config: { customer_match_transport: "data_manager" },
      },
      schedule: "manual",
    });
    await pw.audienceSyncs.get("sync/1");
    await pw.audienceSyncs.update("sync/1", { enabled: false });
    const run = await pw.audienceSyncs.run("sync/1");
    await pw.audienceSyncs.runs("sync/1");
    await pw.audienceSyncs.delete("sync/1");

    expect(run.excluded_count).toBe(3);
    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs",
        method: "POST",
        body: {
          name: "Ads sync",
          source: { list_id: "list_123" },
          destination: {
            type: "google_ads",
            config: { customer_match_transport: "data_manager" },
          },
          schedule: "manual",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs/sync%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs/sync%2F1",
        method: "PATCH",
        body: { enabled: false },
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs/sync%2F1/run",
        method: "POST",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs/sync%2F1/runs",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audience-syncs/sync%2F1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("guards empty sync identifiers before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    expect(() => pw.audienceSyncs.get(" ")).toThrow(
      /audience sync id is required/,
    );
    expect(() => pw.audienceSyncs.runs("")).toThrow(
      /audience sync id is required/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
