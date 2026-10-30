import type { ApiResult } from "./result";
import type {
  OutboundWebhookDelivery,
  OutboundWebhookDeliveryPage,
  OutboundWebhookTestResult,
} from "./webhook-event-operations";

export const LIST_SCOPED_WEBHOOK_EVENTS = ["list.subscriber.added"] as const;

export type ListScopedWebhookEvent =
  (typeof LIST_SCOPED_WEBHOOK_EVENTS)[number];

export interface ListScopedWebhook {
  id: string;
  /** Display-only destination projection; never round-trip it in PATCH. */
  url: string;
  description?: string;
  events: ListScopedWebhookEvent[];
  active: boolean;
  url_status: "ready" | "legacy_pending" | "invalid";
  auth_config_status: "ready" | "legacy_pending" | "invalid";
  delivery_policy_status: "ready" | "invalid";
  created_at: string;
  updated_at: string;
  last_succeeded_at?: string;
  last_failed_at?: string;
}

export interface ListScopedWebhookPage {
  list_id: string;
  webhooks: ListScopedWebhook[];
  /** Empty string means the server has no older page. */
  next_cursor: string;
}

export interface ListScopedWebhookCreateInput {
  url: string;
  description?: string;
  events: ListScopedWebhookEvent[];
}

export interface ListScopedWebhookUpdateInput {
  /** Omit to preserve the encrypted destination. */
  url?: string;
  description?: string;
  events?: ListScopedWebhookEvent[];
  active?: boolean;
}

export interface ListScopedWebhookCreateResponse extends ListScopedWebhook {
  /** HMAC-SHA256 signing secret returned exactly once. */
  signing_secret: string;
}

export interface ListWebhookRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export interface ListWebhookIdempotentMutationOptions extends ListWebhookRequestOptions {
  /** Reuse this exact key when retrying the same logical mutation. */
  idempotencyKey: string;
}

export interface ListScopedWebhookListOptions extends ListWebhookRequestOptions {
  cursor?: string;
  limit?: number;
}

export interface ListScopedWebhookDeliveryOptions extends ListWebhookRequestOptions {
  cursor?: string;
  limit?: number;
}

export type ListWebhookRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: ListWebhookRequestOptions,
) => Promise<ApiResult<T>>;

class ListWebhookContractError extends Error {}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WEBHOOK_FIELDS = [
  "id",
  "url",
  "description",
  "events",
  "active",
  "url_status",
  "auth_config_status",
  "delivery_policy_status",
  "created_at",
  "updated_at",
  "last_succeeded_at",
  "last_failed_at",
] as const;

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ListWebhookContractError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  path: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const item = record(value, path);
  const unexpected = Object.keys(item).find(
    (key) => !allowedFields.includes(key),
  );
  if (unexpected) {
    throw new ListWebhookContractError(
      `${path}.${unexpected} is not part of the list webhook contract`,
    );
  }
  return item;
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  optional = false,
): string | undefined {
  const item = value[key];
  if (item === undefined && optional) return undefined;
  if (typeof item !== "string" || (!optional && item.trim() === "")) {
    throw new ListWebhookContractError(`${path}.${key} must be a string`);
  }
  return item;
}

function booleanValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  if (typeof value[key] !== "boolean") {
    throw new ListWebhookContractError(`${path}.${key} must be a boolean`);
  }
  return value[key] as boolean;
}

function optionalBooleanValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  if (value[key] === undefined) return undefined;
  return booleanValue(value, key, path);
}

function integerValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  optional = false,
): number | undefined {
  const item = value[key];
  if (item === undefined && optional) return undefined;
  if (!Number.isSafeInteger(item) || (item as number) < 0) {
    throw new ListWebhookContractError(
      `${path}.${key} must be a non-negative integer`,
    );
  }
  return item as number;
}

function uuidValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const item = stringValue(value, key, path)!;
  if (!UUID_PATTERN.test(item)) {
    throw new ListWebhookContractError(
      `${path}.${key} must be a canonical UUID`,
    );
  }
  return item;
}

function assertUniqueIDs(
  items: ReadonlyArray<{ id: string }>,
  path: string,
): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new ListWebhookContractError(
        `${path} contains duplicate id ${item.id}`,
      );
    }
    ids.add(item.id);
  }
}

function timestampValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  optional = false,
): string | undefined {
  const item = stringValue(value, key, path, optional);
  if (item === undefined) return undefined;
  if (!Number.isFinite(Date.parse(item))) {
    throw new ListWebhookContractError(
      `${path}.${key} must be an RFC 3339 timestamp`,
    );
  }
  return item;
}

function cursorValue(value: Record<string, unknown>, path: string): string {
  const cursor = value.next_cursor;
  if (
    typeof cursor !== "string" ||
    cursor.length > 2048 ||
    (cursor !== "" && !/^[A-Za-z0-9_+/=-]+$/u.test(cursor))
  ) {
    throw new ListWebhookContractError(
      `${path}.next_cursor must be a bounded opaque cursor`,
    );
  }
  return cursor;
}

function decodeListScopedWebhook(
  value: unknown,
  path: string,
  allowSigningSecret = false,
): ListScopedWebhook {
  const item = exactRecord(
    value,
    path,
    allowSigningSecret ? [...WEBHOOK_FIELDS, "signing_secret"] : WEBHOOK_FIELDS,
  );
  if (!Array.isArray(item.events) || item.events.length === 0) {
    throw new ListWebhookContractError(
      `${path}.events must be a non-empty array`,
    );
  }
  const events = item.events.map((event, index) => {
    if (
      typeof event !== "string" ||
      !LIST_SCOPED_WEBHOOK_EVENTS.includes(event as ListScopedWebhookEvent)
    ) {
      throw new ListWebhookContractError(
        `${path}.events[${index}] is not produced by list webhook fanout`,
      );
    }
    return event as ListScopedWebhookEvent;
  });
  if (new Set(events).size !== events.length) {
    throw new ListWebhookContractError(`${path}.events must be unique`);
  }
  const urlStatus = stringValue(item, "url_status", path)!;
  const authStatus = stringValue(item, "auth_config_status", path)!;
  const policyStatus = stringValue(item, "delivery_policy_status", path)!;
  if (!["ready", "legacy_pending", "invalid"].includes(urlStatus)) {
    throw new ListWebhookContractError(`${path}.url_status is unsupported`);
  }
  if (!["ready", "legacy_pending", "invalid"].includes(authStatus)) {
    throw new ListWebhookContractError(
      `${path}.auth_config_status is unsupported`,
    );
  }
  if (!["ready", "invalid"].includes(policyStatus)) {
    throw new ListWebhookContractError(
      `${path}.delivery_policy_status is unsupported`,
    );
  }
  return {
    id: uuidValue(item, "id", path),
    url: stringValue(item, "url", path)!,
    description: stringValue(item, "description", path, true),
    events,
    active: booleanValue(item, "active", path),
    url_status: urlStatus as ListScopedWebhook["url_status"],
    auth_config_status: authStatus as ListScopedWebhook["auth_config_status"],
    delivery_policy_status:
      policyStatus as ListScopedWebhook["delivery_policy_status"],
    created_at: timestampValue(item, "created_at", path)!,
    updated_at: timestampValue(item, "updated_at", path)!,
    last_succeeded_at: timestampValue(item, "last_succeeded_at", path, true),
    last_failed_at: timestampValue(item, "last_failed_at", path, true),
  };
}

function decodeListScopedWebhookPage(
  value: unknown,
  expectedListID: string,
): ListScopedWebhookPage {
  const response = exactRecord(value, "response", [
    "list_id",
    "webhooks",
    "next_cursor",
  ]);
  const listID = uuidValue(response, "list_id", "response");
  if (listID !== expectedListID) {
    throw new ListWebhookContractError(
      "response.list_id does not match the requested canonical list",
    );
  }
  if (!Array.isArray(response.webhooks)) {
    throw new ListWebhookContractError("response.webhooks must be an array");
  }
  const webhooks = response.webhooks.map((webhook, index) =>
    decodeListScopedWebhook(webhook, `response.webhooks[${index}]`),
  );
  assertUniqueIDs(webhooks, "response.webhooks");
  const nextCursor = cursorValue(response, "response");
  if (webhooks.length === 0 && nextCursor !== "") {
    throw new ListWebhookContractError(
      "response.next_cursor cannot continue an empty page",
    );
  }
  return { list_id: listID, webhooks, next_cursor: nextCursor };
}

function decodeListScopedWebhookCreate(
  value: unknown,
  expectedWebhookID?: string,
): ListScopedWebhookCreateResponse {
  const response = exactRecord(value, "response", [
    ...WEBHOOK_FIELDS,
    "signing_secret",
  ]);
  const webhook = decodeListScopedWebhook(response, "response", true);
  if (expectedWebhookID && webhook.id !== expectedWebhookID) {
    throw new ListWebhookContractError(
      "response.id does not match the requested webhook",
    );
  }
  const signingSecret = stringValue(response, "signing_secret", "response")!;
  return { ...webhook, signing_secret: signingSecret };
}

function decodeDelivery(value: unknown, path: string): OutboundWebhookDelivery {
  const item = exactRecord(value, path, [
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
  const status = stringValue(item, "status", path)!;
  if (!["pending", "delivered", "exhausted", "skipped"].includes(status)) {
    throw new ListWebhookContractError(`${path}.status is unsupported`);
  }
  return {
    id: uuidValue(item, "id", path),
    webhook_id: uuidValue(item, "webhook_id", path),
    event_type: stringValue(item, "event_type", path)!,
    attempt_count: integerValue(item, "attempt_count", path)!,
    next_attempt_at: timestampValue(item, "next_attempt_at", path, true),
    status: status as OutboundWebhookDelivery["status"],
    last_status_code: integerValue(item, "last_status_code", path, true),
    last_response_body_truncated: stringValue(
      item,
      "last_response_body_truncated",
      path,
      true,
    ),
    last_error: stringValue(item, "last_error", path, true),
    created_at: timestampValue(item, "created_at", path)!,
    delivered_at: timestampValue(item, "delivered_at", path, true),
  };
}

function decodeDeliveries(
  value: unknown,
  expectedWebhookID: string,
): OutboundWebhookDeliveryPage {
  const response = exactRecord(value, "response", [
    "deliveries",
    "next_cursor",
  ]);
  if (!Array.isArray(response.deliveries)) {
    throw new ListWebhookContractError("response.deliveries must be an array");
  }
  const deliveries = response.deliveries.map((delivery, index) =>
    decodeDelivery(delivery, `response.deliveries[${index}]`),
  );
  assertUniqueIDs(deliveries, "response.deliveries");
  if (
    deliveries.some((delivery) => delivery.webhook_id !== expectedWebhookID)
  ) {
    throw new ListWebhookContractError(
      "response contains a delivery from a different webhook",
    );
  }
  const nextCursor = cursorValue(response, "response");
  if (deliveries.length === 0 && nextCursor !== "") {
    throw new ListWebhookContractError(
      "response.next_cursor cannot continue an empty delivery page",
    );
  }
  return { deliveries, next_cursor: nextCursor };
}

function decodeTestResult(
  value: unknown,
  expectedWebhookID: string,
): OutboundWebhookTestResult {
  const response = exactRecord(value, "response", [
    "webhook_id",
    "status_code",
    "signed",
    "signature",
    "key_ids",
    "response",
    "error",
    "filtered",
    "redaction_applied",
  ]);
  const webhookID = uuidValue(response, "webhook_id", "response");
  if (webhookID !== expectedWebhookID) {
    throw new ListWebhookContractError(
      "response.webhook_id does not match the requested webhook",
    );
  }
  const statusCode = integerValue(response, "status_code", "response")!;
  const signed = booleanValue(response, "signed", "response");
  const filtered =
    optionalBooleanValue(response, "filtered", "response") ?? false;
  const signature = stringValue(response, "signature", "response", true);
  const receiverResponse = stringValue(response, "response", "response")!;
  const error = stringValue(response, "error", "response", true);
  if (
    filtered &&
    (statusCode !== 204 ||
      signed ||
      (signature !== undefined && signature !== "") ||
      receiverResponse !== "" ||
      error !== undefined)
  ) {
    throw new ListWebhookContractError(
      "a filtered probe must be an unsigned HTTP 204 outcome with no receiver output",
    );
  }
  if (!filtered && (!signed || !signature?.trim())) {
    throw new ListWebhookContractError(
      "response must describe a signed probe unless it was filtered",
    );
  }
  return {
    webhook_id: webhookID,
    status_code: statusCode,
    signed,
    signature,
    key_ids: stringValue(response, "key_ids", "response", true),
    response: receiverResponse,
    error,
    filtered,
    redaction_applied: optionalBooleanValue(
      response,
      "redaction_applied",
      "response",
    ),
  };
}

function decodeResult<T>(
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
      error instanceof ListWebhookContractError
        ? error.message
        : "response did not match the list webhook contract";
    return {
      error: {
        kind: "parse",
        code: "list_webhook_contract",
        message: `Moosewave returned malformed list webhook data (${detail}). No data was discarded or treated as empty.`,
      },
      retryability: "not-retryable",
    };
  }
}

function safePageLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function listPath(listID: string): string {
  return `/api/v1/lists/${encodeURIComponent(listID)}/webhooks`;
}

function childPath(listID: string, webhookID: string): string {
  return `${listPath(listID)}/${encodeURIComponent(webhookID)}`;
}

function mutationOptions(
  opts: ListWebhookRequestOptions,
): ListWebhookRequestOptions {
  return { ...opts, requireOnline: true, maxAttempts: 1 };
}

function idempotencyHeader(idempotencyKey: string): HeadersInit {
  if (
    idempotencyKey.length === 0 ||
    idempotencyKey.length > 256 ||
    idempotencyKey !== idempotencyKey.trim() ||
    /[\u0000-\u001f\u007f]/u.test(idempotencyKey)
  ) {
    throw new ListWebhookContractError(
      "idempotencyKey must be a nonempty, bounded header value",
    );
  }
  return { "Idempotency-Key": idempotencyKey };
}

export function createListWebhookOperations({
  request,
}: {
  request: ListWebhookRequester;
}) {
  async function listListScopedWebhooks(
    listID: string,
    opts: ListScopedWebhookListOptions = {},
  ): Promise<ApiResult<ListScopedWebhookPage>> {
    const { cursor, limit, ...requestOpts } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const boundedLimit = safePageLimit(limit);
    if (boundedLimit !== undefined) params.set("limit", String(boundedLimit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return decodeResult(
      await request<unknown>(`${listPath(listID)}${suffix}`, {}, requestOpts),
      (value) => {
        const page = decodeListScopedWebhookPage(value, listID);
        if (cursor && page.next_cursor === cursor) {
          throw new ListWebhookContractError(
            "response.next_cursor repeated the requested cursor",
          );
        }
        return page;
      },
    );
  }

  async function createListScopedWebhook(
    listID: string,
    input: ListScopedWebhookCreateInput,
    opts: ListWebhookIdempotentMutationOptions,
  ): Promise<ApiResult<ListScopedWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    return decodeResult(
      await request<unknown>(
        listPath(listID),
        {
          method: "POST",
          body: JSON.stringify(input),
          headers: idempotencyHeader(idempotencyKey),
        },
        mutationOptions(requestOpts),
      ),
      decodeListScopedWebhookCreate,
    );
  }

  async function updateListScopedWebhook(
    listID: string,
    webhookID: string,
    input: ListScopedWebhookUpdateInput,
    opts: ListWebhookRequestOptions = {},
  ): Promise<ApiResult<ListScopedWebhook>> {
    return decodeResult(
      await request<unknown>(
        childPath(listID, webhookID),
        { method: "PATCH", body: JSON.stringify(input) },
        mutationOptions(opts),
      ),
      (value) => {
        const webhook = decodeListScopedWebhook(value, "response");
        if (webhook.id !== webhookID) {
          throw new ListWebhookContractError(
            "response.id does not match the requested webhook",
          );
        }
        return webhook;
      },
    );
  }

  async function rotateListScopedWebhookSigningMaterial(
    listID: string,
    webhookID: string,
    graceMinutes: number | undefined,
    opts: ListWebhookIdempotentMutationOptions,
  ): Promise<ApiResult<ListScopedWebhookCreateResponse>> {
    const { idempotencyKey, ...requestOpts } = opts;
    if (
      graceMinutes !== undefined &&
      (!Number.isSafeInteger(graceMinutes) ||
        graceMinutes < 1 ||
        graceMinutes > 10_080)
    ) {
      throw new ListWebhookContractError(
        "graceMinutes must be an integer from 1 through 10080",
      );
    }
    const suffix =
      graceMinutes === undefined
        ? ""
        : `?grace_minutes=${encodeURIComponent(String(graceMinutes))}`;
    return decodeResult(
      await request<unknown>(
        `${childPath(listID, webhookID)}/rotate-secret${suffix}`,
        {
          method: "POST",
          headers: idempotencyHeader(idempotencyKey),
        },
        mutationOptions(requestOpts),
      ),
      (value) => decodeListScopedWebhookCreate(value, webhookID),
    );
  }

  async function deleteListScopedWebhook(
    listID: string,
    webhookID: string,
    opts: ListWebhookRequestOptions = {},
  ): Promise<ApiResult<void>> {
    return decodeResult(
      await request<unknown>(
        childPath(listID, webhookID),
        { method: "DELETE" },
        mutationOptions(opts),
      ),
      (value) => {
        if (value !== undefined) {
          throw new ListWebhookContractError(
            "delete response must be an empty HTTP 204 acknowledgement",
          );
        }
      },
    );
  }

  async function testListScopedWebhook(
    listID: string,
    webhookID: string,
    opts: ListWebhookRequestOptions = {},
  ): Promise<ApiResult<OutboundWebhookTestResult>> {
    return decodeResult(
      await request<unknown>(
        `${childPath(listID, webhookID)}/test`,
        { method: "POST" },
        mutationOptions(opts),
      ),
      (value) => decodeTestResult(value, webhookID),
    );
  }

  async function listListScopedWebhookDeliveries(
    listID: string,
    webhookID: string,
    opts: ListScopedWebhookDeliveryOptions = {},
  ): Promise<ApiResult<OutboundWebhookDeliveryPage>> {
    const { cursor, limit, ...requestOpts } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    const boundedLimit = safePageLimit(limit);
    if (boundedLimit !== undefined) params.set("limit", String(boundedLimit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return decodeResult(
      await request<unknown>(
        `${childPath(listID, webhookID)}/deliveries${suffix}`,
        {},
        requestOpts,
      ),
      (value) => {
        const page = decodeDeliveries(value, webhookID);
        if (cursor && page.next_cursor === cursor) {
          throw new ListWebhookContractError(
            "response.next_cursor repeated the requested cursor",
          );
        }
        return page;
      },
    );
  }

  return {
    listListScopedWebhooks,
    createListScopedWebhook,
    updateListScopedWebhook,
    rotateListScopedWebhookSigningMaterial,
    deleteListScopedWebhook,
    testListScopedWebhook,
    listListScopedWebhookDeliveries,
  };
}
