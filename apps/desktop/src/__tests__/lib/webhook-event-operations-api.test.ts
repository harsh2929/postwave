import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import type { ApiResult } from "../../lib/api/result";
import {
  createWebhookEventOperationsMethods,
  type WebhookEventOperationsDependencies,
  type WebhookEventRequester,
  type WebhookEventRequestOptions,
} from "../../lib/api/webhook-event-operations";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: WebhookEventRequestOptions | undefined;
}

const METHOD_NAMES = [
  "listInboundWebhooks",
  "createInboundWebhook",
  "getInboundWebhook",
  "listInboundWebhookEvents",
  "rotateInboundWebhook",
  "deleteInboundWebhook",
  "listProductEvents",
  "getProductEventCatalog",
  "getProductEventStats",
  "productEventStreamUrl",
  "productEventStreamUrlAuthed",
  "productEventsCsvUrl",
  "productEventsCsvUrlAuthed",
  "sendProductEvent",
  "listWebhooks",
  "createWebhook",
  "updateWebhook",
  "getWebhookHealth",
  "reEnableWebhook",
  "disableWebhook",
  "deleteWebhook",
  "getWebhookAlertPrefs",
  "putWebhookAlertPrefs",
  "replayInboundEvent",
  "listWebhookTestPayloads",
  "createWebhookTestPayload",
  "deleteWebhookTestPayload",
  "setWebhookEnvironment",
  "listWebhookDeliveries",
  "retryWebhookDelivery",
  "testWebhook",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const streamPaths: string[] = [];
  const state = { apiUrlReads: 0 };
  const queuedResponses = [...responses];

  const request: WebhookEventRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: WebhookEventRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };

  const dependencies: WebhookEventOperationsDependencies = {
    request,
    getApiUrl: () => {
      state.apiUrlReads += 1;
      return "https://api.example.test";
    },
    buildStreamUrl: async (path) => {
      streamPaths.push(path);
      return `stream:${path}`;
    },
  };

  return {
    calls,
    methods: createWebhookEventOperationsMethods(dependencies),
    state,
    streamPaths,
  };
}

function canonicalInboundEndpoint() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "billing-events-a1b2c3",
    name: "Billing events",
    enabled: true,
    transform_jq: "{ type, invoice_id }",
    createdAt: "2026-07-23T08:00:00.000Z",
  };
}

function canonicalInboundEvent() {
  return {
    id: 401,
    endpoint_id: canonicalInboundEndpoint().id,
    headers: {
      "content-type": "application/json",
      "x-postwave-event-id": "sha256:event-401",
    },
    body: '{"type":"invoice.paid"}',
    signature_valid: true,
    received_at: "2026-07-23T09:00:00.000Z",
  };
}

describe("webhook and product-event operations API extraction contracts", () => {
  it("retains the exact ordered 31-method inventory without eager work", () => {
    const { calls, methods, state, streamPaths } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(streamPaths).toEqual([]);
    expect(state.apiUrlReads).toBe(0);
  });

  it("preserves inbound endpoint CRUD, event queries, and shown-once secret requests", async () => {
    const { calls, methods } = createHarness();

    await methods.listInboundWebhooks();
    await methods.createInboundWebhook({ label: "Stripe / production" });
    await methods.getInboundWebhook("hook/one");
    await methods.listInboundWebhookEvents("hook/one", { limit: 25 });
    await methods.rotateInboundWebhook("hook/one");
    await methods.deleteInboundWebhook("hook/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/inbound-webhooks",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Stripe / production",
          }),
        },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
      {
        path: "/api/v1/inbound-webhooks/hook%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/hook%2Fone/events?limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/hook%2Fone/rotate",
        init: { method: "POST", body: "{}" },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
      {
        path: "/api/v1/inbound-webhooks/hook%2Fone",
        init: { method: "DELETE" },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
    ]);
  });

  it("forwards opaque inbound endpoint and event cursors without truncating later pages", async () => {
    const { calls, methods } = createHarness();

    await methods.listInboundWebhooks({
      cursor: "opaque/+ endpoint cursor",
      limit: 999,
      query: "  billing events  ",
    });
    await methods.listInboundWebhookEvents("hook/one", {
      cursor: "opaque/+ event cursor",
      limit: 0,
    });

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/inbound-webhooks?cursor=opaque%2F%2B+endpoint+cursor&limit=200&query=billing+events",
      "/api/v1/inbound-webhooks/hook%2Fone/events?cursor=opaque%2F%2B+event+cursor&limit=1",
    ]);
  });

  it("forwards caller-stable identities for shown-once inbound mutations", async () => {
    const endpoint = canonicalInboundEndpoint();
    const { calls, methods } = createHarness([
      { data: { endpoint, secret: "iwh_created_once" } },
      { data: { endpoint, secret: "iwh_rotated_once" } },
    ]);

    await methods.createInboundWebhook(
      { label: "Billing events" },
      { idempotencyKey: "019c0000-0000-7000-8000-000000000101" },
    );
    await methods.rotateInboundWebhook(endpoint.id, {
      idempotencyKey: "019c0000-0000-7000-8000-000000000102",
    });

    expect(calls).toMatchObject([
      {
        init: {
          headers: {
            "Idempotency-Key": "019c0000-0000-7000-8000-000000000101",
          },
        },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
      {
        init: {
          headers: {
            "Idempotency-Key": "019c0000-0000-7000-8000-000000000102",
          },
        },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
    ]);
  });

  it("rejects a false or expanded inbound delete acknowledgement", async () => {
    const { methods } = createHarness([
      { data: { ok: false } },
      { data: { ok: true, ignored: "drift" } },
    ]);

    for (const result of [
      await methods.deleteInboundWebhook(canonicalInboundEndpoint().id),
      await methods.deleteInboundWebhook(canonicalInboundEndpoint().id),
    ]) {
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "inbound_webhook_contract",
      });
    }
  });

  it("decodes only the published inbound endpoint, secret, and event contracts", async () => {
    const endpoint = canonicalInboundEndpoint();
    const event = canonicalInboundEvent();
    const { methods } = createHarness([
      { data: { items: [endpoint], next_cursor: "endpoint-page-2" } },
      { data: { endpoint, secret: "iwh_shown_once" } },
      { data: endpoint },
      { data: { items: [event] } },
      { data: { endpoint, secret: "iwh_rotated_once" } },
    ]);

    await expect(methods.listInboundWebhooks()).resolves.toEqual({
      data: { items: [endpoint], next_cursor: "endpoint-page-2" },
    });
    await expect(
      methods.createInboundWebhook({ label: "Billing events" }),
    ).resolves.toEqual({
      data: { endpoint, secret: "iwh_shown_once" },
    });
    await expect(methods.getInboundWebhook(endpoint.id)).resolves.toEqual({
      data: endpoint,
    });
    await expect(
      methods.listInboundWebhookEvents(endpoint.id),
    ).resolves.toEqual({
      data: { items: [event], next_cursor: "" },
    });
    await expect(methods.rotateInboundWebhook(endpoint.id)).resolves.toEqual({
      data: { endpoint, secret: "iwh_rotated_once" },
    });
  });

  it("rejects inbound rows bound to a different requested endpoint", async () => {
    const expectedID = canonicalInboundEndpoint().id;
    const otherID = "22222222-2222-4222-8222-222222222222";
    const otherEndpoint = { ...canonicalInboundEndpoint(), id: otherID };
    const otherEvent = { ...canonicalInboundEvent(), endpoint_id: otherID };
    const { methods } = createHarness([
      { data: otherEndpoint },
      { data: { items: [otherEvent], next_cursor: "" } },
      { data: { endpoint: otherEndpoint, secret: "iwh_wrong_owner" } },
    ]);

    for (const result of [
      await methods.getInboundWebhook(expectedID),
      await methods.listInboundWebhookEvents(expectedID),
      await methods.rotateInboundWebhook(expectedID),
    ]) {
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "inbound_webhook_contract",
      });
    }
  });

  it.each([
    {
      label: "bare endpoint array",
      call: "endpoints" as const,
      payload: [canonicalInboundEndpoint()],
    },
    {
      label: "legacy data envelope",
      call: "endpoints" as const,
      payload: { data: [canonicalInboundEndpoint()] },
    },
    {
      label: "partially malformed endpoint page",
      call: "endpoints" as const,
      payload: {
        items: [
          canonicalInboundEndpoint(),
          { ...canonicalInboundEndpoint(), id: "not-a-uuid" },
        ],
      },
    },
    {
      label: "flat create response",
      call: "create" as const,
      payload: { ...canonicalInboundEndpoint(), secret: "iwh_once" },
    },
    {
      label: "create response without a one-time secret",
      call: "create" as const,
      payload: { endpoint: canonicalInboundEndpoint() },
    },
    {
      label: "rotate response without a one-time secret",
      call: "rotate" as const,
      payload: { endpoint: canonicalInboundEndpoint() },
    },
    {
      label: "legacy event results envelope",
      call: "events" as const,
      payload: { results: [canonicalInboundEvent()] },
    },
    {
      label: "partially malformed event page",
      call: "events" as const,
      payload: {
        items: [
          canonicalInboundEvent(),
          { ...canonicalInboundEvent(), headers: { authorization: 42 } },
        ],
      },
    },
  ])("fails closed on $label", async ({ call, payload }) => {
    const { methods } = createHarness([{ data: payload }]);
    const result =
      call === "endpoints"
        ? await methods.listInboundWebhooks()
        : call === "events"
          ? await methods.listInboundWebhookEvents(
              canonicalInboundEndpoint().id,
            )
          : call === "rotate"
            ? await methods.rotateInboundWebhook(canonicalInboundEndpoint().id)
            : await methods.createInboundWebhook({ label: "Billing events" });

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "inbound_webhook_contract",
        message: expect.stringContaining(
          "No malformed rows were discarded or treated as empty",
        ),
      },
      retryability: "not-retryable",
    });
    expect("data" in result).toBe(false);
  });

  it("preserves product-event filters, URLs, authenticated streams, and synthetic sends", async () => {
    const { calls, methods, state, streamPaths } = createHarness();
    const eventInput = {
      subscriber_id: "sub/one",
      email: "ada@example.com",
      event_name: "order/paid",
      properties: { amount: 42 },
      occurred_at: "2026-07-16T08:00:00Z",
    };

    await methods.listProductEvents({
      subscriberId: "sub/one",
      eventName: "order/paid",
      limit: 50,
      before: "2026-07-16T08:00:00Z",
    });
    await methods.getProductEventCatalog({ days: 14 });
    await methods.getProductEventStats({ eventName: "order/paid", days: 30 });
    expect(methods.productEventStreamUrl("order/paid")).toBe(
      "https://api.example.test/api/v1/track/stream?event_name=order%2Fpaid",
    );
    await expect(
      methods.productEventStreamUrlAuthed("order/paid"),
    ).resolves.toBe("stream:/api/v1/track/stream?event_name=order%2Fpaid");
    expect(
      methods.productEventsCsvUrl({
        eventName: "order/paid",
        subscriberId: "sub/one",
        limit: 100,
        occurredAfter: "2026-07-01T00:00:00Z",
      }),
    ).toBe(
      "https://api.example.test/api/v1/track/events.csv?event_name=order%2Fpaid&subscriber_id=sub%2Fone&limit=100&occurred_after=2026-07-01T00%3A00%3A00Z",
    );
    await expect(
      methods.productEventsCsvUrlAuthed({
        eventName: "order/paid",
        subscriberId: "sub/one",
        limit: 100,
        occurredAfter: "2026-07-01T00:00:00Z",
      }),
    ).resolves.toBe(
      "stream:/api/v1/track/events.csv?event_name=order%2Fpaid&subscriber_id=sub%2Fone&limit=100&occurred_after=2026-07-01T00%3A00%3A00Z",
    );
    await methods.sendProductEvent(eventInput, {
      idempotencyKey: "track-live-event-attempt-1",
    });

    expect(state.apiUrlReads).toBe(2);
    expect(streamPaths).toEqual([
      "/api/v1/track/stream?event_name=order%2Fpaid",
      "/api/v1/track/events.csv?event_name=order%2Fpaid&subscriber_id=sub%2Fone&limit=100&occurred_after=2026-07-01T00%3A00%3A00Z",
    ]);
    expect(calls).toEqual([
      {
        path: "/api/v1/track/events?subscriber_id=sub%2Fone&event_name=order%2Fpaid&limit=50&before=2026-07-16T08%3A00%3A00Z",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/track/catalog?days=14",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/track/stats?event_name=order%2Fpaid&days=30",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/track",
        init: {
          method: "POST",
          body: JSON.stringify(eventInput),
          headers: {
            "Idempotency-Key": "track-live-event-attempt-1",
          },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("preserves outbound webhook CRUD, health, status, and alert-preference transports", async () => {
    const { calls, methods } = createHarness();
    const createInput = {
      url: "https://hooks.example.test/postwave",
      events: ["subscriber.added", "campaign.sent"],
    };
    const patch = {
      url: "https://hooks.example.test/updated",
      events: ["subscriber.updated"],
      status: "active",
    };
    const preferences = {
      notify_auto_disabled: true,
      notify_failure_rate: true,
      failure_rate_pct: 20,
      notify_latency: true,
      latency_ms: 2_000,
    };

    await methods.listWebhooks();
    await methods.createWebhook(createInput);
    await methods.updateWebhook("hook/one", patch);
    await methods.getWebhookHealth("hook/one");
    await methods.reEnableWebhook("hook/one");
    await methods.disableWebhook("hook/one");
    await methods.deleteWebhook("hook/one");
    await methods.getWebhookAlertPrefs();
    await methods.putWebhookAlertPrefs(preferences);

    const hook = "/api/v1/webhooks/hook%2Fone";
    expect(calls).toEqual([
      { path: "/api/v1/webhooks", init: undefined, opts: undefined },
      {
        path: "/api/v1/webhooks",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: hook,
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      { path: `${hook}/health`, init: undefined, opts: undefined },
      {
        path: `${hook}/re-enable`,
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: hook,
        init: {
          method: "PATCH",
          body: JSON.stringify({ status: "paused" }),
        },
        opts: undefined,
      },
      {
        path: hook,
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/alert-prefs",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/alert-prefs",
        init: { method: "PUT", body: JSON.stringify(preferences) },
        opts: undefined,
      },
    ]);
  });

  it("preserves inbound replay, saved payload, and environment transports", async () => {
    const replayResponse = {
      ok: true as const,
      queued: true as const,
      replay_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      matches: [
        {
          trigger_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          name: "Paid invoice",
          subscriber_email: "reader@example.test",
          action_type: "add_to_sequence",
          action_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          queued: true,
          executed: false,
        },
        {
          trigger_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          name: "Invalid target",
          subscriber_email: "",
          action_type: "add_tag",
          action_target_id: "",
          executed: false,
          error: "configured action target is missing",
        },
      ],
    };
    const { calls, methods } = createHarness([{ data: replayResponse }]);
    const payload = {
      name: "Stripe invoice paid",
      direction: "outbound" as const,
      body: { type: "invoice.paid" },
    };

    const replay = await methods.replayInboundEvent("hook/one", "event/one", {
      idempotencyKey: "replay-operation-1",
    });
    await methods.listWebhookTestPayloads("hook/one", "outbound");
    await methods.createWebhookTestPayload("hook/one", payload);
    await methods.deleteWebhookTestPayload("payload/one");
    await methods.setWebhookEnvironment("hook/one", "staging");

    expect(replay).toEqual({
      data: {
        ...replayResponse,
        matches: [
          replayResponse.matches[0],
          { ...replayResponse.matches[1], queued: false },
        ],
      },
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/inbound-webhooks/hook%2Fone/events/event%2Fone/replay",
        init: {
          method: "POST",
          headers: { "Idempotency-Key": "replay-operation-1" },
        },
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/hook%2Fone/test-payloads?direction=outbound",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/hook%2Fone/test-payloads",
        init: { method: "POST", body: JSON.stringify(payload) },
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/test-payloads/payload%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/hook%2Fone/environment",
        init: {
          method: "PATCH",
          body: JSON.stringify({ environment: "staging" }),
        },
        opts: undefined,
      },
    ]);
  });

  it.each([
    {
      label: "missing top-level queued receipt",
      payload: {
        ok: true,
        replay_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        matches: [],
      },
    },
    {
      label: "malformed match queue state",
      payload: {
        ok: true,
        queued: true,
        replay_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        matches: [
          {
            trigger_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            name: "Paid invoice",
            subscriber_email: "reader@example.test",
            action_type: "add_to_sequence",
            action_target_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            queued: "yes",
            executed: false,
          },
        ],
      },
    },
  ])("fails closed on replay response with $label", async ({ payload }) => {
    const { methods } = createHarness([{ data: payload }]);

    const replay = await methods.replayInboundEvent("hook", 401, {
      idempotencyKey: "019c0000-0000-7000-8000-000000000001",
    });

    expect(replay.data).toBeUndefined();
    expect(replay.error).toMatchObject({
      kind: "parse",
      code: "inbound_webhook_contract",
    });
  });

  it("preserves delivery listing, replay, and synthetic-test transports", async () => {
    const { calls, methods } = createHarness();

    await methods.listWebhookDeliveries("hook/one", { limit: 40 });
    await methods.retryWebhookDelivery("hook/one", "delivery/one");
    await methods.testWebhook("hook/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/webhooks/hook%2Fone/deliveries?limit=40",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/hook%2Fone/deliveries/delivery%2Fone/replay",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/webhooks/hook%2Fone/test",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("retains empty-query defaults and passes request errors through unchanged", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods, streamPaths } = createHarness([expectedError]);

    await expect(methods.listInboundWebhookEvents("hook/one")).resolves.toBe(
      expectedError,
    );
    await methods.listProductEvents();
    await methods.getProductEventCatalog();
    await methods.getProductEventStats();
    expect(methods.productEventStreamUrl()).toBe(
      "https://api.example.test/api/v1/track/stream",
    );
    await expect(methods.productEventStreamUrlAuthed()).resolves.toBe(
      "stream:/api/v1/track/stream",
    );
    expect(methods.productEventsCsvUrl()).toBe(
      "https://api.example.test/api/v1/track/events.csv",
    );
    await expect(methods.productEventsCsvUrlAuthed()).resolves.toBe(
      "stream:/api/v1/track/events.csv",
    );
    await methods.listWebhookTestPayloads("hook/one");
    await methods.listWebhookDeliveries("hook/one");

    expect(streamPaths).toEqual([
      "/api/v1/track/stream",
      "/api/v1/track/events.csv",
    ]);
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/inbound-webhooks/hook%2Fone/events",
      "/api/v1/track/events",
      "/api/v1/track/catalog",
      "/api/v1/track/stats",
      "/api/v1/webhooks/hook%2Fone/test-payloads",
      "/api/v1/webhooks/hook%2Fone/deliveries",
    ]);
  });
});
