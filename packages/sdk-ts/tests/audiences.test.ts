import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AudiencesResource", () => {
  it("routes lookalike-audience lifecycle calls to first-party endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return json({
        id: "look/1",
        seed_segment_id: "seg_1",
        size_requested: 1000,
        member_count: 0,
        seed_count: 0,
        model_version: "v1",
        status: "ready",
        items: [],
        total: 0,
        page: 1,
        per_page: 100,
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.audiences.generate({
      name: "VIP lookalike",
      seed_segment_id: "seg_1",
      size: 2000,
      confidence_threshold: 0.7,
    });
    await pw.audiences.get("look/1");
    await pw.audiences.members("look/1", { page: 2, per_page: 50 });
    await pw.audiences.members("look/1");
    await pw.audiences.discard("look/1");

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/audiences/lookalike",
        method: "POST",
        body: {
          name: "VIP lookalike",
          seed_segment_id: "seg_1",
          size: 2000,
          confidence_threshold: 0.7,
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/audiences/lookalike/look%2F1",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audiences/lookalike/look%2F1/members?page=2&per_page=50",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audiences/lookalike/look%2F1/members",
        method: "GET",
        body: undefined,
      },
      {
        url: "https://api.moosewave.com/api/v1/audiences/lookalike/look%2F1",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("guards empty lookalike identifiers before fetch", async () => {
    const fetch = vi.fn(async () => json({}));
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    expect(() => pw.audiences.get(" ")).toThrow(/lookalike audience id is required/);
    expect(() => pw.audiences.discard(" ")).toThrow(/lookalike audience id is required/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
