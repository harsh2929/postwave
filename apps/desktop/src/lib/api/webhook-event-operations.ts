import type { ApiResult } from "./result";

export interface WebhookEventRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
  /**
   * Caller-stable logical mutation identity. Shown-once create/rotate flows
   * retain this key across an ambiguous manual retry so a committed response
   * cannot be followed by a duplicate resource or second rotation.
   */
  idempotencyKey?: string;
}

export type WebhookEventRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: WebhookEventRequestOptions,
) => Promise<ApiResult<T>>;

export interface WebhookEventOperationsDependencies {
  request: WebhookEventRequester;
  getApiUrl: () => string;
  buildStreamUrl: (path: string) => Promise<string>;
}

/**
 * One inbound webhook endpoint. Mirrors the Go `Endpoint` struct exactly
 * (camelCase JSON tags). The plaintext signing `secret` is intentionally
 * omitted — it's only ever returned by `Create` / `Rotate`.
 */
export interface InboundWebhookEndpoint {
  id: string;
  tenantId: string;
  /** Random hex slug used in the public URL: /api/public/inbound/{slug}. */
  slug: string;
  /** Human-readable operator label. */
  name: string;
  enabled: boolean;
  /** Optional bounded jq transform applied after signature verification. */
  transform_jq?: string;
  createdAt: string;
}

/**
 * Decoded GET /api/v1/inbound-webhooks response. A missing wire cursor is
 * normalised to the empty string; only the published `next_cursor` spelling is
 * accepted at the boundary.
 */
export interface InboundWebhookListResponse {
  items: InboundWebhookEndpoint[];
  next_cursor: string;
}

export interface InboundWebhookListOptions {
  cursor?: string;
  limit?: number;
  query?: string;
}

/**
 * POST /api/v1/inbound-webhooks (and /rotate) response. The plaintext
 * `secret` is shown once. The server keeps an encrypted write-only copy for
 * verification; operator read APIs never return it again.
 */
export interface InboundWebhookCreateResponse {
  endpoint: InboundWebhookEndpoint;
  secret: string;
}

/**
 * One inbound event row. The Go ingest writes to `inbound_events`
 * (apps/api/internal/inbound_webhooks/repo.go::RecordEvent). The fields
 * here are the projection we expect when the read handler lands.
 */
export interface InboundWebhookEvent {
  id: number;
  endpoint_id: string;
  /** Captured request headers at ingest time (HTTP/1.1 case-insensitive). */
  headers: Record<string, string>;
  /**
   * Stored post-transform payload, decoded as UTF-8 best-effort by the server.
   * This is the authenticated original only when the endpoint has no transform;
   * the original bytes are not retained after a transform is applied.
   */
  body: string;
  /** Whether the X-Postwave-Signature HMAC verified. */
  signature_valid: boolean;
  received_at: string;
}

export type InboundWebhookSignatureState = "verified" | "invalid";

export function getInboundWebhookSignatureState(
  event: InboundWebhookEvent,
): InboundWebhookSignatureState {
  return event.signature_valid ? "verified" : "invalid";
}

export interface InboundWebhookEventsResponse {
  items: InboundWebhookEvent[];
  next_cursor: string;
}

export interface InboundWebhookReplayMatch {
  trigger_id: string;
  name: string;
  subscriber_email: string;
  action_type: string;
  action_target_id: string;
  /** True when a worker-executable action intent was persisted. */
  queued: boolean;
  /** Worker evidence only; normally false in the immediate 202 response. */
  executed: boolean;
  /** Bounded planning/worker error detail when the action was not queued. */
  error?: string;
}

export interface InboundWebhookReplayResponse {
  ok: true;
  /** Confirms the replay receipt was accepted, not that actions executed. */
  queued: true;
  replay_id: string;
  matches: InboundWebhookReplayMatch[];
}

export interface InboundWebhookEventListOptions {
  cursor?: string;
  limit?: number;
}

class InboundWebhookContractError extends Error {}

function inboundRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[] | null,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboundWebhookContractError(`${path} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unexpected = Object.keys(record).find((key) => !allowed.has(key));
    if (unexpected) {
      throw new InboundWebhookContractError(
        `${path}.${unexpected} is not part of the published contract`,
      );
    }
  }
  return record;
}

function inboundString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  options: { optional?: boolean; nonEmpty?: boolean } = {},
): string | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (
    typeof value !== "string" ||
    (options.nonEmpty !== false && value.trim() === "")
  ) {
    throw new InboundWebhookContractError(
      `${path}.${key} must be ${options.nonEmpty === false ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function inboundUUID(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = inboundString(record, key, path)!;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new InboundWebhookContractError(
      `${path}.${key} must be a canonical UUID`,
    );
  }
  return value;
}

function inboundTimestamp(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = inboundString(record, key, path)!;
  if (!Number.isFinite(Date.parse(value))) {
    throw new InboundWebhookContractError(
      `${path}.${key} must be an RFC 3339 timestamp`,
    );
  }
  return value;
}

export function decodeInboundWebhookEndpoint(
  value: unknown,
  path = "endpoint",
): InboundWebhookEndpoint {
  const record = inboundRecord(value, path, [
    "id",
    "tenantId",
    "slug",
    "name",
    "enabled",
    "transform_jq",
    "createdAt",
  ]);
  if (typeof record.enabled !== "boolean") {
    throw new InboundWebhookContractError(`${path}.enabled must be a boolean`);
  }
  return {
    id: inboundUUID(record, "id", path),
    tenantId: inboundUUID(record, "tenantId", path),
    slug: inboundString(record, "slug", path)!,
    name: inboundString(record, "name", path, { nonEmpty: false })!,
    enabled: record.enabled,
    transform_jq: inboundString(record, "transform_jq", path, {
      optional: true,
      nonEmpty: false,
    }),
    createdAt: inboundTimestamp(record, "createdAt", path),
  };
}

function inboundCursor(record: Record<string, unknown>, path: string): string {
  if (record.next_cursor === undefined) return "";
  if (typeof record.next_cursor !== "string") {
    throw new InboundWebhookContractError(
      `${path}.next_cursor must be a string when present`,
    );
  }
  return record.next_cursor;
}

export function decodeInboundWebhookListResponse(
  value: unknown,
): InboundWebhookListResponse {
  const record = inboundRecord(value, "response", ["items", "next_cursor"]);
  if (!Array.isArray(record.items)) {
    throw new InboundWebhookContractError("response.items must be an array");
  }
  const items = record.items.map((item, index) =>
    decodeInboundWebhookEndpoint(item, `response.items[${index}]`),
  );
  const nextCursor = inboundCursor(record, "response");
  if (items.length === 0 && nextCursor) {
    throw new InboundWebhookContractError(
      "response.next_cursor cannot continue an empty endpoint page",
    );
  }
  return { items, next_cursor: nextCursor };
}

export function decodeInboundWebhookCreateResponse(
  value: unknown,
  expectedEndpointID?: string,
): InboundWebhookCreateResponse {
  const record = inboundRecord(value, "response", ["endpoint", "secret"]);
  const endpoint = decodeInboundWebhookEndpoint(
    record.endpoint,
    "response.endpoint",
  );
  if (expectedEndpointID && endpoint.id !== expectedEndpointID) {
    throw new InboundWebhookContractError(
      "response.endpoint.id does not match the requested endpoint",
    );
  }
  return {
    endpoint,
    secret: inboundString(record, "secret", "response")!,
  };
}

export function decodeInboundWebhookEvent(
  value: unknown,
  path = "event",
): InboundWebhookEvent {
  const record = inboundRecord(value, path, [
    "id",
    "endpoint_id",
    "headers",
    "body",
    "signature_valid",
    "received_at",
  ]);
  if (
    typeof record.id !== "number" ||
    !Number.isSafeInteger(record.id) ||
    record.id < 1
  ) {
    throw new InboundWebhookContractError(
      `${path}.id must be a positive safe integer`,
    );
  }
  if (typeof record.signature_valid !== "boolean") {
    throw new InboundWebhookContractError(
      `${path}.signature_valid must be a boolean`,
    );
  }
  const rawHeaders = inboundRecord(record.headers, `${path}.headers`, null);
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(rawHeaders)) {
    if (typeof headerValue !== "string") {
      throw new InboundWebhookContractError(
        `${path}.headers.${key} must be a string`,
      );
    }
    headers[key] = headerValue;
  }
  return {
    id: record.id,
    endpoint_id: inboundUUID(record, "endpoint_id", path),
    headers,
    body: inboundString(record, "body", path, { nonEmpty: false })!,
    signature_valid: record.signature_valid,
    received_at: inboundTimestamp(record, "received_at", path),
  };
}

export function decodeInboundWebhookEventsResponse(
  value: unknown,
  expectedEndpointID?: string,
): InboundWebhookEventsResponse {
  const record = inboundRecord(value, "response", ["items", "next_cursor"]);
  if (!Array.isArray(record.items)) {
    throw new InboundWebhookContractError("response.items must be an array");
  }
  const items = record.items.map((item, index) =>
    decodeInboundWebhookEvent(item, `response.items[${index}]`),
  );
  if (
    expectedEndpointID &&
    items.some((event) => event.endpoint_id !== expectedEndpointID)
  ) {
    throw new InboundWebhookContractError(
      "response contains an event from a different endpoint",
    );
  }
  const nextCursor = inboundCursor(record, "response");
  if (items.length === 0 && nextCursor) {
    throw new InboundWebhookContractError(
      "response.next_cursor cannot continue an empty event page",
    );
  }
  return { items, next_cursor: nextCursor };
}

function decodeInboundWebhookReplayMatch(
  value: unknown,
  path: string,
): InboundWebhookReplayMatch {
  const record = inboundRecord(value, path, [
    "trigger_id",
    "name",
    "subscriber_email",
    "action_type",
    "action_target_id",
    "queued",
    "executed",
    "error",
  ]);
  if (record.queued !== undefined && typeof record.queued !== "boolean") {
    throw new InboundWebhookContractError(
      `${path}.queued must be a boolean when present`,
    );
  }
  if (typeof record.executed !== "boolean") {
    throw new InboundWebhookContractError(`${path}.executed must be a boolean`);
  }
  return {
    trigger_id: inboundUUID(record, "trigger_id", path),
    name: inboundString(record, "name", path, { nonEmpty: false })!,
    subscriber_email: inboundString(record, "subscriber_email", path, {
      nonEmpty: false,
    })!,
    action_type: inboundString(record, "action_type", path, {
      nonEmpty: false,
    })!,
    action_target_id: inboundString(record, "action_target_id", path, {
      nonEmpty: false,
    })!,
    queued: record.queued === true,
    executed: record.executed,
    error: inboundString(record, "error", path, {
      optional: true,
      nonEmpty: false,
    }),
  };
}

export function decodeInboundWebhookReplayResponse(
  value: unknown,
): InboundWebhookReplayResponse {
  const record = inboundRecord(value, "response", [
    "ok",
    "queued",
    "replay_id",
    "matches",
  ]);
  if (record.ok !== true) {
    throw new InboundWebhookContractError("response.ok must be true");
  }
  if (record.queued !== true) {
    throw new InboundWebhookContractError("response.queued must be true");
  }
  if (!Array.isArray(record.matches)) {
    throw new InboundWebhookContractError("response.matches must be an array");
  }
  return {
    ok: true,
    queued: true,
    replay_id: inboundUUID(record, "replay_id", "response"),
    matches: record.matches.map((match, index) =>
      decodeInboundWebhookReplayMatch(match, `response.matches[${index}]`),
    ),
  };
}

function decodeInboundResult<T>(
  result: ApiResult<unknown>,
  decode: (value: unknown) => T,
): ApiResult<T> {
  if (result.error) return result;
  try {
    return {
      data: decode(result.data),
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof InboundWebhookContractError
        ? error.message
        : "response did not match the canonical inbound webhook contract";
    return {
      error: {
        kind: "parse",
        code: "inbound_webhook_contract",
        message: `Moosewave returned malformed inbound webhook data (${detail}). No malformed rows were discarded or treated as empty.`,
      },
      retryability: "not-retryable",
    };
  }
}

function decodeInboundOk(value: unknown): { ok: true } {
  const record = inboundRecord(value, "response", ["ok"]);
  if (record.ok !== true) {
    throw new InboundWebhookContractError("response.ok must be true");
  }
  return { ok: true };
}

export function decodeInboundWebhookEndpointResult(
  result: ApiResult<unknown>,
  expectedEndpointID?: string,
): ApiResult<InboundWebhookEndpoint> {
  return decodeInboundResult(result, (value) => {
    const endpoint = decodeInboundWebhookEndpoint(value, "response");
    if (expectedEndpointID && endpoint.id !== expectedEndpointID) {
      throw new InboundWebhookContractError(
        "response.id does not match the requested endpoint",
      );
    }
    return endpoint;
  });
}

/* ---------- Outbound webhook subscription types --------------------- */

/**
 * One outbound webhook subscription. Mirrors the Go `Webhook` struct in
 * apps/api/internal/webhooks/webhooks.go (camelCase JSON tags). The
 * plaintext signing secret is only ever returned by Create — never on
 * subsequent reads.
 */
export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  /** active | paused | failing — see Status const block in webhooks.go. */
  status: string;
  /** Refined Webhooks final batch: production | staging | development.
   *  Today purely a label; dispatcher routing by env is a future PR. */
  environment?: WebhookEnvironment;
  createdAt: string;
  updatedAt: string;
  /** Server-attached most-recent delivery row, when available. */
  lastDelivery?: WebhookDelivery | null;
}

export type WebhookEnvironment = "production" | "staging" | "development";

/** POST /api/v1/webhooks response — plaintext signing secret returned once. */
export interface WebhookCreateResponse {
  webhook: WebhookSubscription;
  secret: string;
}

/** Refined Webhooks final batch: saved test payloads. */
export interface WebhookTestPayload {
  id: string;
  webhook_id: string;
  direction: "inbound" | "outbound";
  name: string;
  body: unknown;
  created_at: string;
}

/** GET /api/v1/webhooks response shape. */
export interface WebhookListResponse {
  items?: WebhookSubscription[];
  data?: WebhookSubscription[];
  results?: WebhookSubscription[];
}

/* ----- Refined Webhooks PR 1 ---------------------------------- */

export interface WebhookHealthError {
  status_code: number;
  message: string;
  count: number;
}

export interface WebhookHealth {
  deliveries_total: number;
  deliveries_succeeded: number;
  deliveries_failed: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
  status_breakdown: Record<string, number>;
  top_errors: WebhookHealthError[];
  consecutive_failures: number;
  auto_disabled: boolean;
  last_delivery_at?: string | null;
}

/** Refined Webhooks PR 3 — per-user alert prefs. */
export interface WebhookAlertPrefs {
  user_id?: string;
  tenant_id?: string;
  notify_auto_disabled: boolean;
  notify_failure_rate: boolean;
  failure_rate_pct: number;
  notify_latency: boolean;
  latency_ms: number;
  last_alerted_at?: string | null;
  updated_at?: string;
}

export type WebhookAlertPrefsInput = Pick<
  WebhookAlertPrefs,
  | "notify_auto_disabled"
  | "notify_failure_rate"
  | "failure_rate_pct"
  | "notify_latency"
  | "latency_ms"
>;

/**
 * One delivery attempt row. Mirrors the Go `Delivery` struct exactly.
 * `error` is empty string on success; we treat empty + 2xx as success.
 */
export interface WebhookDelivery {
  id: number;
  webhookId: string;
  event: string;
  /** HTTP response code; 0 if the request never made it to the wire. */
  statusCode: number;
  attempt: number;
  responseMs: number;
  /** Network / transport error, only populated when statusCode is 0 or non-2xx. */
  error?: string;
  at: string;
}

export interface WebhookDeliveriesResponse {
  items?: WebhookDelivery[];
  data?: WebhookDelivery[];
  results?: WebhookDelivery[];
}

/**
 * POST .../{delivery_id}/replay response. The handler returns 202 with a
 * minimal envelope; the new delivery_id isn't known until the dispatcher
 * picks it up async, so the response only confirms the enqueue.
 */
export interface WebhookReplayResponse {
  ok?: boolean;
  replayed_delivery_id?: number;
  webhook_id?: string;
  event_type?: string;
}

/**
 * POST .../test response. Indicates whether the synthetic ping reached
 * the destination and what status code came back.
 */
export interface WebhookTestResponse {
  ok?: boolean;
  statusCode?: number;
  responseMs?: number;
}

/**
 * One product event row. Mirrors the Go `track.Event` struct
 * (apps/api/internal/track/repo.go::Event). The desktop also reads a
 * couple of snake_case fallbacks defensively because some adjacent
 * pipelines (e.g. fanout to automation) emit either casing.
 */
export interface ProductEvent {
  id: number | string;
  tenantId?: string;
  subscriberId?: string;
  /** Snake_case fallback the UI also reads. */
  subscriber_id?: string;
  /** Email is NOT in the Go projection but the spec hints at it; tolerate. */
  subscriber_email?: string;
  eventName: string;
  /** Snake_case fallback. */
  event_name?: string;
  properties?: Record<string, unknown> | null;
  occurredAt?: string;
  receivedAt?: string;
  /** Snake_case fallbacks. */
  occurred_at?: string;
  received_at?: string;
}

export interface ProductEventsResponse {
  items?: ProductEvent[];
  data?: ProductEvent[];
  results?: ProductEvent[];
  nextCursor?: string;
}

/** Refined Product Events PR 1: per-day bucket reused by stats +
 *  catalog sparkline. */
export interface ProductEventDailyBucket {
  date: string;
  count: number;
}

/** Refined Product Events PR 1: one row in the event catalog list. */
export interface ProductEventCatalogRow {
  eventName: string;
  count: number;
  uniqueSubscribers: number;
  firstSeen: string;
  lastSeen: string;
  daily: ProductEventDailyBucket[];
}

export interface ProductEventCatalogResponse {
  items: ProductEventCatalogRow[];
  totalDistinctEventNames: number;
  periodDays: number;
  dailySeriesPeriodDays: number;
  eventBoundsScope: "period";
  timeZone: "UTC";
  asOf: string;
}

/** Refined Product Events PR 1: insights row payload. */
export interface ProductEventStatsResponse {
  periodDays: number;
  totalEvents: number;
  uniqueSubscribers: number;
  uniqueEventNames: number;
  daily: ProductEventDailyBucket[];
  timeZone: "UTC";
  asOf: string;
}

/** GET /api/v1/inbound-webhooks — list configured endpoints. */
export function createListInboundWebhooks({
  request,
}: WebhookEventOperationsDependencies) {
  return async function listInboundWebhooks(
    opts: InboundWebhookListOptions = {},
  ): Promise<ApiResult<InboundWebhookListResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) {
      params.set(
        "limit",
        String(Math.max(1, Math.min(200, Math.floor(opts.limit)))),
      );
    }
    if (opts.query?.trim()) params.set("query", opts.query.trim());
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return decodeInboundResult(
      await request<unknown>(`/api/v1/inbound-webhooks${suffix}`),
      decodeInboundWebhookListResponse,
    );
  };
}

/**
 * POST /api/v1/inbound-webhooks — create a new endpoint. Server replies
 * with `{endpoint, secret}`; the plaintext `secret` is shown ONCE then
 * hashed at rest. The UI must surface it via a "shown once" view.
 */
export function createCreateInboundWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return async function createInboundWebhook(
    input: { label: string },
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<InboundWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    // The strict Go decoder accepts the canonical `name` field only.
    return decodeInboundResult(
      await request<unknown>(
        "/api/v1/inbound-webhooks",
        {
          method: "POST",
          body: JSON.stringify({ name: input.label }),
          ...(idempotencyKey
            ? { headers: { "Idempotency-Key": idempotencyKey } }
            : {}),
        },
        liveWebhookMutationOptions(requestOpts),
      ),
      decodeInboundWebhookCreateResponse,
    );
  };
}

/**
 * GET /api/v1/inbound-webhooks/{id} — endpoint metadata (no secret).
 */
export function createGetInboundWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return async function getInboundWebhook(
    id: string,
  ): Promise<ApiResult<InboundWebhookEndpoint>> {
    return decodeInboundWebhookEndpointResult(
      await request<unknown>(
        `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
      ),
      id,
    );
  };
}

/**
 * GET /api/v1/inbound-webhooks/{id}/events?limit= — recent inbound events.
 */
export function createListInboundWebhookEvents({
  request,
}: WebhookEventOperationsDependencies) {
  return async function listInboundWebhookEvents(
    id: string,
    opts: InboundWebhookEventListOptions = {},
  ): Promise<ApiResult<InboundWebhookEventsResponse>> {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) {
      params.set(
        "limit",
        String(Math.max(1, Math.min(200, Math.floor(opts.limit)))),
      );
    }
    const qs = params.toString();
    return decodeInboundResult(
      await request<unknown>(
        `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`,
      ),
      (value) => decodeInboundWebhookEventsResponse(value, id),
    );
  };
}

/**
 * POST /api/v1/inbound-webhooks/{id}/rotate — rotate the signing secret.
 * Returns `{endpoint, secret}` with the new plaintext secret shown once.
 */
export function createRotateInboundWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return async function rotateInboundWebhook(
    id: string,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<InboundWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    return decodeInboundResult(
      await request<unknown>(
        `/api/v1/inbound-webhooks/${encodeURIComponent(id)}/rotate`,
        {
          method: "POST",
          body: JSON.stringify({}),
          ...(idempotencyKey
            ? { headers: { "Idempotency-Key": idempotencyKey } }
            : {}),
        },
        liveWebhookMutationOptions(requestOpts),
      ),
      (value) => decodeInboundWebhookCreateResponse(value, id),
    );
  };
}

/** DELETE /api/v1/inbound-webhooks/{id} — delete an endpoint. */
export function createDeleteInboundWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return async function deleteInboundWebhook(
    id: string,
  ): Promise<ApiResult<{ ok: true }>> {
    return decodeInboundResult(
      await request<unknown>(
        `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
        },
        liveWebhookMutationOptions({}),
      ),
      decodeInboundOk,
    );
  };
}

/**
 * GET /api/v1/track/events — recent product events.
 *
 * Without subscriber_id this returns the tenant-wide recent feed
 * ordered by occurred_at DESC. Supplying subscriber_id narrows the
 * feed to a single subscriber. `before` is an RFC3339 cursor for the
 * tenant-wide feed.
 */
export function createListProductEvents({
  request,
}: WebhookEventOperationsDependencies) {
  return function listProductEvents(
    opts: {
      subscriberId?: string;
      /** Refined Product Events PR 1: server-side filter by event_name
       *  so the operator can slice in one round-trip. */
      eventName?: string;
      limit?: number;
      before?: string;
    } = {},
  ): Promise<ApiResult<ProductEventsResponse>> {
    const params = new URLSearchParams();
    if (opts.subscriberId) params.set("subscriber_id", opts.subscriberId);
    if (opts.eventName) params.set("event_name", opts.eventName);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.before) params.set("before", opts.before);
    const qs = params.toString();
    return request<ProductEventsResponse>(
      `/api/v1/track/events${qs ? `?${qs}` : ""}`,
    );
  };
}

/** GET /api/v1/track/catalog — distinct event names + per-event
 *  counts + first/last-seen + 7-day daily series for sparkline. */
export function createGetProductEventCatalog({
  request,
}: WebhookEventOperationsDependencies) {
  return function getProductEventCatalog(
    opts: { days?: number } = {},
  ): Promise<ApiResult<ProductEventCatalogResponse>> {
    const params = new URLSearchParams();
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request(`/api/v1/track/catalog${qs ? `?${qs}` : ""}`);
  };
}

/** GET /api/v1/track/stats — totals + unique subs/event-names +
 *  daily series. Optional event_name narrows to per-event view. */
export function createGetProductEventStats({
  request,
}: WebhookEventOperationsDependencies) {
  return function getProductEventStats(
    opts: { eventName?: string; days?: number } = {},
  ): Promise<ApiResult<ProductEventStatsResponse>> {
    const params = new URLSearchParams();
    if (opts.eventName) params.set("event_name", opts.eventName);
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request(`/api/v1/track/stats${qs ? `?${qs}` : ""}`);
  };
}

/**
 * SSE live-tail URL (bare, no stream_token). Caller opens with
 * `new EventSource(...)`. Kept for callers that still run inside the
 * browser session and have cookies. For Electron / cookieless
 * contexts, use `productEventStreamUrlAuthed` — that variant
 * attaches a short-lived `stream_token` query param so the server
 * accepts the connection without a session cookie.
 */
export function createProductEventStreamUrl({
  getApiUrl,
}: WebhookEventOperationsDependencies) {
  return function productEventStreamUrl(eventName?: string): string {
    const qs = eventName ? `?event_name=${encodeURIComponent(eventName)}` : "";
    return `${getApiUrl()}/api/v1/track/stream${qs}`;
  };
}

/**
 * Auth-token-safe variant of productEventStreamUrl. Routes through
 * `buildStreamUrl` so the EventSource opens in Electron and other
 * cookieless contexts.
 */
export function createProductEventStreamUrlAuthed({
  buildStreamUrl,
}: WebhookEventOperationsDependencies) {
  return async function productEventStreamUrlAuthed(
    eventName?: string,
  ): Promise<string> {
    const qs = eventName ? `?event_name=${encodeURIComponent(eventName)}` : "";
    return buildStreamUrl(`/api/v1/track/stream${qs}`);
  };
}

/**
 * CSV export URL (bare). Caller opens in a new tab. For Electron
 * use `productEventsCsvUrlAuthed` — without a stream_token the
 * `window.open` 401s.
 */
export function createProductEventsCsvUrl({
  getApiUrl,
}: WebhookEventOperationsDependencies) {
  return function productEventsCsvUrl(
    opts: {
      eventName?: string;
      subscriberId?: string;
      limit?: number;
      occurredAfter?: string;
    } = {},
  ): string {
    const params = new URLSearchParams();
    if (opts.eventName) params.set("event_name", opts.eventName);
    if (opts.subscriberId) params.set("subscriber_id", opts.subscriberId);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.occurredAfter) params.set("occurred_after", opts.occurredAfter);
    const qs = params.toString();
    return `${getApiUrl()}/api/v1/track/events.csv${qs ? `?${qs}` : ""}`;
  };
}

/** Auth-token-safe variant of productEventsCsvUrl. */
export function createProductEventsCsvUrlAuthed({
  buildStreamUrl,
}: WebhookEventOperationsDependencies) {
  return async function productEventsCsvUrlAuthed(
    opts: {
      eventName?: string;
      subscriberId?: string;
      limit?: number;
      occurredAfter?: string;
    } = {},
  ): Promise<string> {
    const params = new URLSearchParams();
    if (opts.eventName) params.set("event_name", opts.eventName);
    if (opts.subscriberId) params.set("subscriber_id", opts.subscriberId);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.occurredAfter) params.set("occurred_after", opts.occurredAfter);
    const qs = params.toString();
    return buildStreamUrl(`/api/v1/track/events.csv${qs ? `?${qs}` : ""}`);
  };
}

/** Refined PR 1 helper: ingest a live workspace product event from the
 * in-app composer. This is not a sandbox: the authenticated endpoint persists
 * the event and can fan out to automations, flows, and revenue attribution. */
export function createSendProductEvent({
  request,
}: WebhookEventOperationsDependencies) {
  return function sendProductEvent(
    input: {
      subscriber_id?: string;
      email?: string;
      event_name: string;
      properties?: Record<string, unknown>;
      occurred_at?: string;
    },
    options: { idempotencyKey?: string } = {},
  ): Promise<ApiResult<{ id: number; subscriber_id: string }>> {
    return request(
      `/api/v1/track`,
      {
        method: "POST",
        body: JSON.stringify(input),
        ...(options.idempotencyKey
          ? {
              headers: {
                "Idempotency-Key": options.idempotencyKey,
              },
            }
          : {}),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  };
}

/** GET /api/v1/webhooks — list outbound webhook subscriptions. */
export function createListWebhooks({
  request,
}: WebhookEventOperationsDependencies) {
  return function listWebhooks(): Promise<ApiResult<WebhookListResponse>> {
    return request<WebhookListResponse>("/api/v1/webhooks");
  };
}

/**
 * POST /api/v1/webhooks — create a subscription in the SAME `webhooks`
 * subsystem the page lists/tests/deletes from (D12#2). The create + edit
 * dialogs previously used the separate /outbound-webhooks subsystem, so a
 * created hook never appeared in the list and edits 404'd. Returns the
 * plaintext signing secret exactly once (CreateResponse{webhook, secret}).
 */
export function createCreateWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function createWebhook(input: {
    url: string;
    events: string[];
  }): Promise<ApiResult<WebhookCreateResponse>> {
    return request<WebhookCreateResponse>("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

/**
 * PATCH /api/v1/webhooks/{id} — edit a subscription's URL/events in the
 * `webhooks` subsystem (D12#2). UpdateInput accepts {url?, events?,
 * status?}; only supplied fields are applied.
 */
export function createUpdateWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function updateWebhook(
    id: string,
    patch: { url?: string; events?: string[]; status?: string },
  ): Promise<ApiResult<WebhookSubscription>> {
    return request<WebhookSubscription>(
      `/api/v1/webhooks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

/**
 * Refined Webhooks PR 1: 24h health aggregate for one webhook.
 * Backed by webhook_deliveries — latency from response_ms, status
 * breakdown by bucket (2xx/4xx/5xx/error), top errors by
 * (status_code, error) pair.
 */
export function createGetWebhookHealth({
  request,
}: WebhookEventOperationsDependencies) {
  return function getWebhookHealth(
    id: string,
  ): Promise<ApiResult<WebhookHealth>> {
    return request<WebhookHealth>(
      `/api/v1/webhooks/${encodeURIComponent(id)}/health`,
    );
  };
}

/**
 * Refined Webhooks PR 1: re-enable an auto-disabled webhook.
 * Resets status to 'active'. Idempotent — re-enabling a healthy
 * webhook returns 200 with no-op.
 */
export function createReEnableWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function reEnableWebhook(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/webhooks/${encodeURIComponent(id)}/re-enable`,
      { method: "POST" },
    );
  };
}

/**
 * Disable a webhook by setting its status to "paused" (PATCH) — the
 * reversible inverse of reEnableWebhook (which flips status back to
 * "active"). Only the supplied field is applied, so URL/events stay
 * untouched. NOTE: the /webhooks API is status-based
 * (active|paused|failing), NOT an `active` boolean — a stray
 * `{active:false}` is silently dropped by the Go decoder and the PATCH
 * becomes a no-op, so we must send `{status:"paused"}`.
 */
export function createDisableWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function disableWebhook(
    id: string,
  ): Promise<ApiResult<WebhookSubscription>> {
    return request<WebhookSubscription>(
      `/api/v1/webhooks/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ status: "paused" }) },
    );
  };
}

/**
 * Hard-delete a webhook (DELETE). The row and its delivery history go
 * away; use disableWebhook for a reversible pause instead.
 */
export function createDeleteWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function deleteWebhook(
    id: string,
  ): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>(
      `/api/v1/webhooks/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** Refined Webhooks PR 3: per-user webhook alert preferences. */
export function createGetWebhookAlertPrefs({
  request,
}: WebhookEventOperationsDependencies) {
  return function getWebhookAlertPrefs(): Promise<
    ApiResult<WebhookAlertPrefs>
  > {
    return request<WebhookAlertPrefs>("/api/v1/webhooks/alert-prefs");
  };
}

export function createPutWebhookAlertPrefs({
  request,
}: WebhookEventOperationsDependencies) {
  return function putWebhookAlertPrefs(
    input: WebhookAlertPrefsInput,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>("/api/v1/webhooks/alert-prefs", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  };
}

/**
 * Queue fresh trigger-action attempts from a stored processed inbound event.
 * The 202 response proves planning and durable enqueue only; workers execute
 * valid action intents later.
 */
export function createReplayInboundEvent({
  request,
}: WebhookEventOperationsDependencies) {
  return async function replayInboundEvent(
    webhookId: string,
    eventId: number | string,
    options: { idempotencyKey: string },
  ): Promise<ApiResult<InboundWebhookReplayResponse>> {
    const result = await request<unknown>(
      `/api/v1/inbound-webhooks/${encodeURIComponent(webhookId)}/events/${encodeURIComponent(String(eventId))}/replay`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": options.idempotencyKey,
        },
      },
    );
    return decodeInboundResult(result, decodeInboundWebhookReplayResponse);
  };
}

/** Refined Webhooks final batch: saved test payloads CRUD. */
export function createListWebhookTestPayloads({
  request,
}: WebhookEventOperationsDependencies) {
  return function listWebhookTestPayloads(
    webhookId: string,
    direction?: "inbound" | "outbound",
  ): Promise<ApiResult<{ items: WebhookTestPayload[] }>> {
    const params = new URLSearchParams();
    if (direction) params.set("direction", direction);
    const qs = params.toString();
    return request<{ items: WebhookTestPayload[] }>(
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}/test-payloads${qs ? `?${qs}` : ""}`,
    );
  };
}

export function createCreateWebhookTestPayload({
  request,
}: WebhookEventOperationsDependencies) {
  return function createWebhookTestPayload(
    webhookId: string,
    input: { name: string; direction: "inbound" | "outbound"; body: unknown },
  ): Promise<ApiResult<WebhookTestPayload>> {
    return request<WebhookTestPayload>(
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}/test-payloads`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

export function createDeleteWebhookTestPayload({
  request,
}: WebhookEventOperationsDependencies) {
  return function deleteWebhookTestPayload(
    id: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/webhooks/test-payloads/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

/** Refined Webhooks final batch: environment tag. */
export function createSetWebhookEnvironment({
  request,
}: WebhookEventOperationsDependencies) {
  return function setWebhookEnvironment(
    webhookId: string,
    env: WebhookEnvironment,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}/environment`,
      { method: "PATCH", body: JSON.stringify({ environment: env }) },
    );
  };
}

/**
 * GET /api/v1/webhooks/{id}/deliveries — last 100 delivery attempts for
 * one subscription. Server-side limit is hard-coded to 100; we expose
 * an `opts.limit` for forward-compat but the Go handler ignores unknown
 * query params today.
 */
export function createListWebhookDeliveries({
  request,
}: WebhookEventOperationsDependencies) {
  return function listWebhookDeliveries(
    id: string,
    opts: { limit?: number } = {},
  ): Promise<ApiResult<WebhookDeliveriesResponse>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<WebhookDeliveriesResponse>(
      `/api/v1/webhooks/${encodeURIComponent(id)}/deliveries${qs ? `?${qs}` : ""}`,
    );
  };
}

/**
 * POST /api/v1/webhooks/{id}/deliveries/{delivery_id}/replay — re-fire a
 * past delivery through the outbox pipeline using the stored payload.
 *
 * Backend may return 422 `payload_not_retained` for deliveries that
 * pre-date migration 0050 (no payload bytes stored). The desktop must
 * surface that as a clear "this is too old to replay" notice.
 *
 * 503 `outbox_unavailable` means the outbox dispatcher isn't wired in
 * the current deployment (rare).
 */
export function createRetryWebhookDelivery({
  request,
}: WebhookEventOperationsDependencies) {
  return function retryWebhookDelivery(
    webhookId: string,
    deliveryId: string | number,
  ): Promise<ApiResult<WebhookReplayResponse>> {
    return request<WebhookReplayResponse>(
      `/api/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(String(deliveryId))}/replay`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

/**
 * POST /api/v1/webhooks/{id}/test — fire a synthetic ping payload at
 * the subscription URL. The handler records a webhook_deliveries row
 * regardless of outcome so the deliveries list refreshes after a test.
 */
export function createTestWebhook({
  request,
}: WebhookEventOperationsDependencies) {
  return function testWebhook(
    id: string,
  ): Promise<ApiResult<WebhookTestResponse>> {
    return request<WebhookTestResponse>(
      `/api/v1/webhooks/${encodeURIComponent(id)}/test`,
      { method: "POST", body: JSON.stringify({}) },
    );
  };
}

export function createWebhookEventOperationsMethods(
  dependencies: WebhookEventOperationsDependencies,
) {
  return {
    listInboundWebhooks: createListInboundWebhooks(dependencies),
    createInboundWebhook: createCreateInboundWebhook(dependencies),
    getInboundWebhook: createGetInboundWebhook(dependencies),
    listInboundWebhookEvents: createListInboundWebhookEvents(dependencies),
    rotateInboundWebhook: createRotateInboundWebhook(dependencies),
    deleteInboundWebhook: createDeleteInboundWebhook(dependencies),
    listProductEvents: createListProductEvents(dependencies),
    getProductEventCatalog: createGetProductEventCatalog(dependencies),
    getProductEventStats: createGetProductEventStats(dependencies),
    productEventStreamUrl: createProductEventStreamUrl(dependencies),
    productEventStreamUrlAuthed:
      createProductEventStreamUrlAuthed(dependencies),
    productEventsCsvUrl: createProductEventsCsvUrl(dependencies),
    productEventsCsvUrlAuthed: createProductEventsCsvUrlAuthed(dependencies),
    sendProductEvent: createSendProductEvent(dependencies),
    listWebhooks: createListWebhooks(dependencies),
    createWebhook: createCreateWebhook(dependencies),
    updateWebhook: createUpdateWebhook(dependencies),
    getWebhookHealth: createGetWebhookHealth(dependencies),
    reEnableWebhook: createReEnableWebhook(dependencies),
    disableWebhook: createDisableWebhook(dependencies),
    deleteWebhook: createDeleteWebhook(dependencies),
    getWebhookAlertPrefs: createGetWebhookAlertPrefs(dependencies),
    putWebhookAlertPrefs: createPutWebhookAlertPrefs(dependencies),
    replayInboundEvent: createReplayInboundEvent(dependencies),
    listWebhookTestPayloads: createListWebhookTestPayloads(dependencies),
    createWebhookTestPayload: createCreateWebhookTestPayload(dependencies),
    deleteWebhookTestPayload: createDeleteWebhookTestPayload(dependencies),
    setWebhookEnvironment: createSetWebhookEnvironment(dependencies),
    listWebhookDeliveries: createListWebhookDeliveries(dependencies),
    retryWebhookDelivery: createRetryWebhookDelivery(dependencies),
    testWebhook: createTestWebhook(dependencies),
  };
}

// =============================================================================
// Outbound webhooks (public API). APPEND-ONLY block — do not edit above.
//
// Customers configure URLs + a list of event types in Settings; Moosewave
// POSTs a Stripe-style signed JSON body whenever a matching event fires.
// The signing secret is shown ONCE at create time and envelope-encrypted
// at rest thereafter.
// =============================================================================

export const OUTBOUND_WEBHOOK_EVENTS = [
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
  // Transactional message outcomes, per recipient. Distinct from
  // bounce.received, which is about an ADDRESS and drives suppression: these
  // name the MESSAGE, which is the only form a transactional sender can act on.
  "email.bounced",
  "email.complained",
  "email.delivered",
  // Campaign Assurance gates dispatch, so a blocked run is something to react
  // to rather than discover when the campaign never sends. There is no
  // success topic: a run without complete evidence is incomplete, never green,
  // and a pass-shaped topic would invite treating it as one.
  "assurance.run.completed",
  "assurance.run.blocked",
] as const;

export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];
export type OutboundWebhookSigningAlgorithm =
  | "hmac_sha256"
  | "ecdsa_p256"
  | "ed25519";

export const OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS = [
  "hmac_sha256",
  "ecdsa_p256",
  "ed25519",
] as const satisfies ReadonlyArray<OutboundWebhookSigningAlgorithm>;

export type OutboundWebhookAuthType =
  | "none"
  | "bearer"
  | "headers"
  | "custom_headers"
  | "mtls"
  | "combined";

/** Write-only receiver credentials accepted by create and PATCH. */
export interface OutboundWebhookAuthConfigInput {
  type?: OutboundWebhookAuthType;
  bearer_token?: string;
  headers?: Record<string, string>;
  mtls_cert_pem?: string;
  mtls_key_pem?: string;
}

/** Value-free receiver-auth projection returned by read APIs. */
export interface OutboundWebhookAuthMetadata {
  type?: Exclude<OutboundWebhookAuthType, "none">;
  bearer_configured?: boolean;
  header_names?: string[];
  mtls_configured?: boolean;
  secret_redacted?: boolean;
}

export type OutboundWebhookAuthConfigStatus =
  | "ready"
  | "legacy_pending"
  | "invalid";
export type OutboundWebhookURLStatus = "ready" | "legacy_pending" | "invalid";
export type OutboundWebhookDeliveryPolicyStatus = "ready" | "invalid";
export type OutboundWebhookDisabledReason = "manual" | "auto_failures";
export type OutboundWebhookTransformTemplate = Record<string, string>;

export interface OutboundWebhook {
  id: string;
  tenant_id: string;
  /**
   * Safe display projection only (for example `https://host/…?…`). Never
   * submit this value back in PATCH; omit `url` unless replacing it with the
   * complete destination.
   */
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  created_by_user_id?: string;
  created_at: string;
  updated_at: string;
  /** Monotonic revision of delivery-affecting endpoint configuration. */
  config_version: number;
  last_succeeded_at?: string;
  last_failed_at?: string;
  consecutive_failures: number;
  disabled_reason?: OutboundWebhookDisabledReason;
  disabled_at?: string;
  signing_algorithm: OutboundWebhookSigningAlgorithm;
  signing_public_key?: string;
  secondary_public_key?: string;
  secondary_expires_at?: string;
  rotated_at?: string;
  /** Optional audience scope for list.subscriber.* events. */
  list_id?: string;
  /** Redacted receiver-auth metadata. Raw credentials are write-only. */
  auth_config?: OutboundWebhookAuthMetadata;
  /** Whether encrypted receiver credentials are usable for live delivery. */
  auth_config_status: OutboundWebhookAuthConfigStatus;
  /** Whether the envelope-backed complete destination is usable. */
  url_status: OutboundWebhookURLStatus;
  /** Optional bounded pre-delivery filter over the canonical envelope. */
  filter_expression?: string;
  /** Optional RFC 6901 field projection applied before signing. */
  transform_template?: OutboundWebhookTransformTemplate;
  /** Whether the stored filter and transform are safe to execute. */
  delivery_policy_status: OutboundWebhookDeliveryPolicyStatus;
  /**
   * Deprecated compatibility field for older Simulator callers. The
   * canonical API does not return it and it must never be treated as an
   * isolation boundary.
   */
  environment?: WebhookEnvironment;
}

export interface OutboundWebhookCreateInput {
  url: string;
  description?: string;
  events: string[];
  algorithm?: OutboundWebhookSigningAlgorithm;
  list_id?: string;
  auth_config?: OutboundWebhookAuthConfigInput;
  filter_expression?: string;
  transform_template?: OutboundWebhookTransformTemplate;
}

export interface OutboundWebhookCreateResponse {
  webhook: OutboundWebhook;
  /** Present only for hmac_sha256 and returned once. */
  signing_secret?: string;
  /**
   * Asymmetric verification key; also retained on the webhook row. The
   * corresponding private signing key never leaves Moosewave.
   */
  public_key_pem?: string;
}

export interface OutboundWebhookUpdateInput {
  /**
   * Omit to preserve the complete destination. Read responses contain only a
   * redacted display projection, which is never a valid replacement value.
   */
  url?: string;
  description?: string;
  events?: string[];
  active?: boolean;
  /** null or type=none clears auth; omission preserves the current config. */
  auth_config?: OutboundWebhookAuthConfigInput | null;
  /** null clears the filter; omission preserves it. */
  filter_expression?: string | null;
  /** null clears the transform; omission preserves it. */
  transform_template?: OutboundWebhookTransformTemplate | null;
}

export type OutboundWebhookDeliveryStatus =
  | "pending"
  | "delivered"
  | "exhausted"
  | "skipped";

export interface OutboundWebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  attempt_count: number;
  next_attempt_at?: string;
  status: OutboundWebhookDeliveryStatus;
  last_status_code?: number;
  last_response_body_truncated?: string;
  last_error?: string;
  created_at: string;
  delivered_at?: string;
}

export interface OutboundWebhookTestResult {
  webhook_id: string;
  status_code: number;
  signed: boolean;
  /**
   * Empty or absent only when `filtered` is true and no receiver request was
   * made. A signed network delivery always carries a non-empty signature.
   */
  signature?: string;
  key_ids?: string;
  response: string;
  error?: string;
  /** True when the configured filter suppressed the receiver request. */
  filtered: boolean;
  redaction_applied?: boolean;
}

export interface OutboundWebhookPage {
  webhooks: OutboundWebhook[];
  /** Empty string means the server has no older page. */
  next_cursor: string;
}

export interface OutboundWebhookDeliveryPage {
  deliveries: OutboundWebhookDelivery[];
  /** Empty string means the server has no older page. */
  next_cursor: string;
}

export interface OutboundWebhookListOptions extends WebhookEventRequestOptions {
  cursor?: string;
  limit?: number;
  query?: string;
}

export interface OutboundWebhookDeliveryListOptions extends WebhookEventRequestOptions {
  cursor?: string;
}

export interface OutboundWebhookReplayOptions extends WebhookEventRequestOptions {
  /** Caller-stable per logical replay; reuse after ambiguous transport failure. */
  idempotencyKey: string;
}

export interface OutboundWebhookReplayResult {
  delivery_id: string;
  replayed_from: string;
  status: "pending";
  replayed_at: string;
}

export interface OutboundWebhookHealthError {
  status_code: number;
  message: string;
  count: number;
}

export interface OutboundWebhookHealth {
  deliveries_total: number;
  deliveries_succeeded: number;
  deliveries_failed: number;
  deliveries_pending: number;
  /** Tombstone-cancelled deliveries; excluded from failure/error counts. */
  deliveries_skipped: number;
  latency_p50_ms: number;
  latency_p99_ms: number;
  status_breakdown: Record<string, number>;
  top_errors: OutboundWebhookHealthError[];
  consecutive_failures: number;
  auto_disabled: boolean;
  disabled_reason?: OutboundWebhookDisabledReason;
  disabled_at?: string;
  last_succeeded_at?: string;
  last_failed_at?: string;
}

export interface OutboundWebhookDeleteResult {
  ok: boolean;
  /** True for the default permanent tombstone operation. */
  deleted: boolean;
  /** True only for the reversible `soft=1|true` deactivation operation. */
  deactivated: boolean;
}

class OutboundWebhookContractError extends Error {}

function outboundRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OutboundWebhookContractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function outboundExactRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = outboundRecord(value, path);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new OutboundWebhookContractError(
      `${path}.${unexpected} is not part of the published contract`,
    );
  }
  return record;
}

function outboundString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  { optional = false }: { optional?: boolean } = {},
): string | undefined {
  const value = record[key];
  if ((value === undefined || value === null) && optional) return undefined;
  if (typeof value !== "string" || (!optional && value.trim() === "")) {
    throw new OutboundWebhookContractError(`${path}.${key} must be a string`);
  }
  return value;
}

function outboundTimestamp(
  record: Record<string, unknown>,
  key: string,
  path: string,
  optional = false,
): string | undefined {
  const value = outboundString(record, key, path, { optional });
  if (value === undefined) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new OutboundWebhookContractError(
      `${path}.${key} must be an RFC 3339 timestamp`,
    );
  }
  return value;
}

function outboundInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  { optional = false, min = 0 }: { optional?: boolean; min?: number } = {},
): number | undefined {
  const value = record[key];
  if ((value === undefined || value === null) && optional) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new OutboundWebhookContractError(
      `${path}.${key} must be an integer of at least ${min}`,
    );
  }
  return value as number;
}

function outboundBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new OutboundWebhookContractError(`${path}.${key} must be a boolean`);
  }
  return value;
}

function outboundOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new OutboundWebhookContractError(`${path}.${key} must be a boolean`);
  }
  return value;
}

function outboundCursor(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    (value !== "" && !/^[A-Za-z0-9_+/=-]+$/u.test(value))
  ) {
    throw new OutboundWebhookContractError(
      `${path}.${key} must be a bounded opaque cursor string`,
    );
  }
  return value;
}

function decodeOutboundAuthConfig(
  value: unknown,
  path: string,
): OutboundWebhookAuthMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  const record = outboundExactRecord(value, path, [
    "type",
    "bearer_configured",
    "header_names",
    "mtls_configured",
    "secret_redacted",
    // Preserve the specific secret-leak diagnostic below.
    "bearer_token",
    "headers",
    "mtls_cert_pem",
    "mtls_key_pem",
  ]);
  for (const secretField of [
    "bearer_token",
    "headers",
    "mtls_cert_pem",
    "mtls_key_pem",
  ]) {
    if (record[secretField] !== undefined) {
      throw new OutboundWebhookContractError(
        `${path}.${secretField} must never be returned by a read API`,
      );
    }
  }

  const rawType = outboundString(record, "type", path, { optional: true });
  const allowedTypes = new Set([
    "bearer",
    "headers",
    "custom_headers",
    "mtls",
    "combined",
  ]);
  if (rawType !== undefined && !allowedTypes.has(rawType)) {
    throw new OutboundWebhookContractError(`${path}.type is unsupported`);
  }

  let headerNames: string[] | undefined;
  if (record.header_names !== undefined && record.header_names !== null) {
    if (
      !Array.isArray(record.header_names) ||
      record.header_names.length > 32
    ) {
      throw new OutboundWebhookContractError(
        `${path}.header_names must be an array of at most 32 names`,
      );
    }
    const seen = new Set<string>();
    headerNames = record.header_names.map((value, index) => {
      if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > 256
      ) {
        throw new OutboundWebhookContractError(
          `${path}.header_names[${index}] must be a bounded string`,
        );
      }
      const normalized = value.trim();
      const identity = normalized.toLowerCase();
      if (seen.has(identity)) {
        throw new OutboundWebhookContractError(
          `${path}.header_names contains a duplicate name`,
        );
      }
      seen.add(identity);
      return normalized;
    });
  }

  return {
    type: rawType as OutboundWebhookAuthMetadata["type"],
    bearer_configured: outboundOptionalBoolean(
      record,
      "bearer_configured",
      path,
    ),
    header_names: headerNames,
    mtls_configured: outboundOptionalBoolean(record, "mtls_configured", path),
    secret_redacted: outboundOptionalBoolean(record, "secret_redacted", path),
  };
}

function decodeOutboundTransformTemplate(
  value: unknown,
  path: string,
): OutboundWebhookTransformTemplate | undefined {
  if (value === undefined || value === null) return undefined;
  const record = outboundRecord(value, path);
  if (Object.keys(record).length > 64) {
    throw new OutboundWebhookContractError(
      `${path} must contain at most 64 output fields`,
    );
  }
  const template: OutboundWebhookTransformTemplate = {};
  for (const [field, pointer] of Object.entries(record)) {
    if (
      field.length === 0 ||
      typeof pointer !== "string" ||
      (pointer !== "" && !pointer.startsWith("/"))
    ) {
      throw new OutboundWebhookContractError(
        `${path}.${field || "<empty>"} must be an RFC 6901 pointer`,
      );
    }
    template[field] = pointer;
  }
  return template;
}

export function decodeOutboundWebhook(
  value: unknown,
  path = "webhook",
): OutboundWebhook {
  const record = outboundExactRecord(value, path, [
    "id",
    "tenant_id",
    "url",
    "description",
    "events",
    "active",
    "created_by_user_id",
    "created_at",
    "updated_at",
    "config_version",
    "last_succeeded_at",
    "last_failed_at",
    "consecutive_failures",
    "disabled_reason",
    "disabled_at",
    "signing_algorithm",
    "signing_public_key",
    "secondary_public_key",
    "secondary_expires_at",
    "rotated_at",
    "list_id",
    "auth_config",
    "auth_config_status",
    "url_status",
    "filter_expression",
    "transform_template",
    "delivery_policy_status",
  ]);
  const authConfigStatus = outboundString(record, "auth_config_status", path)!;
  if (!["ready", "legacy_pending", "invalid"].includes(authConfigStatus)) {
    throw new OutboundWebhookContractError(
      `${path}.auth_config_status is unsupported`,
    );
  }
  const urlStatus = outboundString(record, "url_status", path)!;
  if (!["ready", "legacy_pending", "invalid"].includes(urlStatus)) {
    throw new OutboundWebhookContractError(`${path}.url_status is unsupported`);
  }
  const deliveryPolicyStatus = outboundString(
    record,
    "delivery_policy_status",
    path,
  )!;
  if (!["ready", "invalid"].includes(deliveryPolicyStatus)) {
    throw new OutboundWebhookContractError(
      `${path}.delivery_policy_status is unsupported`,
    );
  }
  const disabledReason = outboundString(record, "disabled_reason", path, {
    optional: true,
  });
  if (
    disabledReason !== undefined &&
    !["manual", "auto_failures"].includes(disabledReason)
  ) {
    throw new OutboundWebhookContractError(
      `${path}.disabled_reason is unsupported`,
    );
  }
  const rawEvents = record.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new OutboundWebhookContractError(
      `${path}.events must be a non-empty array`,
    );
  }
  const allowedEvents = new Set<string>(OUTBOUND_WEBHOOK_EVENTS);
  const events = rawEvents.map((event, index) => {
    if (typeof event !== "string" || !allowedEvents.has(event)) {
      throw new OutboundWebhookContractError(
        `${path}.events[${index}] is not in the canonical event catalog`,
      );
    }
    return event;
  });
  const algorithm = outboundString(record, "signing_algorithm", path);
  if (
    !OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS.includes(
      algorithm as OutboundWebhookSigningAlgorithm,
    )
  ) {
    throw new OutboundWebhookContractError(
      `${path}.signing_algorithm is unsupported`,
    );
  }
  return {
    id: outboundString(record, "id", path)!,
    tenant_id: outboundString(record, "tenant_id", path)!,
    url: outboundString(record, "url", path)!,
    description: outboundString(record, "description", path, {
      optional: true,
    }),
    events,
    active: outboundBoolean(record, "active", path),
    created_by_user_id: outboundString(record, "created_by_user_id", path, {
      optional: true,
    }),
    created_at: outboundTimestamp(record, "created_at", path)!,
    updated_at: outboundTimestamp(record, "updated_at", path)!,
    config_version: outboundInteger(record, "config_version", path, {
      min: 1,
    })!,
    last_succeeded_at: outboundTimestamp(
      record,
      "last_succeeded_at",
      path,
      true,
    ),
    last_failed_at: outboundTimestamp(record, "last_failed_at", path, true),
    consecutive_failures: outboundInteger(
      record,
      "consecutive_failures",
      path,
    )!,
    disabled_reason: disabledReason as
      | OutboundWebhookDisabledReason
      | undefined,
    disabled_at: outboundTimestamp(record, "disabled_at", path, true),
    signing_algorithm: algorithm as OutboundWebhookSigningAlgorithm,
    signing_public_key: outboundString(record, "signing_public_key", path, {
      optional: true,
    }),
    secondary_public_key: outboundString(record, "secondary_public_key", path, {
      optional: true,
    }),
    secondary_expires_at: outboundTimestamp(
      record,
      "secondary_expires_at",
      path,
      true,
    ),
    rotated_at: outboundTimestamp(record, "rotated_at", path, true),
    list_id: outboundString(record, "list_id", path, { optional: true }),
    auth_config: decodeOutboundAuthConfig(
      record.auth_config,
      `${path}.auth_config`,
    ),
    auth_config_status: authConfigStatus as OutboundWebhookAuthConfigStatus,
    url_status: urlStatus as OutboundWebhookURLStatus,
    filter_expression: outboundString(record, "filter_expression", path, {
      optional: true,
    }),
    transform_template: decodeOutboundTransformTemplate(
      record.transform_template,
      `${path}.transform_template`,
    ),
    delivery_policy_status:
      deliveryPolicyStatus as OutboundWebhookDeliveryPolicyStatus,
  };
}

function decodeOutboundWebhookList(value: unknown): OutboundWebhookPage {
  const record = outboundExactRecord(value, "response", [
    "webhooks",
    "next_cursor",
  ]);
  if (!Array.isArray(record.webhooks)) {
    throw new OutboundWebhookContractError(
      "response.webhooks must be an array",
    );
  }
  const webhooks = record.webhooks.map((item, index) =>
    decodeOutboundWebhook(item, `response.webhooks[${index}]`),
  );
  const nextCursor = outboundCursor(record, "next_cursor", "response");
  if (webhooks.length === 0 && nextCursor) {
    throw new OutboundWebhookContractError(
      "response.next_cursor cannot continue an empty webhook page",
    );
  }
  return {
    webhooks,
    next_cursor: nextCursor,
  };
}

export function decodeOutboundWebhookCreateResponse(
  value: unknown,
  expectedWebhookID?: string,
): OutboundWebhookCreateResponse {
  const record = outboundExactRecord(value, "response", [
    "webhook",
    "signing_secret",
    "public_key_pem",
    // Preserve the explicit private-key leak failure below.
    "private_key_pem",
  ]);
  const webhook = decodeOutboundWebhook(record.webhook, "response.webhook");
  if (expectedWebhookID && webhook.id !== expectedWebhookID) {
    throw new OutboundWebhookContractError(
      "response.webhook.id does not match the requested webhook",
    );
  }
  const signingSecret = outboundString(record, "signing_secret", "response", {
    optional: true,
  });
  const privateKey = outboundString(record, "private_key_pem", "response", {
    optional: true,
  });
  const publicKey = outboundString(record, "public_key_pem", "response", {
    optional: true,
  });
  if (webhook.signing_algorithm === "hmac_sha256" && !signingSecret) {
    throw new OutboundWebhookContractError(
      "response.signing_secret is required for hmac_sha256",
    );
  }
  if (privateKey) {
    throw new OutboundWebhookContractError(
      "response.private_key_pem must not be returned; asymmetric private signing keys remain server-side",
    );
  }
  if (webhook.signing_algorithm !== "hmac_sha256" && signingSecret) {
    throw new OutboundWebhookContractError(
      "response.signing_secret is not valid for asymmetric signing",
    );
  }
  if (webhook.signing_algorithm !== "hmac_sha256" && !publicKey) {
    throw new OutboundWebhookContractError(
      "response.public_key_pem is required for asymmetric signing",
    );
  }
  if (
    publicKey &&
    webhook.signing_public_key &&
    publicKey !== webhook.signing_public_key
  ) {
    throw new OutboundWebhookContractError(
      "response.public_key_pem must match response.webhook.signing_public_key",
    );
  }
  return {
    webhook,
    signing_secret: signingSecret,
    public_key_pem: publicKey,
  };
}

function decodeOutboundDelivery(
  value: unknown,
  path: string,
): OutboundWebhookDelivery {
  const record = outboundExactRecord(value, path, [
    "id",
    "webhook_id",
    "event_type",
    "attempt_count",
    "next_attempt_at",
    "status",
    "last_status_code",
    "last_response_body_truncated",
    "last_error",
    "created_at",
    "delivered_at",
  ]);
  const status = outboundString(record, "status", path);
  if (
    !(["pending", "delivered", "exhausted", "skipped"] as string[]).includes(
      status!,
    )
  ) {
    throw new OutboundWebhookContractError(`${path}.status is unsupported`);
  }
  const eventType = outboundString(record, "event_type", path)!;
  if (!(OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(eventType)) {
    throw new OutboundWebhookContractError(
      `${path}.event_type is not in the canonical event catalog`,
    );
  }
  return {
    id: outboundString(record, "id", path)!,
    webhook_id: outboundString(record, "webhook_id", path)!,
    event_type: eventType,
    attempt_count: outboundInteger(record, "attempt_count", path)!,
    next_attempt_at: outboundTimestamp(record, "next_attempt_at", path, true),
    status: status as OutboundWebhookDeliveryStatus,
    last_status_code: outboundInteger(record, "last_status_code", path, {
      optional: true,
      min: 0,
    }),
    last_response_body_truncated: outboundString(
      record,
      "last_response_body_truncated",
      path,
      { optional: true },
    ),
    last_error: outboundString(record, "last_error", path, { optional: true }),
    created_at: outboundTimestamp(record, "created_at", path)!,
    delivered_at: outboundTimestamp(record, "delivered_at", path, true),
  };
}

function decodeOutboundDeliveries(
  value: unknown,
  expectedWebhookID: string,
): OutboundWebhookDeliveryPage {
  const record = outboundExactRecord(value, "response", [
    "deliveries",
    "next_cursor",
  ]);
  if (!Array.isArray(record.deliveries)) {
    throw new OutboundWebhookContractError(
      "response.deliveries must be an array",
    );
  }
  const deliveries = record.deliveries.map((item, index) =>
    decodeOutboundDelivery(item, `response.deliveries[${index}]`),
  );
  if (
    deliveries.some((delivery) => delivery.webhook_id !== expectedWebhookID)
  ) {
    throw new OutboundWebhookContractError(
      "response contains a delivery from a different webhook",
    );
  }
  const nextCursor = outboundCursor(record, "next_cursor", "response");
  if (deliveries.length === 0 && nextCursor) {
    throw new OutboundWebhookContractError(
      "response.next_cursor cannot continue an empty delivery page",
    );
  }
  return {
    deliveries,
    next_cursor: nextCursor,
  };
}

function decodeOutboundHealth(value: unknown): OutboundWebhookHealth {
  const record = outboundExactRecord(value, "response", [
    "deliveries_total",
    "deliveries_succeeded",
    "deliveries_failed",
    "deliveries_pending",
    "deliveries_skipped",
    "latency_p50_ms",
    "latency_p99_ms",
    "status_breakdown",
    "top_errors",
    "consecutive_failures",
    "auto_disabled",
    "disabled_reason",
    "disabled_at",
    "last_succeeded_at",
    "last_failed_at",
  ]);
  const statusValue = outboundRecord(
    record.status_breakdown,
    "response.status_breakdown",
  );
  const status_breakdown: Record<string, number> = {};
  for (const [status, count] of Object.entries(statusValue)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new OutboundWebhookContractError(
        `response.status_breakdown.${status} must be a non-negative integer`,
      );
    }
    status_breakdown[status] = count as number;
  }
  if (!Array.isArray(record.top_errors)) {
    throw new OutboundWebhookContractError(
      "response.top_errors must be an array",
    );
  }
  const top_errors = record.top_errors.map((value, index) => {
    const item = outboundExactRecord(value, `response.top_errors[${index}]`, [
      "status_code",
      "message",
      "count",
    ]);
    return {
      status_code: outboundInteger(
        item,
        "status_code",
        `response.top_errors[${index}]`,
      )!,
      message:
        outboundString(item, "message", `response.top_errors[${index}]`, {
          optional: true,
        }) ?? "",
      count: outboundInteger(item, "count", `response.top_errors[${index}]`)!,
    };
  });
  return {
    deliveries_total: outboundInteger(record, "deliveries_total", "response")!,
    deliveries_succeeded: outboundInteger(
      record,
      "deliveries_succeeded",
      "response",
    )!,
    deliveries_failed: outboundInteger(
      record,
      "deliveries_failed",
      "response",
    )!,
    deliveries_pending: outboundInteger(
      record,
      "deliveries_pending",
      "response",
    )!,
    deliveries_skipped: outboundInteger(
      record,
      "deliveries_skipped",
      "response",
    )!,
    latency_p50_ms: outboundInteger(record, "latency_p50_ms", "response")!,
    latency_p99_ms: outboundInteger(record, "latency_p99_ms", "response")!,
    status_breakdown,
    top_errors,
    consecutive_failures: outboundInteger(
      record,
      "consecutive_failures",
      "response",
    )!,
    auto_disabled: outboundBoolean(record, "auto_disabled", "response"),
    disabled_reason: (() => {
      const reason = outboundString(record, "disabled_reason", "response", {
        optional: true,
      });
      if (
        reason !== undefined &&
        !["manual", "auto_failures"].includes(reason)
      ) {
        throw new OutboundWebhookContractError(
          "response.disabled_reason is unsupported",
        );
      }
      return reason as OutboundWebhookDisabledReason | undefined;
    })(),
    disabled_at: outboundTimestamp(record, "disabled_at", "response", true),
    last_succeeded_at: outboundTimestamp(
      record,
      "last_succeeded_at",
      "response",
      true,
    ),
    last_failed_at: outboundTimestamp(
      record,
      "last_failed_at",
      "response",
      true,
    ),
  };
}

function decodeOutboundTestResult(
  value: unknown,
  expectedWebhookID: string,
): OutboundWebhookTestResult {
  const record = outboundExactRecord(value, "response", [
    "webhook_id",
    "filtered",
    "signed",
    "status_code",
    "signature",
    "response",
    "error",
  ]);
  const webhookID = outboundString(record, "webhook_id", "response")!;
  if (webhookID !== expectedWebhookID) {
    throw new OutboundWebhookContractError(
      "response.webhook_id does not match the requested webhook",
    );
  }
  const filtered =
    outboundOptionalBoolean(record, "filtered", "response") ?? false;
  const signed = outboundBoolean(record, "signed", "response");
  const statusCode = outboundInteger(record, "status_code", "response")!;
  const signature = outboundString(record, "signature", "response", {
    optional: true,
  });
  const response =
    outboundString(record, "response", "response", { optional: true }) ?? "";
  const error = outboundString(record, "error", "response", {
    optional: true,
  });

  if (filtered) {
    if (
      statusCode !== 204 ||
      signed ||
      (signature !== undefined && signature !== "") ||
      response !== "" ||
      error !== undefined
    ) {
      throw new OutboundWebhookContractError(
        "response.filtered test results must be unsigned HTTP 204 results with no receiver output",
      );
    }
  } else if (!signed || !signature?.trim()) {
    throw new OutboundWebhookContractError(
      "an unfiltered test result must be signed and include a signature",
    );
  }

  return {
    webhook_id: webhookID,
    status_code: statusCode,
    signed,
    signature,
    key_ids: outboundString(record, "key_ids", "response", { optional: true }),
    response,
    error,
    filtered,
    redaction_applied: outboundOptionalBoolean(
      record,
      "redaction_applied",
      "response",
    ),
  };
}

function decodeOutboundResult<T>(
  result: ApiResult<unknown>,
  decode: (value: unknown) => T,
): ApiResult<T> {
  if (result.error) return result;
  try {
    return {
      data: decode(result.data),
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof OutboundWebhookContractError
        ? error.message
        : "response did not match the canonical outbound webhook contract";
    return {
      error: {
        kind: "parse",
        code: "outbound_webhook_contract",
        message: `Moosewave returned malformed outbound webhook data (${detail}). No data was discarded or treated as empty.`,
      },
      retryability: "not-retryable",
    };
  }
}

function liveWebhookMutationOptions(
  opts: WebhookEventRequestOptions,
): WebhookEventRequestOptions {
  return { ...opts, requireOnline: true, maxAttempts: 1 };
}

export function createCanonicalOutboundWebhookOperations({
  request,
}: Pick<WebhookEventOperationsDependencies, "request">) {
  async function listOutboundWebhooks(
    opts: OutboundWebhookListOptions = {},
  ): Promise<ApiResult<OutboundWebhookPage>> {
    const { cursor, limit, query, ...requestOpts } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== undefined) {
      params.set(
        "limit",
        String(Math.max(1, Math.min(200, Math.floor(limit)))),
      );
    }
    if (query?.trim()) params.set("query", query.trim());
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks${suffix}`,
        {},
        requestOpts,
      ),
      decodeOutboundWebhookList,
    );
  }

  async function createOutboundWebhook(
    input: OutboundWebhookCreateInput,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    return decodeOutboundResult(
      await request<unknown>(
        "/api/v1/outbound-webhooks",
        {
          method: "POST",
          body: JSON.stringify(input),
          ...(idempotencyKey
            ? { headers: { "Idempotency-Key": idempotencyKey } }
            : {}),
        },
        liveWebhookMutationOptions(requestOpts),
      ),
      decodeOutboundWebhookCreateResponse,
    );
  }

  async function updateOutboundWebhook(
    id: string,
    patch: OutboundWebhookUpdateInput,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhook>> {
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
        liveWebhookMutationOptions(opts),
      ),
      (value) => {
        const webhook = decodeOutboundWebhook(value, "response");
        if (webhook.id !== id) {
          throw new OutboundWebhookContractError(
            "response.id does not match the requested webhook",
          );
        }
        return webhook;
      },
    );
  }

  async function deleteOutboundWebhook(
    id: string,
    opts: { soft?: boolean } = {},
    requestOpts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookDeleteResult>> {
    const suffix = opts.soft ? "?soft=1" : "";
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}${suffix}`,
        { method: "DELETE" },
        liveWebhookMutationOptions(requestOpts),
      ),
      (value) => {
        const record = outboundExactRecord(value, "response", [
          "ok",
          "deleted",
          "deactivated",
        ]);
        const result = {
          ok: outboundBoolean(record, "ok", "response"),
          deleted: outboundBoolean(record, "deleted", "response"),
          deactivated: outboundBoolean(record, "deactivated", "response"),
        };
        const expected = opts.soft
          ? result.ok && result.deleted === false && result.deactivated === true
          : result.ok &&
            result.deleted === true &&
            result.deactivated === false;
        if (!expected) {
          throw new OutboundWebhookContractError(
            `response must acknowledge the requested ${opts.soft ? "deactivation" : "permanent deletion"} mode`,
          );
        }
        return result;
      },
    );
  }

  async function testOutboundWebhook(
    id: string,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookTestResult>> {
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/test`,
        { method: "POST" },
        liveWebhookMutationOptions(opts),
      ),
      (value) => decodeOutboundTestResult(value, id),
    );
  }

  async function listOutboundWebhookDeliveries(
    id: string,
    limit = 50,
    opts: OutboundWebhookDeliveryListOptions = {},
  ): Promise<ApiResult<OutboundWebhookDeliveryPage>> {
    const { cursor, ...requestOpts } = opts;
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const params = new URLSearchParams({ limit: String(safeLimit) });
    if (cursor) params.set("cursor", cursor);
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/deliveries?${params.toString()}`,
        {},
        requestOpts,
      ),
      (value) => decodeOutboundDeliveries(value, id),
    );
  }

  async function replayOutboundWebhookDelivery(
    deliveryId: string,
    opts: OutboundWebhookReplayOptions,
  ): Promise<ApiResult<OutboundWebhookReplayResult>> {
    const { idempotencyKey, ...requestOpts } = opts;
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey },
        },
        liveWebhookMutationOptions(requestOpts),
      ),
      (value) => {
        const record = outboundRecord(value, "response");
        const unexpected = Object.keys(record).find(
          (key) =>
            !["delivery_id", "replayed_from", "status", "replayed_at"].includes(
              key,
            ),
        );
        if (unexpected) {
          throw new OutboundWebhookContractError(
            `response.${unexpected} is not part of the replay contract`,
          );
        }
        const status = outboundString(record, "status", "response");
        if (status !== "pending") {
          throw new OutboundWebhookContractError(
            "response.status must be pending after replay",
          );
        }
        const replayedFrom = outboundString(
          record,
          "replayed_from",
          "response",
        )!;
        if (replayedFrom !== deliveryId) {
          throw new OutboundWebhookContractError(
            "response.replayed_from does not match the requested delivery",
          );
        }
        return {
          delivery_id: outboundString(record, "delivery_id", "response")!,
          replayed_from: replayedFrom,
          status,
          replayed_at: outboundTimestamp(record, "replayed_at", "response")!,
        };
      },
    );
  }

  async function rotateOutboundWebhookSigningMaterial(
    id: string,
    graceMinutes?: number,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    const suffix =
      graceMinutes === undefined
        ? ""
        : `?grace_minutes=${encodeURIComponent(String(graceMinutes))}`;
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/rotate-secret${suffix}`,
        {
          method: "POST",
          ...(idempotencyKey
            ? { headers: { "Idempotency-Key": idempotencyKey } }
            : {}),
        },
        liveWebhookMutationOptions(requestOpts),
      ),
      (value) => decodeOutboundWebhookCreateResponse(value, id),
    );
  }

  async function getOutboundWebhookHealth(
    id: string,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookHealth>> {
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/health`,
        {},
        opts,
      ),
      decodeOutboundHealth,
    );
  }

  async function reEnableOutboundWebhook(
    id: string,
    opts: WebhookEventRequestOptions = {},
  ): Promise<ApiResult<{ ok: boolean }>> {
    return decodeOutboundResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/re-enable`,
        { method: "POST" },
        liveWebhookMutationOptions(opts),
      ),
      (value) => {
        const record = outboundExactRecord(value, "response", ["ok"]);
        if (outboundBoolean(record, "ok", "response") !== true) {
          throw new OutboundWebhookContractError("response.ok must be true");
        }
        return { ok: true };
      },
    );
  }

  return {
    listOutboundWebhooks,
    createOutboundWebhook,
    updateOutboundWebhook,
    deleteOutboundWebhook,
    testOutboundWebhook,
    listOutboundWebhookDeliveries,
    replayOutboundWebhookDelivery,
    rotateOutboundWebhookSigningMaterial,
    getOutboundWebhookHealth,
    reEnableOutboundWebhook,
  };
}
