// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/outbound-webhooks-api.ts — the PUBLIC outbound-webhooks entity.
 *
 * `/api/v1/outbound-webhooks` (tables outbound_webhooks*) is the customer
 * integration surface: signed event deliveries to Zapier, n8n, a customer's
 * own server. It is a DIFFERENT entity from `/api/v1/webhooks`
 * (lib/webhooks-api.ts, the settings/webhooks page), which is Moosewave's own
 * product-webhook family with its own tables. Do not merge the two.
 *
 * Every mutation here is LIVE: `requireOnline` refuses the offline outbox and
 * `maxAttempts: 1` refuses transport retries, because a replayed rotate would
 * mint two keys, a replayed test would fire the receiver twice, and a replayed
 * delete after a reconnect is exactly the surprise an operator cannot undo.
 * Desktop's `liveWebhookMutationOptions` makes the same choice.
 *
 * Field names are the server's (apps/api/internal/outbound_webhooks).
 */
import { api } from "@/lib/api";
import { base, type RoleKey } from "@/lib/query-keys";

/** Canonical topics accepted by outbound_webhooks.AllowedEvents. */
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
  "email.bounced",
  "email.complained",
  "email.delivered",
  "assurance.run.completed",
  "assurance.run.blocked",
] as const;

export type OutboundWebhookEvent = (typeof OUTBOUND_WEBHOOK_EVENTS)[number];

export const OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS = [
  "hmac_sha256",
  "ecdsa_p256",
  "ed25519",
] as const;

export type OutboundWebhookSigningAlgorithm =
  (typeof OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS)[number];

export type OutboundWebhookAuthType =
  | "none"
  | "bearer"
  | "headers"
  | "mtls"
  | "combined";

/** Write-only receiver credentials. Never echoed by any read. */
export interface OutboundWebhookAuthConfigInput {
  type?: OutboundWebhookAuthType;
  bearer_token?: string;
  headers?: Record<string, string>;
  mtls_cert_pem?: string;
  mtls_key_pem?: string;
}

/** Value-free receiver-auth projection returned by reads. */
export interface OutboundWebhookAuthMetadata {
  type?: string;
  bearer_configured?: boolean;
  header_names?: string[];
  mtls_configured?: boolean;
  secret_redacted?: boolean;
}

/** Output field name → RFC 6901 JSON Pointer into the event payload. */
export type OutboundWebhookTransformTemplate = Record<string, string>;

export interface OutboundWebhookRecord {
  id: string;
  tenant_id?: string;
  /** Display projection: the server hides path and query on reads. */
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  created_at?: string;
  updated_at?: string;
  config_version?: number;
  last_succeeded_at?: string | null;
  last_failed_at?: string | null;
  consecutive_failures?: number;
  disabled_reason?: string;
  disabled_at?: string | null;
  signing_algorithm?: string;
  signing_public_key?: string;
  secondary_public_key?: string;
  secondary_expires_at?: string | null;
  rotated_at?: string | null;
  list_id?: string;
  auth_config?: OutboundWebhookAuthMetadata;
  auth_config_status?: string;
  url_status?: string;
  filter_expression?: string;
  transform_template?: OutboundWebhookTransformTemplate;
  delivery_policy_status?: string;
}

export interface OutboundWebhookPage {
  webhooks: OutboundWebhookRecord[];
  /** Empty string when the server has no older page. */
  next_cursor: string;
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

/**
 * Create and rotate share this shape. `signing_secret` is present only for
 * hmac_sha256 and is returned ONCE; asymmetric algorithms return the public
 * key and keep the private half server-side.
 */
export interface OutboundWebhookCreateResponse {
  webhook: OutboundWebhookRecord;
  signing_secret?: string;
  public_key_pem?: string;
}

export interface OutboundWebhookUpdateInput {
  /** Omit to preserve the complete destination; reads only show a redaction. */
  url?: string;
  description?: string;
  events?: string[];
  active?: boolean;
  /** null (or type=none) clears credentials; omission preserves them. */
  auth_config?: OutboundWebhookAuthConfigInput | null;
  /** null clears the filter; omission preserves it. */
  filter_expression?: string | null;
  /** null clears the transform; omission preserves it. */
  transform_template?: OutboundWebhookTransformTemplate | null;
}

export interface OutboundWebhookDeleteResult {
  ok: boolean;
  deleted: boolean;
  deactivated: boolean;
}

export interface OutboundWebhookTestResult {
  webhook_id: string;
  status_code: number;
  signed: boolean;
  signature?: string;
  key_ids?: string;
  response: string;
  response_truncated?: boolean;
  error?: string;
  /** True when the delivery policy suppressed the receiver request. */
  filtered?: boolean;
  redaction_applied?: boolean;
}

const LIVE = { requireOnline: true, maxAttempts: 1 } as const;

export interface OutboundWebhookRequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function liveOptions(options: OutboundWebhookRequestOptions = {}) {
  return {
    ...LIVE,
    cache: "no-store" as const,
    signal: options.signal,
    idempotencyKey: options.idempotencyKey,
  };
}

/**
 * Keys composed on the shared `base` so every read carries the same
 * `[resource, tenantId, role, …]` scoping as the rest of the app. The routing
 * overview keeps its own `base("routing", …)` key for its summary list; the
 * client invalidates both after a mutation.
 */
export const outboundWebhookKeys = {
  all: (tenantId: string, role: RoleKey, principalKey = "unverified") =>
    [...base("outbound-webhooks", tenantId, role), principalKey] as const,
  /**
   * One entry per (server query, cursor page): the cursor is opaque and page
   * two of `query=a` is a different resource from page two of `query=b`, so it
   * belongs in the key rather than in component state layered over one entry.
   */
  list: (
    tenantId: string,
    role: RoleKey,
    query: string,
    cursor = "",
    principalKey = "unverified",
  ) =>
    [
      ...base("outbound-webhooks", tenantId, role),
      principalKey,
      "list",
      query,
      cursor,
    ] as const,
  /**
   * One destination's delivery history. The infinite query owns its cursor
   * pages, so the key stops at the destination id.
   */
  deliveries: (
    tenantId: string,
    role: RoleKey,
    webhookId: string,
    principalKey = "unverified",
  ) =>
    [
      ...base("outbound-webhooks", tenantId, role),
      principalKey,
      "deliveries",
      webhookId,
    ] as const,
  /** One destination's trailing 24-hour health aggregate. */
  health: (
    tenantId: string,
    role: RoleKey,
    webhookId: string,
    principalKey = "unverified",
  ) =>
    [
      ...base("outbound-webhooks", tenantId, role),
      principalKey,
      "health",
      webhookId,
    ] as const,
};

export interface ListOutboundWebhooksOptions {
  /** Server-side search over destination and events (`?query=`). */
  query?: string;
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
  /**
   * Page size. The server defaults to 50 and clamps to 200
   * (pagination.ReadParams), so a summary that wants the widest single page
   * asks for 200 and treats a non-empty `next_cursor` as "lower bound".
   */
  limit?: number;
  signal?: AbortSignal;
}

function optionalString(value: unknown, max = 16_384): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseTransform(
  value: unknown,
): OutboundWebhookTransformTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length > 128 ||
    entries.some(
      ([key, pointer]) =>
        !key ||
        key.length > 256 ||
        typeof pointer !== "string" ||
        pointer.length > 2_048,
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(entries) as OutboundWebhookTransformTemplate;
}

function parseAuthMetadata(
  value: unknown,
): OutboundWebhookAuthMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  const headerNames = Array.isArray(row.header_names)
    ? row.header_names.filter(
        (name): name is string =>
          typeof name === "string" && name.length > 0 && name.length <= 256,
      )
    : undefined;
  return {
    ...(optionalString(row.type, 64) !== undefined
      ? { type: optionalString(row.type, 64) }
      : {}),
    ...(typeof row.bearer_configured === "boolean"
      ? { bearer_configured: row.bearer_configured }
      : {}),
    ...(headerNames ? { header_names: headerNames.slice(0, 128) } : {}),
    ...(typeof row.mtls_configured === "boolean"
      ? { mtls_configured: row.mtls_configured }
      : {}),
    ...(typeof row.secret_redacted === "boolean"
      ? { secret_redacted: row.secret_redacted }
      : {}),
  };
}

export function parseOutboundWebhookRecord(
  value: unknown,
  expectedId?: string,
): OutboundWebhookRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "The service returned an invalid outbound destination record.",
    );
  }
  const row = value as Record<string, unknown>;
  const id = optionalString(row.id, 256)?.trim();
  const url = optionalString(row.url, 16_384);
  if (
    !id ||
    (expectedId !== undefined && id !== expectedId) ||
    !url ||
    typeof row.active !== "boolean" ||
    !Array.isArray(row.events) ||
    row.events.length > 256 ||
    row.events.some(
      (event) =>
        typeof event !== "string" || event.length === 0 || event.length > 256,
    )
  ) {
    throw new Error(
      expectedId
        ? "The service returned a destination record that did not match the requested destination."
        : "The service returned an invalid outbound destination record.",
    );
  }
  const authConfig = parseAuthMetadata(row.auth_config);
  const transformTemplate = parseTransform(row.transform_template);
  const record: OutboundWebhookRecord = {
    id,
    url,
    events: [...(row.events as string[])],
    active: row.active,
  };
  const stringFields = [
    "tenant_id",
    "description",
    "created_at",
    "updated_at",
    "disabled_reason",
    "signing_algorithm",
    "signing_public_key",
    "secondary_public_key",
    "list_id",
    "auth_config_status",
    "url_status",
    "filter_expression",
    "delivery_policy_status",
  ] as const;
  for (const field of stringFields) {
    const parsed = optionalString(row[field]);
    if (parsed !== undefined) record[field] = parsed;
  }
  const nullableStringFields = [
    "last_succeeded_at",
    "last_failed_at",
    "disabled_at",
    "secondary_expires_at",
    "rotated_at",
  ] as const;
  for (const field of nullableStringFields) {
    if (row[field] === null) record[field] = null;
    else {
      const parsed = optionalString(row[field]);
      if (parsed !== undefined) record[field] = parsed;
    }
  }
  const numericFields = ["config_version", "consecutive_failures"] as const;
  for (const field of numericFields) {
    const parsed = optionalNumber(row[field]);
    if (parsed !== undefined) record[field] = parsed;
  }
  if (authConfig) record.auth_config = authConfig;
  if (transformTemplate) record.transform_template = transformTemplate;
  return record;
}

function verifiedCreateResponse(
  value: unknown,
  expectedId?: string,
): OutboundWebhookCreateResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "The outbound-destination request may have completed, but its result could not be verified. Refresh before trying again.",
    );
  }
  const row = value as Record<string, unknown>;
  let webhook: OutboundWebhookRecord;
  try {
    webhook = parseOutboundWebhookRecord(row.webhook, expectedId);
  } catch {
    throw new Error(
      "The outbound-destination request may have completed, but its result could not be verified. Refresh before trying again.",
    );
  }
  const signingSecret = optionalString(row.signing_secret, 128 * 1024);
  const publicKey = optionalString(row.public_key_pem, 128 * 1024);
  if (
    (webhook.signing_algorithm === "hmac_sha256" && !signingSecret) ||
    (webhook.signing_algorithm !== "hmac_sha256" &&
      !publicKey &&
      !webhook.signing_public_key)
  ) {
    throw new Error(
      "The destination changed, but the service did not return verifiable one-time signing material. Do not retry blindly; refresh and rotate the destination key.",
    );
  }
  return {
    webhook,
    ...(signingSecret ? { signing_secret: signingSecret } : {}),
    ...(publicKey ? { public_key_pem: publicKey } : {}),
  };
}

/**
 * One page of destinations. The server reads `query` (not `q`) and answers
 * `{ webhooks, next_cursor }`; an empty cursor means the last page.
 */
export async function listOutboundWebhooksPage(
  opts: ListOutboundWebhooksOptions = {},
): Promise<OutboundWebhookPage> {
  const params = new URLSearchParams();
  const query = opts.query?.trim();
  if (query) params.set("query", query);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (
    typeof opts.limit === "number" &&
    Number.isInteger(opts.limit) &&
    opts.limit > 0
  ) {
    params.set("limit", String(Math.min(opts.limit, 200)));
  }
  const qs = params.toString();
  const res = await api.get<{ webhooks?: unknown; next_cursor?: unknown }>(
    `/api/v1/outbound-webhooks${qs ? `?${qs}` : ""}`,
    {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: opts.signal,
    },
  );
  if (!res || !Array.isArray(res.webhooks)) {
    throw new Error(
      "The service returned an invalid outbound destination list.",
    );
  }
  return {
    webhooks: res.webhooks.map((row) => parseOutboundWebhookRecord(row)),
    next_cursor: typeof res?.next_cursor === "string" ? res.next_cursor : "",
  };
}

export function createOutboundWebhook(
  input: OutboundWebhookCreateInput,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookCreateResponse> {
  return api
    .post<unknown>("/api/v1/outbound-webhooks", input, liveOptions(options))
    .then((response) => verifiedCreateResponse(response));
}

export function updateOutboundWebhook(
  id: string,
  patch: OutboundWebhookUpdateInput,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookRecord> {
  return api
    .patch<unknown>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
      patch,
      liveOptions(options),
    )
    .then((response) => parseOutboundWebhookRecord(response, id));
}

/** Pause: `?soft=true` deactivates the visible endpoint and keeps everything. */
export function pauseOutboundWebhook(
  id: string,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookDeleteResult> {
  return api
    .delete<unknown>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}?soft=true`,
      liveOptions(options),
    )
    .then((result) => verifiedDeleteResult(result, "pause"));
}

/** Tombstone: the endpoint disappears and its secrets are shredded. */
export function deleteOutboundWebhook(
  id: string,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookDeleteResult> {
  return api
    .delete<unknown>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
      liveOptions(options),
    )
    .then((result) => verifiedDeleteResult(result, "delete"));
}

function verifiedDeleteResult(
  value: unknown,
  expected: "pause" | "delete",
): OutboundWebhookDeleteResult {
  const row = value as Partial<OutboundWebhookDeleteResult> | null;
  if (
    !row ||
    row.ok !== true ||
    row.deleted !== (expected === "delete") ||
    row.deactivated !== (expected === "pause")
  ) {
    throw new Error(
      `The service did not confirm that the destination was ${expected === "pause" ? "paused" : "deleted"}. Refresh before trying again.`,
    );
  }
  return {
    ok: true,
    deleted: row.deleted,
    deactivated: row.deactivated,
  };
}

export function reEnableOutboundWebhook(
  id: string,
  options: OutboundWebhookRequestOptions = {},
): Promise<{ ok: true }> {
  return api
    .post<unknown>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/re-enable`,
      undefined,
      liveOptions(options),
    )
    .then((result) => {
      if (
        !result ||
        typeof result !== "object" ||
        (result as { ok?: unknown }).ok !== true
      ) {
        throw new Error(
          "The service did not confirm that the destination was resumed.",
        );
      }
      return { ok: true };
    });
}

/** Synthesises a `webhook.test` event and delivers it synchronously. */
export function testOutboundWebhook(
  id: string,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookTestResult> {
  return api
    .post<OutboundWebhookTestResult>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/test`,
      undefined,
      liveOptions(options),
    )
    .then((result) => {
      if (
        !result ||
        result.webhook_id !== id ||
        typeof result.status_code !== "number" ||
        !Number.isInteger(result.status_code) ||
        result.status_code < 0 ||
        result.status_code > 999 ||
        typeof result.signed !== "boolean" ||
        typeof result.response !== "string"
      ) {
        throw new Error("The service returned an invalid live-test receipt.");
      }
      return result;
    });
}

/**
 * Mints fresh signing material and dual-signs for the 24h grace window.
 * The returned HMAC secret is shown once.
 */
export function rotateOutboundWebhookSecret(
  id: string,
  options: OutboundWebhookRequestOptions = {},
): Promise<OutboundWebhookCreateResponse> {
  return api
    .post<unknown>(
      `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/rotate-secret`,
      undefined,
      liveOptions(options),
    )
    .then((response) => verifiedCreateResponse(response, id));
}

/* ---------- delivery history, replay, and health ---------- */

/** Server states for one `outbound_webhook_deliveries` row. */
export const OUTBOUND_WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "exhausted",
  "skipped",
] as const;

export type OutboundWebhookDeliveryStatus =
  (typeof OUTBOUND_WEBHOOK_DELIVERY_STATUSES)[number];

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

export interface OutboundWebhookDeliveryPage {
  deliveries: OutboundWebhookDelivery[];
  /** Empty string when the server has no older page. */
  next_cursor: string;
}

export interface OutboundWebhookReplayResult {
  /** The NEW pending delivery the replay cloned. */
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
  disabled_reason?: string;
  disabled_at?: string;
  last_succeeded_at?: string;
  last_failed_at?: string;
}

/** Desktop pages delivery history 50 rows at a time; the server caps at 200. */
export const OUTBOUND_WEBHOOK_DELIVERY_PAGE_SIZE = 50;

export interface ListOutboundWebhookDeliveriesOptions {
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

function readOptions(signal?: AbortSignal) {
  return {
    cache: "no-store" as const,
    requireOnline: true,
    maxAttempts: 1,
    signal,
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseOutboundWebhookDelivery(
  value: unknown,
  expectedWebhookId: string,
): OutboundWebhookDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The service returned an invalid delivery record.");
  }
  const row = value as Record<string, unknown>;
  const id = optionalString(row.id, 256)?.trim();
  const webhookId = optionalString(row.webhook_id, 256);
  const eventType = optionalString(row.event_type, 256);
  const attemptCount = nonNegativeInteger(row.attempt_count);
  const createdAt = optionalString(row.created_at, 64);
  const status = row.status;
  if (
    !id ||
    webhookId !== expectedWebhookId ||
    !eventType ||
    attemptCount === undefined ||
    !createdAt ||
    typeof status !== "string" ||
    !(OUTBOUND_WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(status)
  ) {
    throw new Error(
      "The service returned a delivery record that did not match the requested destination.",
    );
  }
  const delivery: OutboundWebhookDelivery = {
    id,
    webhook_id: webhookId,
    event_type: eventType,
    attempt_count: attemptCount,
    status: status as OutboundWebhookDeliveryStatus,
    created_at: createdAt,
  };
  const statusCode = nonNegativeInteger(row.last_status_code);
  if (statusCode !== undefined) delivery.last_status_code = statusCode;
  const optionalFields = [
    "next_attempt_at",
    "last_response_body_truncated",
    "last_error",
    "delivered_at",
  ] as const;
  for (const field of optionalFields) {
    const parsed = optionalString(row[field]);
    if (parsed) delivery[field] = parsed;
  }
  return delivery;
}

/**
 * One page of a destination's canonical delivery history, newest first.
 * The server answers `{ deliveries, next_cursor }`; an empty cursor means the
 * oldest page has been reached.
 */
export async function listOutboundWebhookDeliveries(
  id: string,
  opts: ListOutboundWebhookDeliveriesOptions = {},
): Promise<OutboundWebhookDeliveryPage> {
  const limit = Math.max(
    1,
    Math.min(
      200,
      Math.floor(opts.limit ?? OUTBOUND_WEBHOOK_DELIVERY_PAGE_SIZE),
    ),
  );
  const res = await api.get<{ deliveries?: unknown; next_cursor?: unknown }>(
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/deliveries`,
    {
      ...readOptions(opts.signal),
      query: { limit, cursor: opts.cursor || undefined },
    },
  );
  if (!res || !Array.isArray(res.deliveries)) {
    throw new Error("The service returned an invalid delivery history page.");
  }
  return {
    deliveries: res.deliveries.map((row) =>
      parseOutboundWebhookDelivery(row, id),
    ),
    next_cursor: typeof res.next_cursor === "string" ? res.next_cursor : "",
  };
}

export interface ReplayOutboundWebhookDeliveryOptions {
  /** Stable per logical replay; reuse it after an ambiguous failure. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

/**
 * Clones a completed delivery into a new pending row (202). The server
 * refuses a replay without an Idempotency-Key, so the caller owns one key per
 * logical replay and this call never lets the transport mint or retry.
 */
export function replayOutboundWebhookDelivery(
  deliveryId: string,
  options: ReplayOutboundWebhookDeliveryOptions,
): Promise<OutboundWebhookReplayResult> {
  return api
    .post<unknown>(
      `/api/v1/outbound-webhooks/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      undefined,
      liveOptions(options),
    )
    .then((value) => {
      const row =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const newId = optionalString(row?.delivery_id, 256);
      const replayedAt = optionalString(row?.replayed_at, 64);
      if (
        !row ||
        !newId ||
        row.replayed_from !== deliveryId ||
        row.status !== "pending" ||
        !replayedAt
      ) {
        throw new Error(
          "The replay may have been queued, but the service did not return a verifiable receipt. Refresh the history before replaying again.",
        );
      }
      return {
        delivery_id: newId,
        replayed_from: deliveryId,
        status: "pending",
        replayed_at: replayedAt,
      };
    });
}

function parseOutboundWebhookHealth(value: unknown): OutboundWebhookHealth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The service returned an invalid health summary.");
  }
  const row = value as Record<string, unknown>;
  const counts = [
    "deliveries_total",
    "deliveries_succeeded",
    "deliveries_failed",
    "deliveries_pending",
    "deliveries_skipped",
    "latency_p50_ms",
    "latency_p99_ms",
    "consecutive_failures",
  ] as const;
  const parsedCounts = {} as Record<(typeof counts)[number], number>;
  for (const field of counts) {
    const parsed = nonNegativeInteger(row[field]);
    if (parsed === undefined) {
      throw new Error("The service returned an invalid health summary.");
    }
    parsedCounts[field] = parsed;
  }
  if (typeof row.auto_disabled !== "boolean") {
    throw new Error("The service returned an invalid health summary.");
  }
  const breakdown: Record<string, number> = {};
  if (
    row.status_breakdown &&
    typeof row.status_breakdown === "object" &&
    !Array.isArray(row.status_breakdown)
  ) {
    for (const [status, count] of Object.entries(
      row.status_breakdown as Record<string, unknown>,
    ).slice(0, 64)) {
      const parsed = nonNegativeInteger(count);
      if (parsed !== undefined && status.length <= 16) {
        breakdown[status] = parsed;
      }
    }
  }
  const topErrors: OutboundWebhookHealthError[] = Array.isArray(row.top_errors)
    ? row.top_errors.slice(0, 16).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const statusCode = nonNegativeInteger(entry.status_code);
        const count = nonNegativeInteger(entry.count);
        const message = optionalString(entry.message, 4_096) ?? "";
        return statusCode === undefined || count === undefined
          ? []
          : [{ status_code: statusCode, message, count }];
      })
    : [];
  const health: OutboundWebhookHealth = {
    ...parsedCounts,
    status_breakdown: breakdown,
    top_errors: topErrors,
    auto_disabled: row.auto_disabled,
  };
  const optionalFields = [
    "disabled_reason",
    "disabled_at",
    "last_succeeded_at",
    "last_failed_at",
  ] as const;
  for (const field of optionalFields) {
    const parsed = optionalString(row[field], 256);
    if (parsed) health[field] = parsed;
  }
  return health;
}

/** Trailing 24-hour delivery aggregate for one destination. */
export async function getOutboundWebhookHealth(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<OutboundWebhookHealth> {
  const res = await api.get<unknown>(
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/health`,
    readOptions(opts.signal),
  );
  return parseOutboundWebhookHealth(res);
}

/**
 * Why a completed delivery cannot be replayed right now, or null when it can.
 * Mirrors the server's 409 classes for replay (webhook_inactive,
 * destination_unavailable, receiver_auth_unavailable,
 * delivery_configuration_invalid) so the control is withheld with the reason.
 */
export function outboundWebhookReplayBlock(
  webhook: OutboundWebhookRecord,
): string | null {
  if (!webhook.active) {
    return "Resume this destination before replaying deliveries.";
  }
  if (
    webhook.url_status === "legacy_pending" ||
    webhook.url_status === "invalid"
  ) {
    return "Replace the complete destination URL before replaying.";
  }
  if (
    webhook.auth_config_status === "legacy_pending" ||
    webhook.auth_config_status === "invalid"
  ) {
    return "Repair or clear receiver authentication before replaying.";
  }
  if (webhook.delivery_policy_status === "invalid") {
    return "Repair the event filter or payload transform before replaying.";
  }
  return null;
}

/**
 * The operator-actionable reason a destination cannot send or activate, or
 * null when it is ready. Mirrors the server's 409/503 classes so the control
 * is withheld with the reason instead of surprising the operator later.
 */
export function outboundWebhookSetupBlock(
  webhook: OutboundWebhookRecord,
): string | null {
  if (webhook.auth_config_status === "invalid") {
    return "Receiver authentication is invalid. Replace or clear it before sending or activating this destination.";
  }
  if (webhook.auth_config_status === "legacy_pending") {
    return "Receiver credentials are still being secured. Try again shortly.";
  }
  if (webhook.url_status === "invalid") {
    return "The destination URL is invalid. Replace it before sending or activating this destination.";
  }
  if (webhook.url_status === "legacy_pending") {
    return "The destination is still being secured. Try again shortly.";
  }
  if (webhook.delivery_policy_status === "invalid") {
    return "The delivery policy needs repair before sending or activating this destination.";
  }
  return null;
}
