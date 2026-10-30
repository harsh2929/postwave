// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CreateWebhookInput,
  CreateWebhookResponse,
  UpdateWebhookInput,
  Webhook,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookTestResult,
} from "./webhooks-api";

const NOW = () => new Date().toISOString();

const WEBHOOKS: Webhook[] = [
  {
    id: "wh_1",
    tenantId: "tenant_demo",
    url: "https://api.acme.example/postwave/events",
    events: ["subscriber.created", "subscriber.unsubscribed", "campaign.sent"],
    status: "active",
    createdAt: "2026-03-01T10:00:00Z",
    updatedAt: "2026-04-20T10:00:00Z",
    lastDelivery: {
      id: 102,
      webhookId: "wh_1",
      event: "campaign.sent",
      statusCode: 200,
      attempt: 1,
      responseMs: 134,
      at: "2026-04-30T18:42:00Z",
    },
  },
  {
    id: "wh_2",
    tenantId: "tenant_demo",
    url: "https://hooks.zapier.com/abc123",
    events: ["subscriber.bounced", "campaign.opens.digest"],
    status: "failing",
    createdAt: "2026-02-04T10:00:00Z",
    updatedAt: "2026-04-25T10:00:00Z",
    lastDelivery: {
      id: 87,
      webhookId: "wh_2",
      event: "subscriber.bounced",
      statusCode: 503,
      attempt: 4,
      responseMs: 2089,
      error: "upstream timeout",
      at: "2026-04-30T17:11:00Z",
    },
  },
];

const DELIVERIES: Record<string, WebhookDelivery[]> = {
  wh_1: [
    {
      id: 102,
      webhookId: "wh_1",
      event: "campaign.sent",
      statusCode: 200,
      attempt: 1,
      responseMs: 134,
      at: "2026-04-30T18:42:00Z",
    },
    {
      id: 101,
      webhookId: "wh_1",
      event: "subscriber.created",
      statusCode: 200,
      attempt: 1,
      responseMs: 88,
      at: "2026-04-30T16:21:00Z",
    },
  ],
  wh_2: [
    {
      id: 87,
      webhookId: "wh_2",
      event: "subscriber.bounced",
      statusCode: 503,
      attempt: 4,
      responseMs: 2089,
      error: "upstream timeout",
      at: "2026-04-30T17:11:00Z",
    },
  ],
};

export function mockListWebhooks(): Webhook[] {
  return [...WEBHOOKS];
}

export function mockCreateWebhook(
  input: CreateWebhookInput,
): CreateWebhookResponse {
  const id = `wh_${Date.now()}`;
  const wh: Webhook = {
    id,
    tenantId: "tenant_demo",
    url: input.url,
    events: input.events,
    status: "active",
    createdAt: NOW(),
    updatedAt: NOW(),
  };
  WEBHOOKS.unshift(wh);
  DELIVERIES[id] = [];
  // Mock a stable, recognizable secret. The real backend uses 32-byte hex.
  const secret = `whsec_mock_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 14)}`;
  return { webhook: wh, secret };
}

export function mockUpdateWebhook(
  id: string,
  patch: UpdateWebhookInput,
): Webhook {
  const idx = WEBHOOKS.findIndex((w) => w.id === id);
  if (idx < 0) throw new Error("not_found");
  const cur = WEBHOOKS[idx];
  WEBHOOKS[idx] = {
    ...cur,
    url: patch.url ?? cur.url,
    events: patch.events ?? cur.events,
    status: patch.status ?? cur.status,
    updatedAt: NOW(),
  };
  return WEBHOOKS[idx];
}

export function mockReenableWebhook(id: string): void {
  mockUpdateWebhook(id, { status: "active" });
}

export function mockDeleteWebhook(id: string): void {
  const idx = WEBHOOKS.findIndex((w) => w.id === id);
  if (idx >= 0) WEBHOOKS.splice(idx, 1);
  delete DELIVERIES[id];
}

export function mockTestWebhook(id: string): WebhookTestResult {
  const responseMs = 50 + Math.floor(Math.random() * 200);
  const statusCode = 200;
  const list = DELIVERIES[id] ?? [];
  list.unshift({
    id: Date.now(),
    webhookId: id,
    event: "ping",
    statusCode,
    attempt: 1,
    responseMs,
    at: NOW(),
  });
  DELIVERIES[id] = list;
  return { ok: true, statusCode, responseMs };
}

export function mockListDeliveries(id: string): WebhookDelivery[] {
  return DELIVERIES[id] ?? [];
}

export function mockGetDelivery(
  webhookId: string,
  deliveryId: number,
): WebhookDeliveryDetail {
  const row = (DELIVERIES[webhookId] ?? []).find((d) => d.id === deliveryId) ?? {
    id: deliveryId,
    webhookId,
    event: "subscriber.created",
    statusCode: 200,
    attempt: 1,
    responseMs: 120,
    at: NOW(),
  };
  return {
    ...row,
    requestBody: JSON.stringify(
      {
        id: `evt_${row.id}`,
        type: row.event,
        created_at: row.at,
        data: { subscriber: { email: "ada@example.com", id: "sub_42" } },
      },
      null,
      2,
    ),
    payloadRetained: true,
  };
}
