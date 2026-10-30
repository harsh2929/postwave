import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("TagsResource", () => {
  it("shapes filters, complete writes, and conditional updates", async () => {
    const seen: Array<{
      url: string;
      method?: string;
      body?: unknown;
      ifMatch?: string | null;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        ifMatch: new Headers(init?.headers).get("If-Match"),
      });
      return json({
        id: "tag/1",
        name: "VIP",
        description: "High-value customers",
        created_at: "2026-07-19T00:00:00Z",
        updated_at: "2026-07-19T00:00:00Z",
        pii: true,
        version: 7,
        etag: '"tag-7"',
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.tags.list({
      query: "vip customer",
      groupId: "group/1",
      includeArchived: true,
    });
    await pw.tags.create({
      name: "VIP",
      color: "#112233",
      description: "High-value customers",
      group_id: "group_1",
      pii: true,
    });
    await pw.tags.create("Legacy-compatible");
    await pw.tags.update(
      "tag/1",
      { color: "", group_id: "", pii: false },
      '"tag-7"',
    );

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/tags?query=vip+customer&group_id=group%2F1&include_archived=true",
        method: "GET",
        body: undefined,
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/tags",
        method: "POST",
        body: {
          name: "VIP",
          color: "#112233",
          description: "High-value customers",
          group_id: "group_1",
          pii: true,
        },
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/tags",
        method: "POST",
        body: { name: "Legacy-compatible" },
        ifMatch: null,
      },
      {
        url: "https://api.moosewave.com/api/v1/tags/tag%2F1",
        method: "PATCH",
        body: { color: "", group_id: "", pii: false },
        ifMatch: '"tag-7"',
      },
    ]);
  });
});
