import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AIComposeResource", () => {
  it("routes compose calls to the first-party ai endpoints", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return json({
        primary: { subject: "Hello", body: "<p>hi</p>" },
        subject_variants: ["Hello", "Hey"],
        generated_at: "2026-06-22T00:00:00Z",
      });
    });
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    await pw.aiCompose.composeBroadcast({
      brief: "announce our pricing change",
      variant_count: 3,
      tone: "formal",
      audience: "paid annual subscribers",
    });
    await pw.aiCompose.composeVariants({
      subject: "Hello",
      body: "<p>hi</p>",
      variant_count: 4,
    });

    expect(seen).toEqual([
      {
        url: "https://api.moosewave.com/api/v1/ai/compose/broadcast",
        method: "POST",
        body: {
          brief: "announce our pricing change",
          variant_count: 3,
          tone: "formal",
          audience: "paid annual subscribers",
        },
      },
      {
        url: "https://api.moosewave.com/api/v1/ai/compose/variants",
        method: "POST",
        body: {
          subject: "Hello",
          body: "<p>hi</p>",
          variant_count: 4,
        },
      },
    ]);
  });
});
