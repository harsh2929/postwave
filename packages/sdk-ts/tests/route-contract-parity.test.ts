import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("newly documented route contracts", () => {
  it("routes list membership, transform-rule, and upload-status calls", async () => {
    const seen: Array<{ method?: string; url: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        method: init?.method,
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("for-subscriber")) return json({ items: [], count: 0 });
      if (url.includes("/uploads/")) {
        return json({
          upload_id: "upload/1",
          received: 512,
          total: 1024,
          updated_at: "2026-07-14T08:15:30Z",
        });
      }
      if (init?.method === "DELETE") return json({ ok: true });
      if (init?.method === "POST") {
        return json({
          id: "rule/1",
          name: "country",
          source_path: "country",
          target_key: "country_code",
          transform: "uppercase",
          status: "active",
        });
      }
      return json({ items: [], total: 0 });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.lists.forSubscriber("subscriber/1");
    await pw.subscribers.transformRules();
    await pw.subscribers.upsertTransformRule({
      name: "country",
      source_path: "country",
      target_key: "country_code",
      transform: "uppercase",
    });
    await pw.subscribers.deleteTransformRule("rule/1");
    await pw.migrations.uploadStatus("csv", "upload/1");

    expect(seen).toEqual([
      {
        method: "GET",
        url: "https://api.moosewave.com/api/v1/lists/for-subscriber/subscriber%2F1",
        body: undefined,
      },
      {
        method: "GET",
        url: "https://api.moosewave.com/api/v1/profile-transform-rules",
        body: undefined,
      },
      {
        method: "POST",
        url: "https://api.moosewave.com/api/v1/profile-transform-rules",
        body: {
          name: "country",
          source_path: "country",
          target_key: "country_code",
          transform: "uppercase",
        },
      },
      {
        method: "DELETE",
        url: "https://api.moosewave.com/api/v1/profile-transform-rules/rule%2F1",
        body: undefined,
      },
      {
        method: "GET",
        url: "https://api.moosewave.com/api/v1/migrations/csv/uploads/upload%2F1",
        body: undefined,
      },
    ]);
  });

  it("rejects empty path identifiers before transport", () => {
    const fetch = vi.fn();
    const pw = new PostwaveClient({ apiKey: "k", fetch });

    expect(() => pw.lists.forSubscriber(" ")).toThrow(/Subscriber ID/);
    expect(() => pw.subscribers.deleteTransformRule(" ")).toThrow(
      /transform rule ID/,
    );
    expect(() => pw.migrations.uploadStatus("csv", " ")).toThrow(/upload ID/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
