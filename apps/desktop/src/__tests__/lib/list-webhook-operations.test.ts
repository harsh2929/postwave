import { describe, expect, it } from "vitest";

import type { ApiResult } from "../../lib/api/result";
import {
  createListWebhookOperations,
  type ListWebhookRequester,
  type ListWebhookRequestOptions,
} from "../../lib/api/list-webhook-operations";

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const WEBHOOK_ID = "22222222-2222-4222-8222-222222222222";

function webhook() {
  return {
    id: WEBHOOK_ID,
    url: "https://receiver.example/…?…",
    description: "Membership receiver",
    events: ["list.subscriber.added"],
    active: true,
    url_status: "ready",
    auth_config_status: "ready",
    delivery_policy_status: "ready",
    created_at: "2026-07-23T08:00:00.000Z",
    updated_at: "2026-07-23T08:00:00.000Z",
  };
}

function createHarness(responses: ApiResult<unknown>[]) {
  const calls: Array<{
    path: string;
    init?: RequestInit;
    opts?: ListWebhookRequestOptions;
  }> = [];
  const queue = [...responses];
  const request: ListWebhookRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: ListWebhookRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queue.shift() ?? { data: undefined }) as ApiResult<T>;
  };
  return { calls, methods: createListWebhookOperations({ request }) };
}

describe("list webhook canonical façade", () => {
  it("uses the canonical list UUID and explicit cursor page", async () => {
    const { calls, methods } = createHarness([
      {
        data: {
          list_id: LIST_ID,
          webhooks: [webhook()],
          next_cursor: "bmV4dA",
        },
      },
    ]);

    await expect(
      methods.listListScopedWebhooks(LIST_ID, {
        limit: 500,
        cursor: "cHJldmlvdXM",
      }),
    ).resolves.toEqual({
      data: {
        list_id: LIST_ID,
        webhooks: [webhook()],
        next_cursor: "bmV4dA",
      },
    });
    expect(calls).toEqual([
      {
        path: `/api/v1/lists/${LIST_ID}/webhooks?cursor=cHJldmlvdXM&limit=200`,
        init: {},
        opts: {},
      },
    ]);
  });

  it("fails closed when canonical readiness is missing", async () => {
    const missingReadiness = webhook();
    Reflect.deleteProperty(missingReadiness, "url_status");
    const { methods } = createHarness([
      {
        data: {
          list_id: LIST_ID,
          webhooks: [missingReadiness],
          next_cursor: "",
        },
      },
    ]);

    await expect(
      methods.listListScopedWebhooks(LIST_ID),
    ).resolves.toMatchObject({
      error: {
        kind: "parse",
        code: "list_webhook_contract",
        message: expect.stringContaining("url_status"),
      },
      retryability: "not-retryable",
    });
  });

  it("fails closed when the server repeats the requested cursor", async () => {
    const { methods } = createHarness([
      {
        data: {
          list_id: LIST_ID,
          webhooks: [webhook()],
          next_cursor: "c2FtZS1jdXJzb3I",
        },
      },
    ]);

    await expect(
      methods.listListScopedWebhooks(LIST_ID, {
        cursor: "c2FtZS1jdXJzb3I",
      }),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("repeated the requested cursor"),
      },
    });
  });

  it("preserves the shown-once secret and does not send list_id in the body", async () => {
    const { calls, methods } = createHarness([
      { data: { ...webhook(), signing_secret: "pw_once_secret" } },
    ]);

    await expect(
      methods.createListScopedWebhook(
        LIST_ID,
        {
          url: "https://receiver.example/hooks/list",
          description: "Membership receiver",
          events: ["list.subscriber.added"],
        },
        {
          idempotencyKey: "create-list-webhook-stable-key",
        },
      ),
    ).resolves.toMatchObject({
      data: {
        id: WEBHOOK_ID,
        signing_secret: "pw_once_secret",
      },
    });
    expect(calls[0]).toEqual({
      path: `/api/v1/lists/${LIST_ID}/webhooks`,
      init: {
        method: "POST",
        body: JSON.stringify({
          url: "https://receiver.example/hooks/list",
          description: "Membership receiver",
          events: ["list.subscriber.added"],
        }),
        headers: {
          "Idempotency-Key": "create-list-webhook-stable-key",
        },
      },
      opts: { requireOnline: true, maxAttempts: 1 },
    });
    expect(calls[0]?.init?.body).not.toContain("list_id");
  });

  it("routes test, delivery pages, and tombstone delete through the list façade", async () => {
    const { calls, methods } = createHarness([
      {
        data: {
          webhook_id: WEBHOOK_ID,
          status_code: 204,
          signed: true,
          signature: "t=1,v1=abc",
          response: "",
          filtered: false,
        },
      },
      { data: { deliveries: [], next_cursor: "" } },
      { data: undefined },
    ]);

    await methods.testListScopedWebhook(LIST_ID, WEBHOOK_ID);
    await methods.listListScopedWebhookDeliveries(LIST_ID, WEBHOOK_ID, {
      limit: 50,
      cursor: "bmV4dA",
    });
    await methods.deleteListScopedWebhook(LIST_ID, WEBHOOK_ID);

    expect(calls.map((call) => call.path)).toEqual([
      `/api/v1/lists/${LIST_ID}/webhooks/${WEBHOOK_ID}/test`,
      `/api/v1/lists/${LIST_ID}/webhooks/${WEBHOOK_ID}/deliveries?cursor=bmV4dA&limit=50`,
      `/api/v1/lists/${LIST_ID}/webhooks/${WEBHOOK_ID}`,
    ]);
    expect(calls[0]?.opts).toEqual({ requireOnline: true, maxAttempts: 1 });
    expect(calls[2]?.init).toEqual({ method: "DELETE" });
  });

  it("rejects contradictory filtered probes and wrong-child acknowledgements", async () => {
    const { methods } = createHarness([
      {
        data: {
          webhook_id: WEBHOOK_ID,
          status_code: 204,
          signed: true,
          signature: "t=1,v1=must-not-exist",
          response: "",
          filtered: true,
        },
      },
      {
        data: {
          webhook_id: "33333333-3333-4333-8333-333333333333",
          status_code: 202,
          signed: true,
          signature: "t=1,v1=signed",
          response: "accepted",
          filtered: false,
        },
      },
    ]);

    await expect(
      methods.testListScopedWebhook(LIST_ID, WEBHOOK_ID),
    ).resolves.toMatchObject({
      error: { code: "list_webhook_contract" },
    });
    await expect(
      methods.testListScopedWebhook(LIST_ID, WEBHOOK_ID),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("does not match"),
      },
    });
  });

  it("reuses caller-stable idempotency headers for create retries and list-scoped rotation", async () => {
    const created = { ...webhook(), signing_secret: "pw_once_secret" };
    const rotated = { ...webhook(), signing_secret: "pw_rotated_secret" };
    const { calls, methods } = createHarness([
      { data: created },
      { data: created },
      { data: rotated },
    ]);
    const input = {
      url: "https://receiver.example/hooks/list",
      events: ["list.subscriber.added"] as ["list.subscriber.added"],
    };

    await methods.createListScopedWebhook(LIST_ID, input, {
      idempotencyKey: "same-logical-create",
    });
    await methods.createListScopedWebhook(LIST_ID, input, {
      idempotencyKey: "same-logical-create",
    });
    await methods.rotateListScopedWebhookSigningMaterial(
      LIST_ID,
      WEBHOOK_ID,
      1440,
      { idempotencyKey: "same-logical-rotation" },
    );

    expect(calls[0]?.init?.headers).toEqual({
      "Idempotency-Key": "same-logical-create",
    });
    expect(calls[1]?.init?.headers).toEqual({
      "Idempotency-Key": "same-logical-create",
    });
    expect(calls[2]).toEqual({
      path: `/api/v1/lists/${LIST_ID}/webhooks/${WEBHOOK_ID}/rotate-secret?grace_minutes=1440`,
      init: {
        method: "POST",
        headers: { "Idempotency-Key": "same-logical-rotation" },
      },
      opts: { requireOnline: true, maxAttempts: 1 },
    });
  });

  it("binds PATCH and delivery rows to the requested child identity", async () => {
    const otherWebhookID = "33333333-3333-4333-8333-333333333333";
    const { methods } = createHarness([
      { data: { ...webhook(), id: otherWebhookID } },
      {
        data: {
          deliveries: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              webhook_id: otherWebhookID,
              event_type: "list.subscriber.added",
              attempt_count: 1,
              status: "delivered",
              last_status_code: 204,
              created_at: "2026-07-23T08:00:00.000Z",
              delivered_at: "2026-07-23T08:01:00.000Z",
            },
          ],
          next_cursor: "",
        },
      },
    ]);

    await expect(
      methods.updateListScopedWebhook(LIST_ID, WEBHOOK_ID, { active: false }),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("does not match"),
      },
    });
    await expect(
      methods.listListScopedWebhookDeliveries(LIST_ID, WEBHOOK_ID),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("different webhook"),
      },
    });
  });

  it("rejects unknown response fields and duplicate page identities", async () => {
    const { methods } = createHarness([
      {
        data: {
          list_id: LIST_ID,
          webhooks: [{ ...webhook(), secret_hint: "must-not-pass" }],
          next_cursor: "",
        },
      },
      {
        data: {
          list_id: LIST_ID,
          webhooks: [webhook(), webhook()],
          next_cursor: "",
        },
      },
      { data: { deleted: true } },
    ]);

    await expect(
      methods.listListScopedWebhooks(LIST_ID),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("secret_hint"),
      },
    });
    await expect(
      methods.listListScopedWebhooks(LIST_ID),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("duplicate id"),
      },
    });
    await expect(
      methods.deleteListScopedWebhook(LIST_ID, WEBHOOK_ID),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("HTTP 204"),
      },
    });
  });

  it("rejects a rotation response for a different webhook", async () => {
    const { methods } = createHarness([
      {
        data: {
          ...webhook(),
          id: "33333333-3333-4333-8333-333333333333",
          signing_secret: "wrong-owner-secret",
        },
      },
    ]);

    await expect(
      methods.rotateListScopedWebhookSigningMaterial(
        LIST_ID,
        WEBHOOK_ID,
        undefined,
        { idempotencyKey: "rotation-owner-check" },
      ),
    ).resolves.toMatchObject({
      error: {
        code: "list_webhook_contract",
        message: expect.stringContaining("does not match"),
      },
    });
  });
});
