import type { Page, Route } from "@playwright/test";

import { waitForPrimaryNavigation } from "./fixture";

export const OUTBOUND_ID = "11111111-1111-4111-8111-111111111111";
export const BLOCKED_OUTBOUND_ID = "77777777-7777-4777-8777-777777777777";
export const INBOUND_ID = "22222222-2222-4222-8222-222222222222";
export const LIST_ID = "88888888-8888-4888-8888-888888888888";
export const LIST_WEBHOOK_ID = "99999999-9999-4999-8999-999999999999";
export const OUTBOUND_CURSOR = "b3V0Ym91bmQtbmV4dA==";
export const INBOUND_CURSOR = "aW5ib3VuZC1uZXh0";
export const LIST_WEBHOOK_CURSOR = "bGlzdC13ZWJob29rLW5leHQ=";

export const PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvisualEvidenceOnlyKeyMaterial",
  "-----END PUBLIC KEY-----",
].join("\n");

export const outboundWebhook = {
  id: OUTBOUND_ID,
  tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  url: "https://receiver.example.test/…?…",
  url_status: "ready",
  description: "Customer lifecycle receiver",
  events: ["campaign.sent", "subscriber.added", "list.subscriber.added"],
  active: true,
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:30:00.000Z",
  last_succeeded_at: "2026-07-23T09:00:00.000Z",
  last_failed_at: "2026-07-23T08:55:00.000Z",
  consecutive_failures: 1,
  signing_algorithm: "hmac_sha256",
  auth_config: {
    type: "headers",
    header_names: ["X-Api-Key"],
    secret_redacted: true,
  },
  auth_config_status: "ready",
  filter_expression: "subscriber.status == active",
  transform_template: {
    email: "/subscriber/email",
    status: "/subscriber/status",
  },
  delivery_policy_status: "ready",
  config_version: 1,
} as const;

export const blockedOutboundWebhook = {
  ...outboundWebhook,
  id: BLOCKED_OUTBOUND_ID,
  url: "https://legacy-receiver.example.test/…?…",
  url_status: "invalid",
  description: "Legacy receiver needs repair",
  active: false,
  auth_config: undefined,
  filter_expression: undefined,
  transform_template: undefined,
  last_succeeded_at: undefined,
  last_failed_at: undefined,
  consecutive_failures: 0,
} as const;

export const inboundEndpoint = {
  id: INBOUND_ID,
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "billing-events-a1b2c3",
  name: "Billing event adapter",
  enabled: true,
  transform_jq: "{ type, invoice_id }",
  createdAt: "2026-07-22T10:00:00.000Z",
} as const;

export const listScopedWebhook = {
  id: LIST_WEBHOOK_ID,
  url: "https://list-receiver.example.test/…?…",
  description: "VIP audience receiver",
  events: ["list.subscriber.added"],
  active: true,
  url_status: "ready",
  auth_config_status: "ready",
  delivery_policy_status: "ready",
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:30:00.000Z",
  last_succeeded_at: "2026-07-23T09:00:00.000Z",
} as const;

export interface WebhookEvidenceOptions {
  outboundNextCursor?: boolean;
  outboundPageFailureCount?: number;
  inboundNextCursor?: boolean;
  inboundPageFailureCount?: number;
  listWebhookNextCursor?: boolean;
  listWebhookPageFailureCount?: number;
  filteredOutboundTest?: boolean;
  filteredSimulatorFire?: boolean;
  triggerFirstLoadFails?: boolean;
}

export interface WebhookEvidenceCounters {
  outboundList: number;
  outboundPage: number;
  inboundList: number;
  inboundEvents: number;
  inboundEventPage: number;
  inboundReplay: number;
  simulatorCatalog: number;
  simulatorFire: number;
  listCatalog: number;
  listWebhookCatalog: number;
  listWebhookPage: number;
  listWebhookCreate: number;
  protectedRequests: number;
  createdAlgorithms: string[];
}

export interface WebhookEvidenceHarness {
  counters: WebhookEvidenceCounters;
}

type UserRole = "admin" | "viewer";

export async function fulfill(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installRoleOverride(
  page: Page,
  role: UserRole,
): Promise<void> {
  await page.route("**/api/v1/auth/me", (route) =>
    fulfill(route, {
      user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: `webhook-${role}@example.invalid`,
      role,
      effective_role: role,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Moosewave",
      workspace_slug: "webhook-evidence",
    }),
  );
}

function outboundDeliveryRows() {
  return [
    {
      id: "44444444-4444-4444-8444-444444444442",
      webhook_id: OUTBOUND_ID,
      event_type: "subscriber.added",
      attempt_count: 7,
      status: "exhausted",
      last_status_code: 503,
      last_error:
        "receiver returned https://receiver.example.test/failure?token=private-receiver-token&trace=trace-visible",
      created_at: "2026-07-23T08:55:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444441",
      webhook_id: OUTBOUND_ID,
      event_type: "campaign.sent",
      attempt_count: 1,
      status: "delivered",
      last_status_code: 202,
      last_response_body_truncated: "accepted",
      created_at: "2026-07-23T08:59:58.000Z",
      delivered_at: "2026-07-23T09:00:00.000Z",
    },
    {
      id: "44444444-4444-4444-8444-444444444443",
      webhook_id: OUTBOUND_ID,
      event_type: "list.subscriber.added",
      attempt_count: 0,
      status: "skipped",
      last_error: "endpoint deleted before first attempt",
      created_at: "2026-07-23T08:40:00.000Z",
    },
  ];
}

function outboundHealth() {
  return {
    deliveries_total: 25,
    deliveries_succeeded: 22,
    deliveries_failed: 1,
    deliveries_pending: 1,
    deliveries_skipped: 1,
    latency_p50_ms: 184,
    latency_p99_ms: 920,
    status_breakdown: {
      delivered: 22,
      exhausted: 1,
      pending: 1,
      skipped: 1,
    },
    top_errors: [
      { status_code: 503, message: "Receiver unavailable", count: 1 },
    ],
    consecutive_failures: 1,
    auto_disabled: false,
    last_succeeded_at: "2026-07-23T09:00:00.000Z",
    last_failed_at: "2026-07-23T08:55:00.000Z",
  };
}

function inboundEvents() {
  return [
    {
      id: 401,
      endpoint_id: INBOUND_ID,
      headers: {
        "content-type": "application/json",
        "x-postwave-event-id": "sha256:event-401",
      },
      body: '{"type":"invoice.paid","invoice_id":"inv_42"}',
      signature_valid: true,
      received_at: "2026-07-23T09:05:00.000Z",
    },
    {
      id: 402,
      endpoint_id: INBOUND_ID,
      headers: {
        "content-type": "application/json",
        "x-postwave-event-id": "sha256:event-402",
      },
      body: '{"type":"invoice.tampered","token":"must-stay-hidden"}',
      signature_valid: false,
      received_at: "2026-07-23T09:04:00.000Z",
    },
  ];
}

function triggerFixture() {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    webhook_id: INBOUND_ID,
    name: "Paid invoice",
    active: true,
    match_jsonpath: "$.type",
    match_operator: "equals",
    match_value: "invoice.paid",
    email_jsonpath: "$.customer.email",
    action_type: "add_tag",
    action_target_id: "paid-customer",
    fired_count: 4,
    last_fired_at: "2026-07-23T09:06:00.000Z",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-23T09:06:00.000Z",
  };
}

function createdOutbound(algorithm: string): Record<string, unknown> {
  const asymmetric = algorithm !== "hmac_sha256";
  const webhook = {
    ...outboundWebhook,
    id: "12121212-1212-4121-8121-121212121212",
    description: "Visual evidence receiver",
    signing_algorithm: algorithm,
    ...(asymmetric ? { signing_public_key: PUBLIC_KEY } : {}),
  };
  return {
    webhook,
    ...(asymmetric
      ? { public_key_pem: PUBLIC_KEY }
      : { signing_secret: "whsec_visual_shown_once_7f9e2d" }),
  };
}

function simulatorFire(filtered: boolean, fireID: string) {
  const identity = {
    fire_id: fireID,
    event_id: "45454545-4545-4454-8454-454545454544",
    delivery_id: `playground-${fireID}`,
  };
  return filtered
    ? {
        ...identity,
        url: "https://receiver.example.test/…?…",
        method: "POST",
        headers: {},
        body: { event: "campaign.sent", data: { campaign_id: "cmp_visual" } },
        signature: "",
        requested_at: "2026-07-23T09:10:00.000Z",
        status_code: 204,
        response_body: "",
        latency_ms: 0,
        filtered: true,
        outcome: "filtered",
        ambiguous: false,
        response_body_truncated: false,
      }
    : {
        ...identity,
        url: "https://receiver.example.test/…?…",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Postwave-Signature": "t=1784797800,v1=visual-signature",
        },
        body: { event: "campaign.sent", data: { campaign_id: "cmp_visual" } },
        signature: "t=1784797800,v1=visual-signature",
        requested_at: "2026-07-23T09:10:00.000Z",
        status_code: 202,
        response_body: "accepted",
        latency_ms: 184,
        filtered: false,
        outcome: "receiver_responded",
        ambiguous: false,
        response_body_truncated: false,
      };
}

function listDeliveryRows() {
  return [
    {
      id: "56565656-5656-4565-8565-565656565656",
      webhook_id: LIST_WEBHOOK_ID,
      event_type: "list.subscriber.added",
      attempt_count: 1,
      status: "delivered",
      last_status_code: 202,
      last_response_body_truncated: "accepted",
      created_at: "2026-07-23T09:00:00.000Z",
      delivered_at: "2026-07-23T09:00:01.000Z",
    },
  ];
}

export async function installWebhookEvidenceApi(
  page: Page,
  options: WebhookEvidenceOptions = {},
): Promise<WebhookEvidenceHarness> {
  const counters: WebhookEvidenceCounters = {
    outboundList: 0,
    outboundPage: 0,
    inboundList: 0,
    inboundEvents: 0,
    inboundEventPage: 0,
    inboundReplay: 0,
    simulatorCatalog: 0,
    simulatorFire: 0,
    listCatalog: 0,
    listWebhookCatalog: 0,
    listWebhookPage: 0,
    listWebhookCreate: 0,
    protectedRequests: 0,
    createdAlgorithms: [],
  };
  let outboundPageFailures = options.outboundPageFailureCount ?? 0;
  let inboundPageFailures = options.inboundPageFailureCount ?? 0;
  let listPageFailures = options.listWebhookPageFailureCount ?? 0;
  let triggerLoads = 0;
  let outboundState: Record<string, unknown> = { ...outboundWebhook };
  let inboundState: Record<string, unknown> = { ...inboundEndpoint };

  await page.route("**/api/v1/outbound-webhooks**", async (route) => {
    counters.protectedRequests += 1;
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/v1/outbound-webhooks") {
      counters.outboundList += 1;
      if (url.searchParams.get("cursor") === OUTBOUND_CURSOR) {
        counters.outboundPage += 1;
        if (outboundPageFailures > 0) {
          outboundPageFailures -= 1;
          await fulfill(
            route,
            {
              error: {
                code: "temporary",
                message: "Older destinations are temporarily unavailable",
              },
            },
            503,
          );
          return;
        }
        await fulfill(route, {
          webhooks: [
            {
              ...blockedOutboundWebhook,
              id: "13131313-1313-4131-8131-131313131313",
              description: "Recovered pagination receiver",
            },
          ],
          next_cursor: "",
        });
        return;
      }
      await fulfill(route, {
        webhooks: [outboundState, blockedOutboundWebhook],
        next_cursor: options.outboundNextCursor ? OUTBOUND_CURSOR : "",
      });
      return;
    }

    if (
      request.method() === "GET" &&
      path === "/api/v1/outbound-webhooks/playground/events"
    ) {
      counters.simulatorCatalog += 1;
      await fulfill(route, {
        events: [
          {
            event_type: "campaign.sent",
            sample_payload: {
              event: "campaign.sent",
              data: { campaign_id: "cmp_visual" },
            },
          },
          {
            event_type: "subscriber.added",
            sample_payload: {
              event: "subscriber.added",
              data: { email: "customer@example.invalid" },
            },
          },
        ],
      });
      return;
    }

    if (request.method() === "POST" && path.endsWith("/playground/fire")) {
      counters.simulatorFire += 1;
      const body = request.postDataJSON() as { fire_id?: unknown };
      const fireID = typeof body.fire_id === "string" ? body.fire_id : "";
      const canonicalFireID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          fireID,
        );
      if (
        !canonicalFireID ||
        request.headers()["idempotency-key"] !== `webhook-playground:${fireID}`
      ) {
        await fulfill(
          route,
          {
            error: {
              code: "invalid_playground_fire_identity",
              message:
                "The visual request must bind one canonical fire ID to its idempotency key.",
            },
          },
          400,
        );
        return;
      }
      await fulfill(
        route,
        simulatorFire(options.filteredSimulatorFire === true, fireID),
      );
      return;
    }

    if (
      request.method() === "GET" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}/deliveries`
    ) {
      await fulfill(route, {
        deliveries: outboundDeliveryRows(),
        next_cursor: "",
      });
      return;
    }

    if (
      request.method() === "GET" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}/health`
    ) {
      await fulfill(route, outboundHealth());
      return;
    }

    if (
      request.method() === "POST" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}/test`
    ) {
      const filtered = options.filteredOutboundTest === true;
      await fulfill(route, {
        webhook_id: OUTBOUND_ID,
        status_code: filtered ? 204 : 202,
        signed: !filtered,
        signature: filtered ? "" : "t=1784797800,v1=visual-signature",
        response: filtered ? "" : "accepted",
        filtered,
      });
      return;
    }

    if (
      request.method() === "POST" &&
      path ===
        "/api/v1/outbound-webhooks/deliveries/44444444-4444-4444-8444-444444444442/replay"
    ) {
      await fulfill(
        route,
        {
          delivery_id: "45454545-4545-4454-8454-454545454545",
          replayed_from: "44444444-4444-4444-8444-444444444442",
          status: "pending",
          replayed_at: "2026-07-23T09:11:00.000Z",
        },
        202,
      );
      return;
    }

    if (
      request.method() === "PATCH" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}`
    ) {
      outboundState = {
        ...outboundState,
        ...(request.postDataJSON() as Record<string, unknown>),
        id: OUTBOUND_ID,
      };
      await fulfill(route, outboundState);
      return;
    }

    if (
      request.method() === "DELETE" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}`
    ) {
      await fulfill(route, { ok: true, deleted: true, deactivated: false });
      return;
    }

    if (
      request.method() === "POST" &&
      path === `/api/v1/outbound-webhooks/${OUTBOUND_ID}/rotate-secret`
    ) {
      await fulfill(route, createdOutbound("hmac_sha256"));
      return;
    }

    if (request.method() === "POST" && path === "/api/v1/outbound-webhooks") {
      const body = request.postDataJSON() as { algorithm?: string };
      const algorithm = body.algorithm ?? "hmac_sha256";
      counters.createdAlgorithms.push(algorithm);
      await fulfill(route, createdOutbound(algorithm), 201);
      return;
    }

    await fulfill(
      route,
      { error: { code: "unexpected_webhook_evidence_request", path } },
      500,
    );
  });

  await page.route("**/api/v1/inbound-webhooks**", async (route) => {
    counters.protectedRequests += 1;
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/v1/inbound-webhooks") {
      counters.inboundList += 1;
      await fulfill(route, {
        items: [inboundState],
        next_cursor: "",
      });
      return;
    }

    if (
      request.method() === "PATCH" &&
      path === `/api/v1/inbound-webhooks/${INBOUND_ID}`
    ) {
      inboundState = {
        ...inboundState,
        ...(request.postDataJSON() as Record<string, unknown>),
        id: INBOUND_ID,
      };
      await fulfill(route, inboundState);
      return;
    }

    if (
      request.method() === "POST" &&
      path === "/api/v1/inbound-webhooks/transform/preview"
    ) {
      await fulfill(route, {
        body: { type: "invoice.paid", invoice_id: "inv_42" },
      });
      return;
    }

    if (
      request.method() === "GET" &&
      path === `/api/v1/inbound-webhooks/${INBOUND_ID}/events`
    ) {
      counters.inboundEvents += 1;
      if (url.searchParams.get("cursor") === INBOUND_CURSOR) {
        counters.inboundEventPage += 1;
        if (inboundPageFailures > 0) {
          inboundPageFailures -= 1;
          await fulfill(
            route,
            {
              error: {
                code: "temporary",
                message: "Older inbound events are temporarily unavailable",
              },
            },
            503,
          );
          return;
        }
        await fulfill(route, {
          items: [
            {
              ...inboundEvents()[0],
              id: 403,
              body: '{"type":"invoice.refunded","invoice_id":"inv_41"}',
              received_at: "2026-07-23T08:00:00.000Z",
            },
          ],
          next_cursor: "",
        });
        return;
      }
      await fulfill(route, {
        items: inboundEvents(),
        next_cursor: options.inboundNextCursor ? INBOUND_CURSOR : "",
      });
      return;
    }

    if (
      request.method() === "POST" &&
      path === `/api/v1/inbound-webhooks/${INBOUND_ID}/events/401/replay`
    ) {
      counters.inboundReplay += 1;
      await fulfill(
        route,
        {
          ok: true,
          queued: true,
          replay_id: "34343434-3434-4343-8343-343434343434",
          matches: [
            {
              trigger_id: "33333333-3333-4333-8333-333333333333",
              name: "Paid invoice",
              subscriber_email: "customer@example.invalid",
              action_type: "add_tag",
              action_target_id: "paid-customer",
              queued: true,
              executed: false,
            },
          ],
        },
        202,
      );
      return;
    }

    if (path.endsWith("/triggers") && request.method() === "GET") {
      triggerLoads += 1;
      if (options.triggerFirstLoadFails && triggerLoads === 1) {
        await fulfill(
          route,
          {
            error: {
              code: "temporary",
              message: "Trigger catalog unavailable",
            },
          },
          503,
        );
      } else {
        await fulfill(route, { items: [triggerFixture()] });
      }
      return;
    }

    if (path.endsWith("/triggers") && request.method() === "POST") {
      await fulfill(
        route,
        {
          ...triggerFixture(),
          ...(request.postDataJSON() as Record<string, unknown>),
        },
        201,
      );
      return;
    }

    if (path.includes("/triggers/") && request.method() === "PATCH") {
      await fulfill(route, {
        ...triggerFixture(),
        ...(request.postDataJSON() as Record<string, unknown>),
      });
      return;
    }

    if (path.includes("/triggers/") && request.method() === "DELETE") {
      await fulfill(route, { ok: true });
      return;
    }

    await fulfill(
      route,
      { error: { code: "unexpected_inbound_evidence_request", path } },
      500,
    );
  });

  await page.route("**/api/v1/lists**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/v1/lists") {
      counters.listCatalog += 1;
      await fulfill(route, {
        data: {
          results: [
            {
              id: 42,
              postwave_uuid: LIST_ID,
              name: "VIP customers",
              type: "private",
              optin: "double",
              subscriber_count: 1284,
              description: "High-value customers with active subscriptions",
              created_at: "2026-07-20T09:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          per_page: 25,
        },
      });
      return;
    }

    const webhookRoot = `/api/v1/lists/${LIST_ID}/webhooks`;
    if (path.startsWith(webhookRoot)) {
      counters.protectedRequests += 1;
      if (request.method() === "GET" && path === webhookRoot) {
        counters.listWebhookCatalog += 1;
        if (url.searchParams.get("cursor") === LIST_WEBHOOK_CURSOR) {
          counters.listWebhookPage += 1;
          if (listPageFailures > 0) {
            listPageFailures -= 1;
            await fulfill(
              route,
              {
                error: {
                  code: "temporary",
                  message: "Older list webhooks are temporarily unavailable",
                },
              },
              503,
            );
            return;
          }
          await fulfill(route, {
            list_id: LIST_ID,
            webhooks: [
              {
                ...listScopedWebhook,
                id: "67676767-6767-4676-8676-676767676767",
                url: "https://recovered-list-receiver.example.test/…?…",
                description: "Recovered older audience receiver",
              },
            ],
            next_cursor: "",
          });
          return;
        }
        await fulfill(route, {
          list_id: LIST_ID,
          webhooks: [listScopedWebhook],
          next_cursor: options.listWebhookNextCursor ? LIST_WEBHOOK_CURSOR : "",
        });
        return;
      }

      if (request.method() === "POST" && path === webhookRoot) {
        counters.listWebhookCreate += 1;
        await fulfill(
          route,
          {
            ...listScopedWebhook,
            id: "78787878-7878-4787-8787-787878787878",
            url: "https://new-list-receiver.example.test/…?…",
            description: "New list receiver",
            signing_secret: "list_whsec_visual_shown_once_29ef",
          },
          201,
        );
        return;
      }

      if (
        request.method() === "GET" &&
        path === `${webhookRoot}/${LIST_WEBHOOK_ID}/deliveries`
      ) {
        await fulfill(route, {
          deliveries: listDeliveryRows(),
          next_cursor: "",
        });
        return;
      }

      if (
        request.method() === "POST" &&
        path === `${webhookRoot}/${LIST_WEBHOOK_ID}/test`
      ) {
        await fulfill(route, {
          webhook_id: LIST_WEBHOOK_ID,
          status_code: 204,
          signed: false,
          signature: "",
          response: "",
          filtered: true,
        });
        return;
      }

      if (
        request.method() === "POST" &&
        path === `${webhookRoot}/${LIST_WEBHOOK_ID}/rotate-secret`
      ) {
        await fulfill(route, {
          ...listScopedWebhook,
          signing_secret: "list_whsec_visual_rotated_once_f730",
        });
        return;
      }

      if (
        request.method() === "DELETE" &&
        path === `${webhookRoot}/${LIST_WEBHOOK_ID}`
      ) {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
    }

    // The Lists page and its overview tab read several optional aggregates.
    // Empty successful envelopes keep those unrelated panels deterministic.
    await fulfill(route, {});
  });

  await page.route("**/api/v1/voice/sequences", (route) =>
    fulfill(route, {
      items: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Customer onboarding",
        },
      ],
    }),
  );
  await page.route("**/api/v1/tags**", (route) =>
    fulfill(route, {
      items: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          name: "paid-customer",
        },
      ],
    }),
  );

  return { counters };
}

export async function bootEvidenceRoute({
  page,
  bootApp,
  path,
  role = "admin",
  options,
}: {
  page: Page;
  bootApp: (page: Page) => Promise<void>;
  path: string;
  role?: UserRole;
  options?: WebhookEvidenceOptions;
}): Promise<WebhookEvidenceHarness> {
  await bootApp(page);
  await installRoleOverride(page, role);
  const harness = await installWebhookEvidenceApi(page, options);
  await page.goto(path);
  await waitForPrimaryNavigation(page);
  return harness;
}
