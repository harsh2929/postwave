// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the webhook subscription + delivery endpoints.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";

export type WebhookEvent =
  | "subscriber.created"
  | "subscriber.updated"
  | "subscriber.confirmed"
  | "subscriber.unsubscribed"
  | "subscriber.bounced"
  | "subscriber.complained"
  | "subscriber.deleted"
  | "subscriber.merged"
  | "subscriber.status_changed"
  | "subscriber.consent_changed"
  | "campaign.sent"
  | "campaign.opens.digest"
  | "campaign.clicks.digest"
  | "automation.completed"
  | "migration.completed"
  | "migration.failed"
  | "form.submitted"
  | "form.confirmed"
  | "sequence.generated"
  // AUTOMATION#41 — newly subscribable. The voice stuck scanner has emitted
  // this for a long time; until the API catalog gained the event every alert
  // it produced died in the outbox DLQ, so there was nothing to offer here.
  | "sequence.participants.stuck"
  | "approval.requested";

export const ALL_WEBHOOK_EVENTS: WebhookEvent[] = [
  "subscriber.created",
  "subscriber.updated",
  "subscriber.confirmed",
  "subscriber.unsubscribed",
  "subscriber.bounced",
  "subscriber.complained",
  "subscriber.deleted",
  "subscriber.merged",
  "subscriber.status_changed",
  "subscriber.consent_changed",
  "campaign.sent",
  "campaign.opens.digest",
  "campaign.clicks.digest",
  "automation.completed",
  "migration.completed",
  "migration.failed",
  "form.submitted",
  "form.confirmed",
  "sequence.generated",
  "sequence.participants.stuck",
  "approval.requested",
];

export type WebhookStatus = "active" | "paused" | "failing";

export interface WebhookDelivery {
  id: number;
  webhookId: string;
  event: string;
  statusCode: number;
  attempt: number;
  responseMs: number;
  error?: string;
  at: string;
}

export interface Webhook {
  id: string;
  tenantId: string;
  url: string;
  events: WebhookEvent[];
  status: WebhookStatus;
  createdAt: string;
  updatedAt: string;
  lastDelivery?: WebhookDelivery;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEvent[];
}

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEvent[];
  status?: Exclude<WebhookStatus, "failing">;
}

export interface CreateWebhookResponse {
  webhook: Webhook;
  /** Plaintext signing secret. Returned exactly once. */
  secret: string;
}

export interface WebhookTestResult {
  ok: boolean;
  statusCode: number;
  responseMs: number;
}

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./webhooks-mocks");

interface WebhookRequestOptions {
  signal?: AbortSignal;
}

const adminWriteOptions = (signal?: AbortSignal) => ({
  requireOnline: true as const,
  maxAttempts: 1,
  signal,
});

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export function listWebhooks(
  options: WebhookRequestOptions = {},
): Promise<Webhook[]> {
  return withMockFallback(
    () => api.get<Webhook[]>("/api/v1/webhooks", { signal: options.signal }),
    async () => (await loadMocks()).mockListWebhooks(),
  );
}

export function createWebhook(
  input: CreateWebhookInput,
  options: WebhookRequestOptions = {},
): Promise<CreateWebhookResponse> {
  return withMockFallback(
    () =>
      api.post<CreateWebhookResponse>(
        "/api/v1/webhooks",
        input,
        adminWriteOptions(options.signal),
      ),
    async () => (await loadMocks()).mockCreateWebhook(input),
  );
}

/** Rotate a webhook's signing secret (SETA-035). Reveals the new secret once. */
export function rotateWebhookSecret(
  id: string,
  options: WebhookRequestOptions = {},
): Promise<CreateWebhookResponse> {
  return withMockFallback(
    () =>
      api.post<CreateWebhookResponse>(
        `/api/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`,
        undefined,
        adminWriteOptions(options.signal),
      ),
    async () => (await loadMocks()).mockCreateWebhook({ url: "", events: [] }),
  );
}

export function updateWebhook(
  id: string,
  patch: UpdateWebhookInput,
  options: WebhookRequestOptions = {},
): Promise<Webhook> {
  return withMockFallback(
    () =>
      api.patch<Webhook>(
        `/api/v1/webhooks/${encodeURIComponent(id)}`,
        patch,
        adminWriteOptions(options.signal),
      ),
    async () => (await loadMocks()).mockUpdateWebhook(id, patch),
  );
}

export function reenableWebhook(
  id: string,
  options: WebhookRequestOptions = {},
): Promise<{ ok: true }> {
  return withMockFallback(
    () =>
      api.post<{ ok: true }>(
        `/api/v1/webhooks/${encodeURIComponent(id)}/re-enable`,
        undefined,
        adminWriteOptions(options.signal),
      ),
    async () => {
      (await loadMocks()).mockReenableWebhook(id);
      return { ok: true as const };
    },
  );
}

export function deleteWebhook(
  id: string,
  options: WebhookRequestOptions = {},
): Promise<{ ok: true }> {
  return withMockFallback(
    () =>
      api.delete<{ ok: true }>(
        `/api/v1/webhooks/${encodeURIComponent(id)}`,
        adminWriteOptions(options.signal),
      ),
    async () => {
      (await loadMocks()).mockDeleteWebhook(id);
      return { ok: true as const };
    },
  );
}

export function testWebhook(
  id: string,
  options: WebhookRequestOptions = {},
): Promise<WebhookTestResult> {
  return withMockFallback(
    () =>
      api.post<WebhookTestResult>(
        `/api/v1/webhooks/${encodeURIComponent(id)}/test`,
        undefined,
        adminWriteOptions(options.signal),
      ),
    async () => (await loadMocks()).mockTestWebhook(id),
  );
}

export function listDeliveries(
  id: string,
  opts: { before?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<WebhookDelivery[]> {
  const query: Record<string, number> = {};
  if (opts.before) query.before = opts.before;
  if (opts.limit) query.limit = opts.limit;
  return withMockFallback(
    () =>
      api.get<WebhookDelivery[]>(
        `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`,
        {
          ...(Object.keys(query).length ? { query } : {}),
          signal: opts.signal,
        },
      ),
    async () => (await loadMocks()).mockListDeliveries(id),
  );
}

/**
 * One delivery plus its retained request payload (SETA-004). requestBody is the
 * wire-format JSON the dispatcher posted; payloadRetained is false for rows that
 * pre-date payload retention (migration 0050), in which case requestBody is "".
 */
export interface WebhookDeliveryDetail extends WebhookDelivery {
  requestBody: string;
  payloadRetained: boolean;
}

/**
 * Fetch a single delivery + its retained request payload for the inspector
 * drawer (SETA-004). Backend: GET /api/v1/webhooks/{id}/deliveries/{delivery_id}.
 */
export function getDelivery(
  webhookId: string,
  deliveryId: number,
  options: WebhookRequestOptions = {},
): Promise<WebhookDeliveryDetail> {
  return withMockFallback(
    () =>
      api.get<WebhookDeliveryDetail>(
        `/api/v1/webhooks/${encodeURIComponent(
          webhookId,
        )}/deliveries/${encodeURIComponent(String(deliveryId))}`,
        { signal: options.signal },
      ),
    async () => (await loadMocks()).mockGetDelivery(webhookId, deliveryId),
  );
}

export interface ReplayDeliveryResult {
  ok: true;
  replayed_delivery_id: number;
  webhook_id: string;
  event_type: string;
}

/**
 * Re-enqueue a past delivery through the outbox dispatcher (SETA-003).
 * Backend: POST /api/v1/webhooks/{id}/deliveries/{delivery_id}/replay.
 * Returns 202 on success; the caller must handle 503 (outbox not wired in this
 * deployment) and 422 (payload pre-dates retention) as ApiErrors.
 */
export function replayDelivery(
  webhookId: string,
  deliveryId: number,
  options: WebhookRequestOptions = {},
): Promise<ReplayDeliveryResult> {
  return withMockFallback(
    () =>
      api.post<ReplayDeliveryResult>(
        `/api/v1/webhooks/${encodeURIComponent(
          webhookId,
        )}/deliveries/${encodeURIComponent(String(deliveryId))}/replay`,
        undefined,
        adminWriteOptions(options.signal),
      ),
    async () => ({
      ok: true as const,
      replayed_delivery_id: deliveryId,
      webhook_id: webhookId,
      event_type: "ping",
    }),
  );
}
