import { describe, expect, it, vi } from "vitest";
import { OUTBOUND_WEBHOOK_EVENT_TYPES, PostwaveClient } from "../src/index.js";

const CANONICAL_OUTBOUND_EVENTS = [
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  "subscriber.unsubscribed",
  "approval.requested",
  "approval.decided",
  "audit.created",
  "bounce.received",
  "list_health.degraded",
  "list.subscriber.added",
  "email.bounced",
  "email.complained",
  "email.delivered",
  "assurance.run.completed",
  "assurance.run.blocked",
] as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("canonical webhook resource contracts", () => {
  it("exports the complete canonical outbound event vocabulary", () => {
    expect(OUTBOUND_WEBHOOK_EVENT_TYPES).toEqual(CANONICAL_OUTBOUND_EVENTS);
    expect(OUTBOUND_WEBHOOK_EVENT_TYPES).not.toContain("subscriber.created");
  });

  it("uses outbound routes, preserves write-only auth, and forwards replay idempotency", async () => {
    const seen: Array<{
      method: string;
      url: string;
      body?: string;
      key?: string;
    }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const headers = init?.headers as Record<string, string>;
      seen.push({
        method,
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
        key: headers?.["Idempotency-Key"],
      });
      if (url.includes("/deliveries/") && url.endsWith("/replay")) {
        return json(
          {
            delivery_id: "child",
            replayed_from: "parent",
            status: "pending",
            replayed_at: "2026-07-23T00:00:00Z",
          },
          202,
        );
      }
      if (method === "POST") {
        return json(
          {
            webhook: {
              id: "wh_1",
              tenant_id: "tenant",
              url: "https://receiver.example/hook",
              events: ["list.subscriber.added"],
              active: true,
              created_at: "2026-07-23T00:00:00Z",
              updated_at: "2026-07-23T00:00:00Z",
              consecutive_failures: 0,
              signing_algorithm: "hmac_sha256",
              auth_config: {
                type: "bearer",
                bearer_configured: true,
                secret_redacted: true,
              },
              auth_config_status: "ready",
            },
            signing_secret: "owhsec_once",
          },
          201,
        );
      }
      return json({ webhooks: [], next_cursor: null });
    });
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });

    await client.webhooks.list({ limit: 25, cursor: "next" });
    const created = await client.webhooks.create({
      url: "https://receiver.example/hook",
      events: ["list.subscriber.added"],
      auth_config: { type: "bearer", bearer_token: "write-only" },
    });
    await client.webhooks.replay("delivery/1", "stable-replay-key");

    expect(seen[0]!.url).toContain("/api/v1/outbound-webhooks?");
    expect(seen[1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"bearer_token":"write-only"'),
    });
    expect(created.webhook.auth_config).toEqual({
      type: "bearer",
      bearer_configured: true,
      secret_redacted: true,
    });
    expect(JSON.stringify(created.webhook)).not.toContain("write-only");
    expect(seen[2]!.url).toMatch(
      /\/api\/v1\/outbound-webhooks\/deliveries\/delivery%2F1\/replay$/u,
    );
    expect(seen[2]!.key).toBe("stable-replay-key");
  });

  it("covers endpoint, event, replay, transform, and trigger inbound routes", async () => {
    const seen: Array<{ method: string; url: string; key?: string }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? "GET",
        url,
        key: (init?.headers as Record<string, string>)?.["Idempotency-Key"],
      });
      return json(
        { items: [], ok: true, queued: true, replay_id: "replay", matches: [] },
        200,
      );
    });
    const client = new PostwaveClient({ apiKey: "test", fetch, retries: 0 });

    await client.inboundWebhooks.get("in/1");
    await client.inboundWebhooks.events("in/1", { limit: 50, cursor: "next" });
    await client.inboundWebhooks.replay("in/1", 42, "stable-inbound-replay");
    await client.inboundWebhooks.triggers("in/1");
    await client.inboundWebhooks.createTrigger("in/1", {
      name: "VIP",
      match_jsonpath: "$.plan",
      match_operator: "equals",
      match_value: "vip",
      email_jsonpath: "$.email",
      action_type: "add_tag",
      action_target_id: "vip",
    });
    await client.inboundWebhooks.previewTransform(".payload", {
      payload: { email: "a@b.co" },
    });

    expect(seen[0]!.url).toMatch(/\/api\/v1\/inbound-webhooks\/in%2F1$/u);
    expect(seen[1]!.url).toContain("/events?");
    expect(seen[2]).toMatchObject({
      method: "POST",
      key: "stable-inbound-replay",
    });
    expect(seen[2]!.url).toContain("/events/42/replay");
    expect(seen[3]!.url).toContain("/triggers");
    expect(seen[4]).toMatchObject({ method: "POST" });
    expect(seen[5]!.url).toContain("/inbound-webhooks/transform/preview");
  });
});
