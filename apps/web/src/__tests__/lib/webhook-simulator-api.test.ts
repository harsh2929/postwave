// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The webhook simulator's three server calls, asserted at the one transport
// every client funnels through (global fetch), plus the failure classifier
// that decides whether a failed fire may have reached the receiver.
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import {
  fireWebhookPlayground,
  getWebhookPlaygroundFire,
  listSimulatorTargets,
  playgroundFireBody,
  type PlaygroundFireRequest,
} from "@/lib/developer-reference-api";
import {
  classifyFireFailure,
  mintSimulatorFire,
  validateSimulatorPayload,
  webhookFireReadinessReason,
} from "@/lib/webhook-simulator-model";

const FIRE = "0190f5c2-7b1a-7c3d-8e4f-5a6b7c8d9e0f";
const WEBHOOK = "7f3c2e10-1b2a-4c3d-8e4f-5a6b7c8d9e0f";

function request(
  overrides: Partial<PlaygroundFireRequest> = {},
): PlaygroundFireRequest {
  return {
    fireId: FIRE,
    idempotencyKey: `webhook-playground:${FIRE}`,
    webhookId: WEBHOOK,
    expectedWebhookConfigVersion: 3,
    eventType: "campaign.sent",
    payloadJSON: '{\n  "order_total": 9007199254740993\n}',
    ...overrides,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function stubFetch(
  respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      respond(new URL(String(input), "http://postwave.test"), init ?? {}),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RECEIPT = {
  fire_id: FIRE,
  event_id: "evt",
  delivery_id: `playground-${FIRE}`,
  url: "https://hooks.example.test/…",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: { type: "campaign.sent" },
  signature: "sha256=abc",
  requested_at: "2026-09-12T10:00:00Z",
  status_code: 202,
  response_body: "accepted",
  latency_ms: 41,
  outcome: "receiver_responded",
  ambiguous: false,
  response_body_truncated: false,
};

describe("POST /api/v1/outbound-webhooks/{id}/playground/fire", () => {
  it("sends one live attempt: exact bytes, the retained key, JSON content type", async () => {
    const fetchMock = stubFetch(() => json(200, RECEIPT));

    const result = await fireWebhookPlayground(request());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input), "http://postwave.test");
    expect(init?.method).toBe("POST");
    expect(url.pathname).toBe(
      `/api/v1/outbound-webhooks/${WEBHOOK}/playground/fire`,
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("Idempotency-Key")).toBe(`webhook-playground:${FIRE}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    // The payload text is embedded verbatim — re-serialising would round the
    // integer and change the bytes the server hashed under the key.
    expect(init?.body).toBe(
      `{"fire_id":"${FIRE}","event_type":"campaign.sent","expected_webhook_config_version":3,"payload":{\n  "order_total": 9007199254740993\n}}`,
    );
    expect(init?.body).toBe(playgroundFireBody(request()));
    expect(result?.status_code).toBe(202);
    expect(result?.fire_id).toBe(FIRE);
  });

  it("encodes the destination id into its path segment", async () => {
    const fetchMock = stubFetch(() => json(200, RECEIPT));
    await fireWebhookPlayground(request({ webhookId: "hook/a" }));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/v1/outbound-webhooks/hook%2Fa/playground/fire",
    );
  });

  it("returns null for a 2xx that is not a receipt for this fire", async () => {
    stubFetch(() => json(200, { ...RECEIPT, fire_id: "someone-else" }));
    await expect(fireWebhookPlayground(request())).resolves.toBeNull();
  });

  it("surfaces the rate limit's own sentence and never retries the 429", async () => {
    const fetchMock = stubFetch(() =>
      json(
        429,
        {
          error: {
            code: "tenant_rate_limited",
            message:
              "per-tenant rate limit exceeded; retry after the Retry-After window",
          },
        },
        { "retry-after": "30" },
      ),
    );

    const error = await fireWebhookPlayground(request()).catch(
      (caught: unknown) => caught,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(429);
    expect((error as ApiError).retryAfterSeconds).toBe(30);
    const failure = classifyFireFailure(error, FIRE);
    expect(failure).toEqual({
      kind: "not_dispatched",
      code: "tenant_rate_limited",
      message:
        "per-tenant rate limit exceeded; retry after the Retry-After window",
    });
  });

  it("does not replay a 5xx: the receiver may already have been contacted", async () => {
    const fetchMock = stubFetch(() =>
      json(502, { error: { code: "bad_gateway", message: "upstream" } }),
    );
    const error = await fireWebhookPlayground(request()).catch(
      (caught: unknown) => caught,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(classifyFireFailure(error, FIRE)).toMatchObject({
      kind: "ambiguous",
      cancelled: false,
    });
  });
});

describe("GET /api/v1/outbound-webhooks/playground/fires/{fire_id}", () => {
  it("reads the receipt for exactly this fire, once", async () => {
    const fetchMock = stubFetch(() =>
      json(200, {
        fire_id: FIRE,
        webhook_id: WEBHOOK,
        event_type: "campaign.sent",
        delivery_id: `playground-${FIRE}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-09-12T10:00:00Z",
        completed_at: "2026-09-12T10:00:01Z",
      }),
    );

    const receipt = await getWebhookPlaygroundFire(FIRE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("GET");
    expect(new URL(String(input), "http://postwave.test").pathname).toBe(
      `/api/v1/outbound-webhooks/playground/fires/${FIRE}`,
    );
    expect(receipt).toMatchObject({
      fire_id: FIRE,
      state: "completed",
      receiver_status_code: 202,
    });
  });
});

describe("GET /api/v1/outbound-webhooks (simulator targets)", () => {
  it("asks for one page of 200 and follows the opaque cursor", async () => {
    const fetchMock = stubFetch(() =>
      json(200, {
        webhooks: [
          {
            id: WEBHOOK,
            url: "https://hooks.example.test/…",
            active: true,
            config_version: 3,
            events: ["campaign.sent"],
            url_status: "ready",
            auth_config_status: "ready",
            delivery_policy_status: "ready",
          },
        ],
        next_cursor: "c2",
      }),
    );

    const first = await listSimulatorTargets();
    await listSimulatorTargets("c2");

    const firstURL = new URL(String(fetchMock.mock.calls[0][0]), "http://postwave.test");
    const secondURL = new URL(String(fetchMock.mock.calls[1][0]), "http://postwave.test");
    expect(firstURL.pathname).toBe("/api/v1/outbound-webhooks");
    expect(firstURL.searchParams.get("limit")).toBe("200");
    expect(firstURL.searchParams.has("cursor")).toBe(false);
    expect(secondURL.searchParams.get("cursor")).toBe("c2");
    expect(first.next_cursor).toBe("c2");
    expect(first.webhooks[0]).toMatchObject({ id: WEBHOOK, config_version: 3 });
  });
});

describe("classifyFireFailure", () => {
  it("fences only what may have reached the receiver", () => {
    const http = (status: number, code: string, body?: unknown) =>
      new ApiError("server sentence", status, body, { code });

    expect(
      classifyFireFailure(
        http(410, "playground_fire_receipt_expired", {
          fire_id: FIRE,
          state: "receipt_expired",
        }),
        FIRE,
      ).kind,
    ).toBe("receipt_expired");
    // A 410 naming a different identity proves nothing about this one.
    expect(
      classifyFireFailure(
        http(410, "playground_fire_receipt_expired", {
          fire_id: "other",
          state: "receipt_expired",
        }),
        FIRE,
      ).kind,
    ).toBe("ambiguous");
    expect(
      classifyFireFailure(http(409, "playground_fire_outcome_pending"), FIRE)
        .kind,
    ).toBe("pending");
    expect(classifyFireFailure(http(409, "webhook_changed"), FIRE)).toEqual({
      kind: "not_dispatched",
      code: "webhook_changed",
      message: "server sentence",
    });
    expect(classifyFireFailure(http(422, "idempotency_key_request_mismatch"), FIRE).kind).toBe(
      "not_dispatched",
    );
    expect(classifyFireFailure(http(408, "timeout"), FIRE).kind).toBe(
      "ambiguous",
    );
    expect(
      classifyFireFailure(
        new ApiError("Request was cancelled", 0, undefined, {
          code: "request_aborted",
          kind: "aborted",
        }),
        FIRE,
      ),
    ).toMatchObject({ kind: "ambiguous", cancelled: true });
    expect(
      classifyFireFailure(
        new ApiError("You appear to be offline", 0, undefined, {
          code: "offline",
          kind: "offline",
        }),
        FIRE,
      ).kind,
    ).toBe("not_dispatched");
    expect(classifyFireFailure(new TypeError("boom"), FIRE).kind).toBe(
      "ambiguous",
    );
  });
});

describe("simulator model", () => {
  it("mints a fire whose idempotency key is bound to its fire id", () => {
    const minted = mintSimulatorFire(
      { id: WEBHOOK, config_version: 3 },
      "campaign.sent",
      "{}",
    );
    expect(minted.fireId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(minted.idempotencyKey).toBe(`webhook-playground:${minted.fireId}`);
    expect(minted.expectedWebhookConfigVersion).toBe(3);
  });

  it("refuses payloads the server would refuse", () => {
    expect(validateSimulatorPayload('{"a":1}').ok).toBe(true);
    expect(validateSimulatorPayload("[]").ok).toBe(false);
    expect(validateSimulatorPayload("{").ok).toBe(false);
    expect(validateSimulatorPayload(`${" ".repeat(262_143)}{}`).ok).toBe(false);
  });

  it("withholds a fire from a destination that cannot take one, with the reason", () => {
    const ready = {
      id: WEBHOOK,
      url: "https://hooks.example.test/…",
      description: "",
      active: true,
      config_version: 3,
      signing_algorithm: "hmac_sha256",
      url_status: "ready",
      auth_config_status: "ready",
      delivery_policy_status: "ready",
    };
    expect(webhookFireReadinessReason(ready)).toBeNull();
    expect(webhookFireReadinessReason({ ...ready, active: false })).toMatch(
      /paused/,
    );
    expect(
      webhookFireReadinessReason({ ...ready, url_status: "invalid" }),
    ).toMatch(/destination URL/);
    expect(
      webhookFireReadinessReason({ ...ready, config_version: null }),
    ).toMatch(/revision/);
  });
});
