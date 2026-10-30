// SPDX-License-Identifier: AGPL-3.0-only
//
// Inbound webhook endpoint and trigger clients.

import { api } from "./api";

export interface InboundWebhook {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  enabled: boolean;
  transform_jq?: string;
  createdAt: string;
}

export interface InboundWebhookSecretResult {
  endpoint: InboundWebhook;
  secret: string;
}

export function listInboundWebhooks(
  query?: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ items: InboundWebhook[] }> {
  return api.get<{ items: InboundWebhook[] }>("/api/v1/inbound-webhooks", {
    query: query ? { query } : undefined,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export function createInboundWebhook(input: {
  name: string;
  transform_jq?: string;
}): Promise<InboundWebhookSecretResult> {
  return api.post<InboundWebhookSecretResult>(
    "/api/v1/inbound-webhooks",
    input,
  );
}

export function getInboundWebhook(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<InboundWebhook> {
  const path = `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`;
  return opts.signal
    ? api.get<InboundWebhook>(path, { signal: opts.signal })
    : api.get<InboundWebhook>(path);
}

/**
 * PATCH the endpoint. Send the complete intended state for every field the
 * operator is editing (name / enabled / transform_jq) — the backend treats a
 * present `transform_jq` as a full replace (empty string clears it).
 */
export interface InboundWebhookPatch {
  name?: string;
  enabled?: boolean;
  transform_jq?: string;
}

export function updateInboundWebhook(
  id: string,
  patch: InboundWebhookPatch,
): Promise<InboundWebhook> {
  return api.patch<InboundWebhook>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
    patch,
  );
}

export function rotateInboundWebhookSecret(
  id: string,
): Promise<InboundWebhookSecretResult> {
  return api.post<InboundWebhookSecretResult>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/rotate`,
    {},
  );
}

export function deleteInboundWebhook(id: string): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
  );
}

/** A stored inbound event (received payload) for the per-endpoint events view. */
export interface InboundEvent {
  id: number;
  endpoint_id: string;
  headers: Record<string, string>;
  body: string;
  signature_valid: boolean;
  received_at: string;
}

export interface InboundEventPage {
  items: InboundEvent[];
  next_cursor?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeInboundEventPage(raw: unknown): InboundEventPage {
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new Error("Inbound events response was malformed.");
  }
  const items = raw.items.map((value, index): InboundEvent => {
    if (!isRecord(value)) {
      throw new Error(`Inbound event ${index + 1} was malformed.`);
    }
    const headers = value.headers;
    const validHeaders =
      isRecord(headers) &&
      Object.values(headers).every((header) => typeof header === "string");
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      typeof value.endpoint_id !== "string" ||
      !value.endpoint_id.trim() ||
      !validHeaders ||
      typeof value.body !== "string" ||
      typeof value.signature_valid !== "boolean" ||
      typeof value.received_at !== "string" ||
      !value.received_at.trim()
    ) {
      throw new Error(`Inbound event ${index + 1} was malformed.`);
    }
    return {
      id: value.id,
      endpoint_id: value.endpoint_id,
      headers: headers as Record<string, string>,
      body: value.body,
      signature_valid: value.signature_valid,
      received_at: value.received_at,
    };
  });
  return {
    items,
    ...(typeof raw.next_cursor === "string" || raw.next_cursor === null
      ? { next_cursor: raw.next_cursor }
      : {}),
  };
}

export function listInboundWebhookEvents(
  id: string,
  limit = 50,
  opts: { signal?: AbortSignal } = {},
): Promise<InboundEventPage> {
  return api
    .get<unknown>(`/api/v1/inbound-webhooks/${encodeURIComponent(id)}/events`, {
      query: { limit: String(limit) },
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    .then(normalizeInboundEventPage);
}

/** One trigger match returned by a replay (mirrors the Go `Match`). */
export interface InboundTriggerMatch {
  trigger_id: string;
  name: string;
  subscriber_email: string;
  action_type: string;
  action_target_id: string;
  queued?: boolean;
  executed: boolean;
  error?: string;
}

export interface InboundReplayResult {
  ok: boolean;
  queued: boolean;
  replay_id: string;
  matches: InboundTriggerMatch[];
}

export function normalizeInboundReplayResult(
  raw: unknown,
): InboundReplayResult {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    raw.queued !== true ||
    typeof raw.replay_id !== "string" ||
    !raw.replay_id.trim() ||
    !Array.isArray(raw.matches)
  ) {
    throw new Error("Inbound replay response was malformed.");
  }
  const matches = raw.matches.map((value, index): InboundTriggerMatch => {
    if (
      !isRecord(value) ||
      typeof value.trigger_id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.subscriber_email !== "string" ||
      typeof value.action_type !== "string" ||
      typeof value.action_target_id !== "string" ||
      typeof value.executed !== "boolean" ||
      (value.queued !== undefined && typeof value.queued !== "boolean") ||
      (value.error !== undefined && typeof value.error !== "string")
    ) {
      throw new Error(`Inbound replay match ${index + 1} was malformed.`);
    }
    return {
      trigger_id: value.trigger_id,
      name: value.name,
      subscriber_email: value.subscriber_email,
      action_type: value.action_type,
      action_target_id: value.action_target_id,
      ...(typeof value.queued === "boolean" ? { queued: value.queued } : {}),
      executed: value.executed,
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  });
  return {
    ok: true,
    queued: true,
    replay_id: raw.replay_id,
    matches,
  };
}

/**
 * Submits a stored event to the durable replay planner. Matching actions can
 * be queued (and a returned match may already be executed), so the caller must
 * confirm with the operator first and keep one stable key across retries.
 */
export function replayInboundEvent(
  id: string,
  eventId: number,
  idempotencyKey?: string,
): Promise<InboundReplayResult> {
  return api
    .post<unknown>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/events/${encodeURIComponent(String(eventId))}/replay`,
      {},
      {
        // Replays can enqueue subscriber-affecting actions. Never defer that
        // confirmation into the generic offline outbox.
        requireOnline: true,
        ...(idempotencyKey
          ? { headers: { "Idempotency-Key": idempotencyKey } }
          : {}),
      },
    )
    .then(normalizeInboundReplayResult);
}

/**
 * Runs a jq expression against a sample payload server-side and returns the
 * transformed body (or an operator-safe error). Lets users author jq without
 * going live blind.
 */
export function previewInboundTransform(input: {
  transform_jq: string;
  body?: unknown;
}): Promise<{ body: unknown }> {
  return api.post<{ body: unknown }>(
    "/api/v1/inbound-webhooks/transform/preview",
    {
      transform_jq: input.transform_jq,
      body: input.body ?? {},
    },
  );
}

export type TriggerOperator = "equals" | "contains" | "exists" | "regex";
export type TriggerAction =
  | "add_to_sequence"
  | "add_tag"
  | "remove_tag"
  | "start_automation";

export interface InboundTrigger {
  id: string;
  tenant_id: string;
  webhook_id: string;
  name: string;
  active: boolean;
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value?: string | null;
  email_jsonpath: string;
  action_type: TriggerAction;
  action_target_id: string;
  fired_count: number;
  last_fired_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboundTriggerInput {
  name: string;
  active?: boolean;
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value?: string | null;
  email_jsonpath: string;
  action_type: TriggerAction;
  action_target_id: string;
}

export type InboundTriggerPatch = Partial<InboundTriggerInput>;

export function listInboundTriggers(
  webhookID: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ items: InboundTrigger[] }> {
  const path = `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers`;
  return opts.signal
    ? api.get<{ items: InboundTrigger[] }>(path, { signal: opts.signal })
    : api.get<{ items: InboundTrigger[] }>(path);
}

export function createInboundTrigger(
  webhookID: string,
  input: InboundTriggerInput,
): Promise<InboundTrigger> {
  return api.post<InboundTrigger>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers`,
    input,
  );
}

export function updateInboundTrigger(
  webhookID: string,
  triggerID: string,
  patch: InboundTriggerPatch,
): Promise<InboundTrigger> {
  return api.patch<InboundTrigger>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers/${encodeURIComponent(triggerID)}`,
    patch,
  );
}

export function deleteInboundTrigger(
  webhookID: string,
  triggerID: string,
): Promise<{ ok: boolean }> {
  return api.delete<{ ok: boolean }>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(webhookID)}/triggers/${encodeURIComponent(triggerID)}`,
  );
}
