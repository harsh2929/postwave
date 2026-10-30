// Tests for the appended-on outbound-webhooks + subscriber-timeline
// surface of the desktop api-client. We pin:
//
//   - listOutboundWebhooks returns the expected envelope shape
//   - createOutboundWebhook surfaces the one-time signing secret
//   - getSubscriberTimeline encodes its `before` cursor + limit
//
// Same fetch-mocking pattern as api-client.test.ts.

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error — minimal window for module load
  globalThis.window = {
    localStorage: stubLocalStorage,
    crypto: webcrypto as unknown as Crypto,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error — clean up
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import {
  api,
  apiRequest,
  apiInlineAi,
  analyticsIntegrationsApi,
  createOutboundWebhook,
  crmIntegrationsApi,
  deleteOutboundWebhook,
  getSubscriberTimeline,
  leadIntegrationsApi,
  listOutboundWebhookDeliveries,
  listOutboundWebhooks,
  listsMergeFieldsApi,
  loyaltyIntegrationsApi,
  reviewIntegrationsApi,
  replayOutboundWebhookDelivery,
  reEnableOutboundWebhook,
  rotateOutboundWebhookSigningMaterial,
  subscriptionIntegrationsApi,
  suppressionsConvergedApi,
  testOutboundWebhook,
  updateOutboundWebhook,
} from "../../lib/api-client";
import {
  clearOfflineStores,
  offlineQueueIdle,
  readOfflineQueue,
  setOfflineIdentity,
} from "../../lib/offline-store";

function makeMapLocalStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
}

function asymmetricCreateResponse(
  material: Record<string, unknown> = {
    public_key_pem: "PUBLIC VERIFICATION KEY",
  },
): Record<string, unknown> {
  return {
    webhook: {
      id: "hook_asymmetric",
      tenant_id: "t1",
      url: "https://example.com/asymmetric-hook",
      events: ["campaign.sent"],
      active: true,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
      config_version: 1,
      consecutive_failures: 0,
      signing_algorithm: "ecdsa_p256",
      signing_public_key: "PUBLIC VERIFICATION KEY",
      auth_config_status: "ready",
      url_status: "ready",
      delivery_policy_status: "ready",
    },
    ...material,
  };
}

function canonicalOutboundWebhook(id = "hook_1"): Record<string, unknown> {
  return {
    id,
    tenant_id: "t1",
    url: "https://example.com/…?…",
    events: ["campaign.sent"],
    active: true,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    config_version: 1,
    consecutive_failures: 0,
    signing_algorithm: "hmac_sha256",
    auth_config_status: "ready",
    url_status: "ready",
    delivery_policy_status: "ready",
  };
}

describe("listOutboundWebhooks", () => {
  it("returns the envelope shape `{ webhooks: [...] }` on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhooks: [
              {
                id: "hook_1",
                tenant_id: "t1",
                url: "https://example.com/…?…",
                url_status: "ready",
                events: ["campaign.sent"],
                active: true,
                created_at: "2026-04-01T00:00:00Z",
                updated_at: "2026-04-01T00:00:00Z",
                config_version: 1,
                consecutive_failures: 0,
                signing_algorithm: "hmac_sha256",
                auth_config_status: "ready",
                filter_expression: "event.type == campaign.sent",
                transform_template: { event_id: "/event/id" },
                delivery_policy_status: "ready",
              },
            ],
            next_cursor: "",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const r = await listOutboundWebhooks();
    expect(r.error).toBeUndefined();
    expect(r.data?.webhooks.length).toBe(1);
    expect(r.data?.webhooks[0].id).toBe("hook_1");
    expect(r.data?.webhooks[0].active).toBe(true);
    expect(r.data?.webhooks[0]).toMatchObject({
      url: "https://example.com/…?…",
      url_status: "ready",
      filter_expression: "event.type == campaign.sent",
      transform_template: { event_id: "/event/id" },
      delivery_policy_status: "ready",
    });
    expect(r.data?.next_cursor).toBe("");
  });

  it.each([
    "auth_config_status",
    "url_status",
    "delivery_policy_status",
  ] as const)("fails closed when normalized %s is omitted", async (field) => {
    const webhook: Record<string, unknown> = {
      id: "hook_missing_status",
      tenant_id: "t1",
      url: "https://example.com/…",
      events: ["campaign.sent"],
      active: true,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-01T00:00:00Z",
      config_version: 1,
      consecutive_failures: 0,
      signing_algorithm: "hmac_sha256",
      auth_config_status: "ready",
      url_status: "ready",
      delivery_policy_status: "ready",
    };
    delete webhook[field];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ webhooks: [webhook], next_cursor: "" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await listOutboundWebhooks();

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
    expect(result.error?.message).toContain(field);
  });

  it("accepts only value-free receiver-auth metadata and its migration state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhooks: [
              {
                id: "hook_auth",
                tenant_id: "t1",
                url: "https://example.com/authenticated-hook",
                events: ["campaign.sent"],
                active: true,
                created_at: "2026-04-01T00:00:00Z",
                updated_at: "2026-04-01T00:00:00Z",
                config_version: 1,
                consecutive_failures: 0,
                signing_algorithm: "hmac_sha256",
                auth_config: {
                  type: "combined",
                  bearer_configured: true,
                  header_names: ["X-Api-Key"],
                  mtls_configured: true,
                  secret_redacted: true,
                },
                auth_config_status: "ready",
                url_status: "ready",
                delivery_policy_status: "ready",
              },
            ],
            next_cursor: "",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await listOutboundWebhooks();

    expect(result.error).toBeUndefined();
    expect(result.data?.webhooks[0]).toMatchObject({
      auth_config: {
        type: "combined",
        bearer_configured: true,
        header_names: ["X-Api-Key"],
        mtls_configured: true,
        secret_redacted: true,
      },
      auth_config_status: "ready",
    });
  });

  it.each([
    ["bearer_token", "receiver-secret"],
    ["headers", { "X-Api-Key": "receiver-secret" }],
    ["mtls_key_pem", "PRIVATE KEY"],
  ])(
    "fails the list contract if a read response contains write-only %s",
    async (field, value) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          return new Response(
            JSON.stringify({
              webhooks: [
                {
                  id: "hook_leak",
                  tenant_id: "t1",
                  url: "https://example.com/hook",
                  events: ["campaign.sent"],
                  active: true,
                  created_at: "2026-04-01T00:00:00Z",
                  updated_at: "2026-04-01T00:00:00Z",
                  config_version: 1,
                  consecutive_failures: 0,
                  signing_algorithm: "hmac_sha256",
                  auth_config: { type: "combined", [field]: value },
                  auth_config_status: "ready",
                  url_status: "ready",
                  delivery_policy_status: "ready",
                },
              ],
              next_cursor: "",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
      );

      const result = await listOutboundWebhooks();

      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "outbound_webhook_contract",
      });
      expect(JSON.stringify(result)).not.toContain("receiver-secret");
    },
  );

  it("propagates a 5xx as an error envelope (no throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("upstream broken", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }),
    );
    const r = await listOutboundWebhooks();
    expect(r.error).toBeTruthy();
    expect(r.error?.status).toBe(503);
  });

  it("carries and forwards the server pagination cursor", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("limit=200");
      expect(url).toContain("cursor=opaque-page-2");
      return new Response(
        JSON.stringify({
          webhooks: [
            {
              id: "hook_page_2",
              tenant_id: "t1",
              url: "https://example.com/page-2",
              events: ["campaign.sent"],
              active: true,
              created_at: "2026-04-01T00:00:00Z",
              updated_at: "2026-04-01T00:00:00Z",
              config_version: 1,
              consecutive_failures: 0,
              signing_algorithm: "hmac_sha256",
              auth_config_status: "ready",
              url_status: "ready",
              delivery_policy_status: "ready",
            },
          ],
          next_cursor: "opaque-page-3",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listOutboundWebhooks({
      limit: 200,
      cursor: "opaque-page-2",
    });

    expect(result.data?.webhooks).toHaveLength(1);
    expect(result.data?.next_cursor).toBe("opaque-page-3");
  });

  it("blocks malformed list envelopes instead of manufacturing an empty list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ webhooks: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await listOutboundWebhooks();

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
    expect(result.error?.message).toContain(
      "No data was discarded or treated as empty",
    );
  });

  it.each([
    {
      label: "page field",
      payload: {
        webhooks: [canonicalOutboundWebhook("hook_unknown_page")],
        next_cursor: "",
        ignored: true,
      },
    },
    {
      label: "webhook field",
      payload: {
        webhooks: [
          {
            ...canonicalOutboundWebhook("hook_unknown_row"),
            ignored: true,
          },
        ],
        next_cursor: "",
      },
    },
  ])("rejects an unpublished outbound $label", async ({ payload }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await listOutboundWebhooks();

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
  });

  it("never exposes raw transport exception details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "connect failed https://api.example.test?token=pw_private_transport",
        );
      }),
    );

    const result = await listOutboundWebhooks();

    expect(result.error).toMatchObject({
      kind: "network",
      code: "network_error",
      message: "Network error. Check your connection and try again.",
    });
    expect(JSON.stringify(result)).not.toContain("pw_private_transport");
    expect(JSON.stringify(result)).not.toContain("api.example.test");
  });
});

describe("createOutboundWebhook — signing secret returned once", () => {
  it("includes signing_secret in the create response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
          "019c0000-0000-7000-8000-000000000201",
        );
        const body = JSON.parse(init.body as string) as {
          url: string;
          events: string[];
        };
        expect(body.url).toBe("https://example.com/hook");
        expect(body.events).toContain("campaign.sent");
        return new Response(
          JSON.stringify({
            webhook: {
              id: "hook_new",
              tenant_id: "t1",
              url: body.url,
              events: body.events,
              active: true,
              created_at: "2026-04-01T00:00:00Z",
              updated_at: "2026-04-01T00:00:00Z",
              config_version: 1,
              consecutive_failures: 0,
              signing_algorithm: "hmac_sha256",
              auth_config_status: "ready",
              url_status: "ready",
              delivery_policy_status: "ready",
            },
            signing_secret: "whsec_redacted_once",
          }),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const r = await createOutboundWebhook(
      {
        url: "https://example.com/hook",
        events: ["campaign.sent"],
      },
      { idempotencyKey: "019c0000-0000-7000-8000-000000000201" },
    );
    expect(r.error).toBeUndefined();
    expect(r.data?.signing_secret).toBe("whsec_redacted_once");
    expect(r.data?.webhook.id).toBe("hook_new");
  });

  it("returns only public verification material for asymmetric signing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(asymmetricCreateResponse()), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await createOutboundWebhook({
      url: "https://example.com/asymmetric-hook",
      events: ["campaign.sent"],
      algorithm: "ecdsa_p256",
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.public_key_pem).toBe("PUBLIC VERIFICATION KEY");
    expect(result.data).not.toHaveProperty("private_key_pem");
  });

  it("fails closed if an asymmetric response leaks private signing material", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify(
            asymmetricCreateResponse({
              public_key_pem: "PUBLIC VERIFICATION KEY",
              private_key_pem: "PRIVATE SIGNING KEY MUST NOT LEAVE SERVER",
            }),
          ),
          {
            status: 201,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await createOutboundWebhook({
      url: "https://example.com/asymmetric-hook",
      events: ["campaign.sent"],
      algorithm: "ecdsa_p256",
    });

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
    expect(result.error?.message).toContain(
      "private signing keys remain server-side",
    );
  });

  it("requires the asymmetric public verification material", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(asymmetricCreateResponse({})), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await createOutboundWebhook({
      url: "https://example.com/asymmetric-hook",
      events: ["campaign.sent"],
      algorithm: "ecdsa_p256",
    });

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
    expect(result.error?.message).toContain(
      "public_key_pem is required for asymmetric signing",
    );
  });
});

describe("canonical outbound test and delivery result decoding", () => {
  it("distinguishes permanent tombstone from reversible deactivation", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const soft = url.endsWith("?soft=1");
        return new Response(
          JSON.stringify({
            ok: true,
            deleted: !soft,
            deactivated: soft,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const permanent = await deleteOutboundWebhook("hook_1");
    const reversible = await deleteOutboundWebhook("hook_1", { soft: true });

    expect(permanent.data).toEqual({
      ok: true,
      deleted: true,
      deactivated: false,
    });
    expect(reversible.data).toEqual({
      ok: true,
      deleted: false,
      deactivated: true,
    });
    expect(urls[0]).not.toContain("soft=");
    expect(urls[1]).toContain("?soft=1");
  });

  it("fails closed on false, wrong-mode, or expanded mutation acknowledgements", async () => {
    const responses = [
      { ok: false, deleted: true, deactivated: false },
      { ok: true, deleted: true, deactivated: false },
      { ok: true, drift: "ignored" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const results = [
      await deleteOutboundWebhook("hook_1"),
      await deleteOutboundWebhook("hook_1", { soft: true }),
      await reEnableOutboundWebhook("hook_1"),
    ];

    for (const result of results) {
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "outbound_webhook_contract",
      });
    }
  });

  it("forwards a caller-stable identity for signing-material rotation", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("grace_minutes=60");
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
        "019c0000-0000-7000-8000-000000000202",
      );
      return new Response(
        JSON.stringify({
          webhook: canonicalOutboundWebhook("hook_1"),
          signing_secret: "pw_rotated_once",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await rotateOutboundWebhookSigningMaterial("hook_1", 60, {
      idempotencyKey: "019c0000-0000-7000-8000-000000000202",
    });

    expect(result.data?.signing_secret).toBe("pw_rotated_once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("represents a filtered test as an unsigned no-network outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhook_id: "hook_1",
            status_code: 204,
            signed: false,
            signature: "",
            response: "",
            filtered: true,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await testOutboundWebhook("hook_1");

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      filtered: true,
      signed: false,
      status_code: 204,
      response: "",
    });
    expect(result.data?.signature).toBe("");
  });

  it("rejects a contradictory filtered result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhook_id: "hook_1",
            status_code: 204,
            signed: true,
            signature: "t=1,v1=unsafe",
            response: "",
            filtered: true,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await testOutboundWebhook("hook_1");

    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("outbound_webhook_contract");
  });

  it("rejects an unsigned unfiltered test result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhook_id: "hook_1",
            status_code: 202,
            signed: false,
            signature: "",
            response: "accepted",
            filtered: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await testOutboundWebhook("hook_1");

    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("outbound_webhook_contract");
  });

  it("rejects a test result bound to a different webhook", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            webhook_id: "hook_other",
            status_code: 202,
            signed: true,
            signature: "t=1,v1=signed",
            response: "accepted",
            filtered: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await testOutboundWebhook("hook_1");

    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("outbound_webhook_contract");
  });

  it("carries the delivery cursor and sends it back unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toContain("limit=50");
        expect(url).toContain("cursor=older-page");
        return new Response(
          JSON.stringify({
            deliveries: [
              {
                id: "delivery-1",
                webhook_id: "hook_1",
                event_type: "campaign.sent",
                attempt_count: 2,
                status: "exhausted",
                last_status_code: 503,
                created_at: "2026-04-01T00:00:00Z",
              },
              {
                id: "delivery-2",
                webhook_id: "hook_1",
                event_type: "campaign.sent",
                attempt_count: 0,
                status: "skipped",
                last_error: "endpoint deleted",
                created_at: "2026-04-01T00:01:00Z",
              },
            ],
            next_cursor: "oldest-page",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await listOutboundWebhookDeliveries("hook_1", 50, {
      cursor: "older-page",
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.next_cursor).toBe("oldest-page");
    expect(result.data?.deliveries[0]).toMatchObject({
      id: "delivery-1",
      status: "exhausted",
    });
    expect(result.data?.deliveries[1]).toMatchObject({
      id: "delivery-2",
      status: "skipped",
    });
  });

  it("sends the caller-stable replay key and strictly binds the response to its source delivery", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
        "019c0000-0000-7000-8000-000000000001",
      );
      return new Response(
        JSON.stringify({
          delivery_id: "delivery-new",
          replayed_from: "delivery-source",
          status: "pending",
          replayed_at: "2026-07-23T10:00:00.000Z",
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await replayOutboundWebhookDelivery("delivery-source", {
      idempotencyKey: "019c0000-0000-7000-8000-000000000001",
    });

    expect(result).toMatchObject({
      data: {
        delivery_id: "delivery-new",
        replayed_from: "delivery-source",
        status: "pending",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a replay success attributed to another source delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            delivery_id: "delivery-new",
            replayed_from: "different-source",
            status: "pending",
            replayed_at: "2026-07-23T10:00:00.000Z",
          }),
          {
            status: 202,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await replayOutboundWebhookDelivery("delivery-source", {
      idempotencyKey: "019c0000-0000-7000-8000-000000000001",
    });

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "outbound_webhook_contract",
    });
  });

  it("rejects update, rotation, and delivery rows owned by another webhook", async () => {
    const wrongWebhook = canonicalOutboundWebhook("hook_other");
    const responses = [
      wrongWebhook,
      { webhook: wrongWebhook, signing_secret: "pw_wrong_owner" },
      {
        deliveries: [
          {
            id: "delivery_other",
            webhook_id: "hook_other",
            event_type: "campaign.sent",
            attempt_count: 1,
            status: "pending",
            created_at: "2026-04-01T00:00:00Z",
          },
        ],
        next_cursor: "",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const results = [
      await updateOutboundWebhook("hook_1", { description: "Renamed" }),
      await rotateOutboundWebhookSigningMaterial("hook_1"),
      await listOutboundWebhookDeliveries("hook_1"),
    ];

    for (const result of results) {
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "outbound_webhook_contract",
      });
    }
  });
});

describe("getSubscriberTimeline — cursor + limit query encoding", () => {
  it("encodes ?before=<ts>&limit=<n> when both options are set", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            subscriber_id: "sub1",
            email: "demo@example.com",
            stats: {
              sent_count: 0,
              opened_count: 0,
              clicked_count: 0,
              bounced_count: 0,
              replied_count: 0,
              open_rate: 0,
              click_rate: 0,
              engagement_score: 0,
              subscribed_at: "2026-01-01T00:00:00Z",
              current_status: "active",
            },
            events: [],
            pagination: { limit: 25, has_more: false },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await getSubscriberTimeline("sub1", {
      before: "2026-04-03T10:00:00Z",
      limit: 25,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/api/v1/subscribers/sub1/timeline");
    expect(calls[0]).toContain("before=2026-04-03T10");
    expect(calls[0]).toContain("limit=25");
  });

  it("omits both query params when neither option is set", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            subscriber_id: "sub1",
            email: "demo@example.com",
            stats: {
              sent_count: 0,
              opened_count: 0,
              clicked_count: 0,
              bounced_count: 0,
              replied_count: 0,
              open_rate: 0,
              click_rate: 0,
              engagement_score: 0,
              subscribed_at: "2026-01-01T00:00:00Z",
              current_status: "active",
            },
            events: [],
            pagination: { limit: 50, has_more: false },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await getSubscriberTimeline("sub1");
    expect(calls[0]).toMatch(/\/api\/v1\/subscribers\/sub1\/timeline$/);
  });

  it("URL-encodes the subscriber id segment", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            subscriber_id: "weird id",
            email: "demo@example.com",
            stats: {
              sent_count: 0,
              opened_count: 0,
              clicked_count: 0,
              bounced_count: 0,
              replied_count: 0,
              open_rate: 0,
              click_rate: 0,
              engagement_score: 0,
              subscribed_at: "2026-01-01T00:00:00Z",
              current_status: "active",
            },
            events: [],
            pagination: { limit: 50, has_more: false },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    await getSubscriberTimeline("weird id");
    expect(calls[0]).toContain("weird%20id");
  });
});

describe("native integration family lifecycle clients", () => {
  it("wire sync/backfill/pause/disconnect/runs to each owning provider family", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        const body = url.includes("/runs")
          ? { items: [] }
          : url.endsWith("/pause")
            ? { id: "conn/1", status: "paused" }
            : { ok: true, status: "completed" };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    type NativeLifecycleTestApi = {
      sync: (id: string) => Promise<unknown>;
      backfill: (id: string) => Promise<unknown>;
      ingest?: (id: string, payload: never) => Promise<unknown>;
      pause: (id: string) => Promise<unknown>;
      disconnect: (id: string) => Promise<unknown>;
      runs: (id: string, limit?: number) => Promise<unknown>;
    };
    const families: Array<{
      api: NativeLifecycleTestApi;
      base: string;
      ingestPayload?: Record<string, unknown>;
    }> = [
      { api: crmIntegrationsApi, base: "/api/v1/crm/integrations" },
      {
        api: leadIntegrationsApi,
        base: "/api/v1/lead-integrations",
        ingestPayload: { source_id: "lead_1", email: "ada@example.com" },
      },
      {
        api: reviewIntegrationsApi,
        base: "/api/v1/review-integrations",
        ingestPayload: { source_id: "review_1", rating: 5 },
      },
      {
        api: loyaltyIntegrationsApi,
        base: "/api/v1/loyalty-integrations",
        ingestPayload: {
          source_id: "loyalty_1",
          email: "ada@example.com",
          event_name: "points_earned",
        },
      },
      {
        api: subscriptionIntegrationsApi,
        base: "/api/v1/subscription-integrations",
        ingestPayload: {
          source_id: "subscription_1",
          email: "ada@example.com",
          event_name: "subscription_started",
        },
      },
      {
        api: analyticsIntegrationsApi,
        base: "/api/v1/analytics-integrations",
        ingestPayload: {
          source_id: "evt_1",
          email: "ada@example.com",
          event_name: "Viewed Product",
        },
      },
    ];

    for (const family of families) {
      await family.api.sync("conn/1");
      await family.api.backfill("conn/1");
      if (family.ingestPayload && family.api.ingest) {
        await family.api.ingest("conn/1", family.ingestPayload as never);
      }
      await family.api.pause("conn/1");
      await family.api.disconnect("conn/1");
      await family.api.runs("conn/1", 7);
    }

    for (const family of families) {
      const group = calls.splice(0, family.ingestPayload ? 6 : 5);
      const expected = [
        {
          url: expect.stringContaining(`${family.base}/conn%2F1/sync`),
          method: "POST",
        },
        {
          url: expect.stringContaining(`${family.base}/conn%2F1/backfill`),
          method: "POST",
        },
      ];
      if (family.ingestPayload) {
        expected.push({
          url: expect.stringContaining(`${family.base}/conn%2F1/ingest`),
          method: "POST",
        });
      }
      expected.push(
        {
          url: expect.stringContaining(`${family.base}/conn%2F1/pause`),
          method: "POST",
        },
        {
          url: expect.stringContaining(`${family.base}/conn%2F1`),
          method: "DELETE",
        },
        {
          url: expect.stringContaining(`${family.base}/conn%2F1/runs?limit=7`),
          method: "GET",
        },
      );
      expect(group).toEqual(expected);
    }
  });
});

describe("desktop migration uploads", () => {
  beforeEach(async () => {
    await setOfflineIdentity("migration-user:migration-workspace");
    await offlineQueueIdle();
  });

  afterEach(async () => {
    await clearOfflineStores();
    await offlineQueueIdle();
  });

  it("uses abortable chunk uploads so a stalled PUT cannot hang forever", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        if (init.method === "PUT") {
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      {
        name: "contacts.csv",
        lastModified: 123,
      },
    ) as File;

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("resumes from the last server-acknowledged byte across upload attempts", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      localStorage;
    const body = "email\n" + "x".repeat(600 * 1024);
    const file = Object.assign(new Blob([body], { type: "text/csv" }), {
      name: "contacts.csv",
      lastModified: 123,
    }) as File;
    // Chunk PUTs now retry 5xx up to 2 extra times (per-chunk policy),
    // so a persistent outage needs 3 consecutive 503s to surface.
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: 512 * 1024 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            upload_id: "upload-resume",
            received: 512 * 1024,
            total: body.length,
            updated_at: "2026-07-14T08:15:30Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: body.length }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    const failed = await api.uploadMigrationFile("csv", file);
    expect(failed.error?.status).toBe(503);
    const stored = JSON.parse([...storage.values()][0]) as {
      uploadId?: unknown;
      uploadedBytes?: unknown;
    };
    expect(typeof stored.uploadId).toBe("string");
    expect(stored.uploadedBytes).toBe(512 * 1024);
    expect([...storage.keys()].join("\n")).not.toContain("contacts.csv");

    const result = await api.uploadMigrationFile("csv", file);
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("/api/v1/migrations/csv/uploads/"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("/api/v1/migrations/csv/uploads/"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": `bytes ${512 * 1024}-${body.length - 1}/${body.length}`,
        }),
      }),
    );
    expect(storage.size).toBe(0);
  }, 20_000);

  it("purges an ambiguous v1 ledger without adopting its upload id", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
      clear: () => storage.clear(),
      key: (index) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      localStorage;
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      { name: "contacts.csv", lastModified: 123 },
    ) as File;
    let fingerprint = 2166136261;
    for (const character of `contacts.csv:${file.size}:123`) {
      fingerprint ^= character.charCodeAt(0);
      fingerprint = Math.imul(fingerprint, 16777619);
    }
    storage.set(
      `postwave.desktop.migration-upload.v1:csv:${(fingerprint >>> 0).toString(36)}:${file.size}:123`,
      JSON.stringify({ uploadId: "upload-old", uploadedBytes: file.size - 1 }),
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ received: file.size }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job_id: "job_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.not.stringContaining("/uploads/upload-old"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": `bytes 0-${file.size - 1}/${file.size}`,
        }),
      }),
    );
    expect(
      [...storage.keys()].some((key) =>
        key.startsWith("postwave.desktop.migration-upload.v1:"),
      ),
    ).toBe(false);
  });

  it("retries a transiently failing chunk PUT within the same upload", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("blip", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      {
        name: "contacts.csv",
        lastModified: 123,
      },
    ) as File;

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    // 1st attempt 503, retried once, then /complete.
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("re-sends the gap when the server acks fewer bytes than were sent", async () => {
    const body = "email\n" + "x".repeat(600 * 1024);
    const file = Object.assign(new Blob([body], { type: "text/csv" }), {
      name: "contacts.csv",
      lastModified: 123,
    }) as File;
    const ranges: string[] = [];
    const acks = [256 * 1024, body.length];
    let putIndex = 0;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        ranges.push(
          (init.headers as Record<string, string>)["Content-Range"] ?? "",
        );
        const received = acks[Math.min(putIndex, acks.length - 1)];
        putIndex += 1;
        return new Response(JSON.stringify({ received }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    // First chunk sent 0..524287 but the server only acked 262144 —
    // the next chunk MUST restart at the acked offset (never skip past
    // unacknowledged bytes).
    expect(ranges[0]).toBe(`bytes 0-${512 * 1024 - 1}/${body.length}`);
    expect(ranges[1]).toBe(
      `bytes ${256 * 1024}-${body.length - 1}/${body.length}`,
    );
  });

  it("rejects an out-of-range server acknowledgement instead of skipping to completion", async () => {
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      { name: "contacts.csv", lastModified: 123 },
    ) as File;
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ received: file.size + 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error?.kind).toBe("parse");
    expect(result.error?.code).toBe("invalid_upload_ack");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops before completion when the authenticated workspace changes mid-upload", async () => {
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      { name: "contacts.csv", lastModified: 123 },
    ) as File;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        await setOfflineIdentity("migration-user:other-workspace");
        return new Response(JSON.stringify({ received: file.size }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("completion must not run under a different workspace");
    });
    vi.stubGlobal("fetch", fetch);

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error?.code).toBe("upload_identity_changed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores oversized legacy migration upload ledgers before resuming", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      localStorage;
    vi.stubGlobal("crypto", { randomUUID: () => "upload-fixed" });
    storage.set(
      "postwave.desktop.migration-upload.v1:csv:contacts.csv:13:123",
      `legacy-${"x".repeat(9_000)}`,
    );
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      {
        name: "contacts.csv",
        lastModified: 123,
      },
    ) as File;

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/v1/migrations/csv/uploads/upload-fixed"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("ignores malformed migration upload IDs before resuming", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      localStorage;
    vi.stubGlobal("crypto", { randomUUID: () => "upload-fixed" });
    storage.set(
      "postwave.desktop.migration-upload.v1:csv:contacts.csv:13:123",
      JSON.stringify({ uploadId: "../bad\nid", uploadedBytes: 12 }),
    );
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      {
        name: "contacts.csv",
        lastModified: 123,
      },
    ) as File;

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/v1/migrations/csv/uploads/upload-fixed"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "Content-Range": "bytes 0-12/13",
        }),
      }),
    );
  });

  it("uses a sanitized filename in desktop migration chunk URLs", async () => {
    const urls: string[] = [];
    vi.stubGlobal("crypto", { randomUUID: () => "upload-fixed" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        if (init.method === "PUT") {
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({ job_id: "job_1", account_id: "contacts.csv" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const file = Object.assign(
      new Blob(["email\nx@y.com"], { type: "text/csv" }),
      {
        name: "folder\\customer export ?secret=1.csv",
        lastModified: 123,
      },
    ) as File;

    const result = await api.uploadMigrationFile("csv", file);

    expect(result.error).toBeUndefined();
    const url = new URL(urls[0] ?? "");
    expect(url.searchParams.get("filename")).toBe(
      "customer export _secret_1.csv",
    );
  });
});

describe("desktop Mailchimp migration contract", () => {
  it("carries explicit audience scope through discovery, dry-run, and commit", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      const path = new URL(url).pathname;
      if (path.endsWith("/discover")) {
        return new Response(
          JSON.stringify({
            job_id: "job_1",
            source: "mailchimp",
            subscribers_count: 2,
            segments_count: 0,
            automations_count: 0,
            archive_count: 0,
            paid_subs_count: 0,
            audiences: [{ id: "aud_1", name: "Main", subscribers_total: 2 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ job_id: "job_1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    await api.discoverMigration("mailchimp", "job_1", ["aud_1"]);
    await api.previewMigration("mailchimp", "job_1", ["aud_1"]);
    await api.runMigration("mailchimp", "job_1", ["aud_1"]);

    expect(fetch).toHaveBeenCalledTimes(3);
    for (const index of [0, 1, 2]) {
      const body = JSON.parse(String(fetch.mock.calls[index]?.[1]?.body)) as {
        job_id: string;
        selected_audience_ids: string[];
      };
      expect(body).toEqual({
        job_id: "job_1",
        selected_audience_ids: ["aud_1"],
      });
    }
  });

  it("rejects unscoped Mailchimp dry-run and commit before network I/O", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const preview = await api.previewMigration("mailchimp", "job_1");
    const commit = await api.runMigration("mailchimp", "job_1", []);

    expect(preview.error?.code).toBe("audience_scope_required");
    expect(commit.error?.code).toBe("audience_scope_required");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("desktop migration response decoding", () => {
  it("rejects a discovery response bound to a different job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              job_id: "job_other",
              source: "klaviyo",
              subscribers_count: 12,
              segments_count: 3,
              automations_count: 2,
              archive_count: 4,
              paid_subs_count: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await api.discoverMigration("klaviyo", "job_klaviyo");

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "migration_discovery_identity_mismatch",
    });
  });

  it("turns a null dry-run acknowledgement into a fixed parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("null", {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await api.previewMigration("klaviyo", "job_klaviyo");
    if (!result.error) throw new Error("expected dry-run parse failure");

    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({
      kind: "parse",
      code: "migration_preview_invalid_ack",
      message: "The migration dry-run response could not be verified.",
    });
    expect(result.retryability).toBe("manual");
  });
});

describe("desktop Klaviyo migration discovery contract", () => {
  it("retains excluded-profile and source-archive channel counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              job_id: "job_klaviyo",
              source: "klaviyo",
              subscribers_count: 12,
              segments_count: 3,
              automations_count: 2,
              archive_count: 4,
              paid_subs_count: 0,
              profiles_without_email_count: 5,
              source_archive_count: 16,
              sms_campaigns_count: 6,
              push_campaigns_count: 7,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await api.discoverMigration("klaviyo", "job_klaviyo");

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      profiles_without_email_count: 5,
      source_archive_count: 16,
      sms_campaigns_count: 6,
      push_campaigns_count: 7,
    });
  });
});

describe("desktop HubSpot migration discovery contract", () => {
  it("retains excluded-primary and additional-email identity counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              job_id: "job_hubspot",
              source: "hubspot",
              subscribers_count: 12,
              segments_count: 3,
              automations_count: 0,
              archive_count: 0,
              paid_subs_count: 0,
              profiles_without_email_count: 2,
              additional_email_identities_count: 5,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await api.discoverMigration("hubspot", "job_hubspot");

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      profiles_without_email_count: 2,
      additional_email_identities_count: 5,
    });
  });
});

describe("error-honesty fixes (audit 2026-06-10)", () => {
  it("listDashboardAnomalies propagates a 500 instead of resolving empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
    const r = await api.listDashboardAnomalies({ limit: 5 });
    expect(r.error?.status).toBe(500);
  });

  it("listDashboardAnomalies still treats 404 as feature-absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const r = await api.listDashboardAnomalies({ limit: 5 });
    expect(r.error).toBeUndefined();
    expect(r.data?.items).toEqual([]);
  });

  it("predictInboxPlacement returns insufficient_data without firing HTTP when inputs are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await apiInlineAi.predictInboxPlacement({
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
    });
    expect(r.error?.code).toBe("insufficient_data");
    expect(r.error?.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("predictInboxPlacement forwards only the fields the caller supplied", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({
            predicted: { primary: 0.8, promotions: 0.15, spam: 0.05 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const r = await apiInlineAi.predictInboxPlacement({
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
      reputation: { domain: "mail.example.com" },
      history: { OpenRate: 0.31 },
    });
    expect(r.error).toBeUndefined();
    const body = bodies[0] as {
      reputation: Record<string, unknown>;
      history: Record<string, unknown>;
    };
    // No fabricated defaults: only the supplied fields (+ checked_at).
    expect(body.reputation.domain).toBe("mail.example.com");
    expect(body.reputation).not.toHaveProperty("sender_score");
    expect(body.reputation).not.toHaveProperty("google_score");
    expect(body.history).toEqual({ OpenRate: 0.31 });
  });
});

describe("listsMergeFieldsApi — server wire contract", () => {
  it("list unwraps the {merge_fields} envelope and maps `default` → default_value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              list_id: "l1",
              merge_fields: [
                {
                  tag: "FNAME",
                  name: "First name",
                  type: "text",
                  required: true,
                  default: "friend",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const r = await listsMergeFieldsApi.list("l1");
    expect(r.error).toBeUndefined();
    expect(r.data?.items).toEqual([
      {
        tag: "FNAME",
        name: "First name",
        type: "text",
        required: true,
        default_value: "friend",
      },
    ]);
  });

  it("create sends the required tag and the backend's `default` JSON key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return new Response(
          JSON.stringify({
            tag: "PHONE",
            name: "Phone",
            type: "phone",
            required: false,
            default: "n/a",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const r = await listsMergeFieldsApi.create("l1", {
      tag: "PHONE",
      name: "Phone",
      type: "phone",
      default_value: "n/a",
    });
    expect(r.error).toBeUndefined();
    expect(calls[0].url).toContain("/api/v1/lists/l1/merge-fields");
    expect(calls[0].body.tag).toBe("PHONE");
    expect(calls[0].body.default).toBe("n/a");
    expect(calls[0].body).not.toHaveProperty("default_value");
    expect(r.data?.default_value).toBe("n/a");
  });

  it("update and delete are keyed by tag (no id)", async () => {
    const urls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push({ url, method: init.method });
        if (init.method === "DELETE")
          return new Response(null, { status: 204 });
        return new Response(
          JSON.stringify({ tag: "FNAME", name: "First", type: "text" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await listsMergeFieldsApi.update("l1", "FNAME", {
      tag: "FNAME",
      name: "First",
      type: "text",
    });
    await listsMergeFieldsApi.remove("l1", "FNAME");
    expect(urls[0].url).toContain("/api/v1/lists/l1/merge-fields/FNAME");
    expect(urls[0].method).toBe("PATCH");
    expect(urls[1].url).toContain("/api/v1/lists/l1/merge-fields/FNAME");
    expect(urls[1].method).toBe("DELETE");
  });
});

describe("suppressionsConvergedApi.get — email filter + legacy scan fallback", () => {
  function pageResponse(
    items: Array<{ email: string }>,
    total: number,
    page: number,
  ) {
    return new Response(
      JSON.stringify({
        items: items.map((i, n) => ({
          id: `s_${page}_${n}`,
          email: i.email,
          reason: "manual_unsubscribe",
          source: "manual",
          created_at: "2026-01-01T00:00:00Z",
        })),
        total,
        page,
        size: 200,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  function badRequest() {
    return new Response(
      JSON.stringify({ error: { message: "unknown query param email" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  it("resolves via the server-side email= exact filter in one call", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return pageResponse([{ email: "target@x.com" }], 1, 1);
      }),
    );
    const r = await suppressionsConvergedApi.get("Target@X.com");
    expect(r.error).toBeUndefined();
    expect(r.data?.email).toBe("target@x.com");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("email=Target%40X.com");
  });

  it("returns an honest 404 when the filter comes back empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pageResponse([], 0, 1)),
    );
    const r = await suppressionsConvergedApi.get("missing@x.com");
    expect(r.error?.status).toBe(404);
    expect(r.error?.code).toBe("not_found");
  });

  it("falls back to the budgeted scan when an older server 400s the filter, finding later-page hits", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        if (url.includes("email=")) return badRequest();
        if (call === 2) {
          return pageResponse(
            Array.from({ length: 200 }, (_, n) => ({ email: `a${n}@x.com` })),
            420,
            1,
          );
        }
        return pageResponse([{ email: "target@x.com" }], 420, 2);
      }),
    );
    const r = await suppressionsConvergedApi.get("Target@X.com");
    expect(r.error).toBeUndefined();
    expect(r.data?.email).toBe("target@x.com");
    expect(call).toBe(3); // 400'd filter + two scan pages
  });

  it("scan fallback returns an honest 404 only after scanning the whole table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("email=")) return badRequest();
        return pageResponse([{ email: "other@x.com" }], 1, 1);
      }),
    );
    const r = await suppressionsConvergedApi.get("missing@x.com");
    expect(r.error?.status).toBe(404);
    expect(r.error?.code).toBe("not_found");
  });

  it("scan fallback returns scan_truncated instead of fabricating 404 at the budget", async () => {
    let scanPages = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("email=")) return badRequest();
        scanPages += 1;
        return pageResponse(
          Array.from({ length: 200 }, (_, n) => ({
            email: `p${scanPages}n${n}@x.com`,
          })),
          10_000,
          scanPages,
        );
      }),
    );
    const r = await suppressionsConvergedApi.get("missing@x.com");
    expect(scanPages).toBe(5);
    expect(r.error?.code).toBe("scan_truncated");
    expect(r.error?.status).toBeUndefined();
  });
});

describe("webhook playground live-fire containment", () => {
  const fireId = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6d";
  const eventId = "11111111-1111-5111-8111-111111111111";
  const fireOptions = {
    idempotencyKey: `webhook-playground:${fireId}`,
  };
  it("strictly decodes a bounded unique event catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            events: [
              {
                event_type: "subscriber.added",
                sample_payload: { email: "reader@example.com" },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.listWebhookPlaygroundEvents();

    expect(result.error).toBeUndefined();
    expect(result.data?.events).toEqual([
      {
        event_type: "subscriber.added",
        sample_payload: { email: "reader@example.com" },
      },
    ]);
  });

  it("fails closed on a duplicate or malformed event catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            events: [
              { event_type: "subscriber.added", sample_payload: {} },
              { event_type: "subscriber.added", sample_payload: null },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.listWebhookPlaygroundEvents();

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_catalog_contract",
    });
    expect(result.error?.message).toContain("Firing is disabled");
  });

  it.each([
    {
      label: "unknown top-level field",
      payload: {
        events: [],
        ignored: true,
      },
    },
    {
      label: "unknown event-entry field",
      payload: {
        events: [
          {
            event_type: "subscriber.added",
            sample_payload: {},
            ignored: true,
          },
        ],
      },
    },
    {
      label: "event outside the canonical catalog",
      payload: {
        events: [{ event_type: "order.created", sample_payload: {} }],
      },
    },
    {
      label: "unbounded sample payload",
      payload: {
        events: [
          {
            event_type: "subscriber.added",
            sample_payload: { value: "x".repeat(256_001) },
          },
        ],
      },
    },
  ])("fails closed on $label", async ({ payload }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await api.listWebhookPlaygroundEvents();

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_catalog_contract",
    });
  });

  it("strictly decodes the complete inspectable fire result", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            fire_id: fireId,
            event_id: eventId,
            delivery_id: `playground-${fireId}`,
            url: "https://hooks.example.com/postwave",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Signature": "t=1784820600,v1=signature",
            },
            body: { event: { id: "evt_1" } },
            signature: "t=1784820600,v1=signature",
            requested_at: "2026-07-23T15:30:00.000Z",
            status_code: 202,
            response_body: "accepted",
            latency_ms: 18,
            outcome: "receiver_responded",
            ambiguous: false,
            response_body_truncated: false,
            redacted_header_count: 1,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
      },
      fireOptions,
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      method: "POST",
      status_code: 202,
      filtered: false,
      redacted_header_count: 1,
    });
  });

  it("embeds the operator's exact raw object without rounding large integers", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const payloadJSON = `{
  "large": 9007199254740993,
  "nested": { "enabled": true }
}`;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBe(
        `{"fire_id":"${fireId}","event_type":"subscriber.added","expected_webhook_config_version":7,"payload":${payloadJSON}}`,
      );
      expect(String(init.body)).not.toContain("payloadJSON");
      return new Response(
        JSON.stringify({
          fire_id: fireId,
          event_id: eventId,
          delivery_id: `playground-${fireId}`,
          url: "https://hooks.example.com/postwave",
          method: "POST",
          headers: {},
          body: { event: { id: "evt_filtered" } },
          signature: "",
          requested_at: "2026-07-23T15:30:00.000Z",
          status_code: 204,
          response_body: "",
          latency_ms: 0,
          filtered: true,
          outcome: "filtered",
          ambiguous: false,
          response_body_truncated: false,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON,
      },
      fireOptions,
    );

    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unpublished live-fire response fields", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            fire_id: fireId,
            event_id: eventId,
            delivery_id: `playground-${fireId}`,
            url: "https://hooks.example.com/postwave",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Signature": "t=1784820600,v1=signature",
            },
            body: { event: { id: "evt_1" } },
            signature: "t=1784820600,v1=signature",
            requested_at: "2026-07-23T15:30:00.000Z",
            status_code: 202,
            response_body: "accepted",
            latency_ms: 12,
            filtered: false,
            outcome: "receiver_responded",
            ambiguous: false,
            response_body_truncated: false,
            undocumented: "drift",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON: "{}",
      },
      fireOptions,
    );

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_contract",
    });
  });

  it("preserves a filtered fire as an explicit no-network outcome", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            fire_id: fireId,
            event_id: eventId,
            delivery_id: `playground-${fireId}`,
            url: "https://hooks.example.com/postwave",
            method: "POST",
            headers: {},
            body: { event: { id: "evt_filtered" } },
            signature: "",
            requested_at: "2026-07-23T15:30:00.000Z",
            status_code: 204,
            response_body: "",
            latency_ms: 0,
            filtered: true,
            outcome: "filtered",
            ambiguous: false,
            response_body_truncated: false,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
      },
      fireOptions,
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      filtered: true,
      status_code: 204,
      headers: {},
      signature: "",
      response_body: "",
    });
  });

  it("fails closed when a successful fire response is malformed", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          fire_id: fireId,
          event_id: eventId,
          delivery_id: `playground-${fireId}`,
          url: "https://hooks.example.com/postwave",
          method: "POST",
          headers: null,
          body: {},
          signature: "t=1784820600,v1=signature",
          requested_at: "2026-07-23T15:30:00.000Z",
          status_code: 202,
          response_body: "accepted",
          latency_ms: 18,
          outcome: "receiver_responded",
          ambiguous: false,
          response_body_truncated: false,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
      },
      fireOptions,
    );

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_contract",
    });
    expect(result.error?.message).toContain(
      "live-delivery outcome is ambiguous",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never automatically retries a real webhook playground fire", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "service_unavailable",
            message: "receiver result is ambiguous",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON: '{"email":"reader@example.com"}',
      },
      fireOptions,
    );

    expect(result.data).toBeUndefined();
    expect(result.error?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strictly decodes and request-binds a durable fire receipt", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method ?? "GET").toBe("GET");
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      return new Response(
        JSON.stringify({
          fire_id: fireId,
          webhook_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          event_type: "subscriber.added",
          delivery_id: `playground-${fireId}`,
          state: "completed",
          outcome: "receiver_responded",
          receiver_status_code: 202,
          response_body_truncated: false,
          created_at: "2026-07-23T15:30:00.000Z",
          completed_at: "2026-07-23T15:30:01.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getWebhookPlaygroundFire(fireId);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      fire_id: fireId,
      state: "completed",
      outcome: "receiver_responded",
      receiver_status_code: 202,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("decodes an expired receipt as a terminal identity fence", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            fire_id: fireId,
            webhook_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            event_type: "legacy.retired",
            delivery_id: `playground-${fireId}`,
            state: "receipt_expired",
            outcome: "receiver_responded",
            receiver_status_code: 202,
            response_body_truncated: true,
            created_at: "2026-07-23T15:30:00.000Z",
            completed_at: "2026-07-23T15:30:01.000Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.getWebhookPlaygroundFire(fireId);

    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      fire_id: fireId,
      webhook_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      event_type: "legacy.retired",
      state: "receipt_expired",
      outcome: "receiver_responded",
      receiver_status_code: 202,
      response_body_truncated: true,
      completed_at: "2026-07-23T15:30:01.000Z",
    });
  });

  it("preserves an expired exact POST replay as an HTTP identity fence", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "playground_fire_receipt_expired",
              message:
                "This fire identity remains consumed, but its private inspection receipt has expired. Do not redispatch it.",
            },
            fire_id: fireId,
            state: "receipt_expired",
          }),
          {
            status: 410,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON: "{}",
      },
      fireOptions,
    );

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "http",
      status: 410,
      code: "playground_fire_receipt_expired",
      details: {
        fire_id: fireId,
        state: "receipt_expired",
      },
    });
  });

  it("rejects an expired POST tombstone for a different logical fire", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "playground_fire_receipt_expired",
                message: "This fire identity remains consumed.",
              },
              fire_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              state: "receipt_expired",
            }),
            {
              status: 410,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON: "{}",
      },
      fireOptions,
    );

    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_contract",
    });
    expect(result.error?.message).toContain(
      "not bound to the requested logical fire",
    );
  });

  it.each([
    {
      label: "a different requested fire identity",
      receipt: {
        fire_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        webhook_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        event_type: "subscriber.added",
        delivery_id: "playground-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-23T15:30:00.000Z",
        completed_at: "2026-07-23T15:30:01.000Z",
      },
    },
    {
      label: "an inconsistent completed outcome",
      receipt: {
        fire_id: fireId,
        webhook_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        event_type: "subscriber.added",
        delivery_id: `playground-${fireId}`,
        state: "completed",
        outcome: "transport_ambiguous",
        receiver_status_code: 0,
        response_body_truncated: false,
        created_at: "2026-07-23T15:30:00.000Z",
        completed_at: "2026-07-23T15:30:01.000Z",
      },
    },
  ])("fails closed on $label in a fire receipt", async ({ receipt }) => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(receipt), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await api.getWebhookPlaygroundFire(fireId);

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "parse",
      code: "webhook_playground_receipt_contract",
    });
  });

  it("fails a webhook playground fire offline without queue admission", async () => {
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      makeMapLocalStorage();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await setOfflineIdentity("test-user:test-workspace");
    await offlineQueueIdle();

    const result = await api.fireWebhookPlayground(
      "hook_1",
      {
        fire_id: fireId,
        event_type: "subscriber.added",
        expected_webhook_config_version: 7,
        payloadJSON: '{"email":"reader@example.com"}',
      },
      fireOptions,
    );

    expect(result.data).toBeUndefined();
    expect(result.error).toMatchObject({
      kind: "network",
      code: "offline",
    });
    expect(result.queued).not.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await clearOfflineStores();
  });
});

describe("read-only POST idempotency privacy", () => {
  it("sends the exact suppression query without an Idempotency-Key", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiRequest(
      "/api/v1/sms/suppressions/query",
      {
        method: "POST",
        body: JSON.stringify({ phone: "+12025550101" }),
        headers: { "idempotency-key": "caller-key-must-not-leak" },
      },
      { idempotencyKey: null, requireOnline: true },
    );

    expect(result).toEqual({ data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses offline queue admission for the exact suppression query", async () => {
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      makeMapLocalStorage();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await setOfflineIdentity("test-user:test-workspace");
    await offlineQueueIdle();

    const result = await apiRequest(
      "/api/v1/sms/suppressions/query",
      {
        method: "POST",
        body: JSON.stringify({ phone: "+12025550101" }),
      },
      { idempotencyKey: null, requireOnline: true },
    );

    expect(result.error).toMatchObject({ kind: "network", code: "offline" });
    expect(result.queued).not.toBe(true);
    expect(readOfflineQueue()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    await clearOfflineStores();
  });
});

describe("offline queue acknowledgement", () => {
  it("returns a receipt-only result after durable queue admission", async () => {
    (globalThis.window as unknown as { localStorage: Storage }).localStorage =
      makeMapLocalStorage();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await setOfflineIdentity("test-user:test-workspace");
    await offlineQueueIdle();

    const r = await api.updateForm("form_1", { name: "Renamed" });

    expect(r.error).toBeUndefined();
    expect(r.queued).toBe(true);
    if (!r.queued) throw new Error("Expected a queued receipt");
    expect(r).not.toHaveProperty("data");
    expect(r.receipt).toMatchObject({
      state: "pending",
      action: "Update form",
      record: "Renamed",
    });
    expect(typeof r.receipt.queueId).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
    await clearOfflineStores();
  });
});
