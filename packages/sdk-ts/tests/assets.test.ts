import { describe, expect, it, vi } from "vitest";
import { PostwaveClient } from "../src/index.js";

describe("AssetsResource wire contract", () => {
  it("covers the public asset lifecycle and serializes exact fields", async () => {
    const seen: Array<{ method: string; url: string; body?: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/usage")) {
        return new Response(JSON.stringify({ usage: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("?")) {
        return new Response(
          JSON.stringify({
            items: [],
            counts: { all: 0, recent: 0, inUse: 0, unused: 0, large: 0 },
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ id: "asset-1", altText: "Logo" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ asset: { id: "asset-1" }, usage: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });

    await client.assets.list({
      limit: 25,
      before: "00000000-0000-4000-8000-000000000001",
      q: "logo",
      sort: "most-used",
      filter: "in-use",
      tag: "brand",
      folder_id: "root",
    });
    await client.assets.get("asset/1");
    await client.assets.update("asset/1", "Logo");
    await client.assets.usage("asset/1");
    await client.assets.delete("asset/1", { force: true });

    expect(seen[0]!.url).toContain("/api/v1/assets?");
    for (const pair of [
      "limit=25",
      "q=logo",
      "sort=most-used",
      "filter=in-use",
      "tag=brand",
      "folder_id=root",
    ]) {
      expect(seen[0]!.url).toContain(pair);
    }
    expect(seen[1]).toMatchObject({ method: "GET" });
    expect(seen[1]!.url).toMatch(/\/api\/v1\/assets\/asset%2F1$/u);
    expect(seen[2]).toMatchObject({ method: "PATCH", body: '{"alt_text":"Logo"}' });
    expect(seen[3]!.url).toMatch(/\/api\/v1\/assets\/asset%2F1\/usage$/u);
    expect(seen[4]).toMatchObject({ method: "DELETE" });
    expect(seen[4]!.url).toMatch(/\/api\/v1\/assets\/asset%2F1\?force=true$/u);
  });
});
