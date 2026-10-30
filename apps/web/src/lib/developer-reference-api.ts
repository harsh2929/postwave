/**
 * lib/developer-reference-api.ts — webhook event catalogue, CDP transform
 * operations, merge-field schema and feed sources, plus the webhook simulator's
 * destination list, fire and receipt reconciliation (see the section below).
 *
 * Four reference paths desktop reached and no web file did.
 *
 * THE SAMPLE PAYLOADS ARE ILLUSTRATIONS, NOT A SCHEMA. They carry fixed
 * identifiers (`cmp_01HXYZ987654321`) and fixed dates. Presented as "the
 * payload", a reader builds a consumer against example values and treats
 * absent optional fields as impossible. The page labels them as examples.
 *
 * THE FIFTEEN EVENT TYPES ARE WHAT THIS BUILD EMITS, NOT WHAT THE PROTOCOL
 * ALLOWS. A consumer written against a closed list of fifteen breaks the day
 * a sixteenth ships. The page says so, because a catalogue rendered without
 * that caveat reads as exhaustive and permanent.
 */
import { api } from "@/lib/api";

export interface WebhookSampleEvent {
  event_type: string;
  sample_payload: Record<string, unknown>;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export async function getWebhookSampleEvents(): Promise<WebhookSampleEvent[]> {
  const r = await api.get<{ events?: unknown }>(
    "/api/v1/outbound-webhooks/playground/events",
  );
  return asArray<Record<string, unknown>>(r?.events).map((e) => ({
    event_type: str(e?.event_type),
    sample_payload: obj(e?.sample_payload),
  }));
}

export async function getTransformOps(): Promise<string[]> {
  const r = await api.get<{ ops?: unknown }>("/api/v1/cdp/transforms/ops");
  return asArray<string>(r?.ops);
}

export async function getMergeFieldSchema(): Promise<unknown[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/merge-fields/schema");
  return asArray(r?.items);
}

export async function listFeedSources(): Promise<unknown[]> {
  const r = await api.get<{ items?: unknown }>("/api/v1/feed-sources");
  return asArray(r?.items);
}

/** The top-level field names a sample payload demonstrates. */
export function sampleFields(e: WebhookSampleEvent): string[] {
  return Object.keys(e.sample_payload).sort();
}

/* ------------------------------------------------------------------ *
 * Webhook simulator (developer-reference/webhook-simulator).
 *
 * Desktop's WebhookSimulator reads the destination list, fires ONE real
 * signed POST through `/{id}/playground/fire`, and reconciles an unresolved
 * fire through `/playground/fires/{fire_id}`. Web reached none of them.
 *
 * EVERY call here is live-only: `requireOnline` refuses the offline outbox
 * and `maxAttempts: 1` refuses transport retries. A fire performs a real
 * receiver-side effect, and a replay after an ambiguous failure is exactly
 * the double delivery the fire identity exists to prevent. Recovery replays
 * are an explicit operator action that re-sends the SAME identity.
 * ------------------------------------------------------------------ */

/** Destinations requested per page (the server clamps to its own ceiling). */
export const SIMULATOR_TARGET_PAGE_SIZE = 200;

/** The server's canonical-JSON ceiling for a simulator payload. */
export const MAX_SIMULATOR_PAYLOAD_BYTES = 262_144;

export interface SimulatorTarget {
  id: string;
  /** Display projection: the server hides path and query on reads. */
  url: string;
  description: string;
  active: boolean;
  /** Optimistic revision the fire must name; null when the server omitted it. */
  config_version: number | null;
  signing_algorithm: string;
  url_status: string;
  auth_config_status: string;
  delivery_policy_status: string;
}

export interface SimulatorTargetPage {
  webhooks: SimulatorTarget[];
  /** Empty string when the server has no older page. */
  next_cursor: string;
}

function parseSimulatorTarget(value: unknown): SimulatorTarget | null {
  const row = obj(value);
  const id = str(row.id);
  if (!id || typeof row.active !== "boolean") return null;
  const version = row.config_version;
  return {
    id,
    url: str(row.url),
    description: str(row.description),
    active: row.active,
    config_version:
      typeof version === "number" && Number.isSafeInteger(version)
        ? version
        : null,
    signing_algorithm: str(row.signing_algorithm),
    url_status: str(row.url_status),
    auth_config_status: str(row.auth_config_status),
    delivery_policy_status: str(row.delivery_policy_status),
  };
}

/** GET /api/v1/outbound-webhooks — one keyset page of fire targets. */
export async function listSimulatorTargets(
  cursor = "",
  opts: { signal?: AbortSignal } = {},
): Promise<SimulatorTargetPage> {
  const r = await api.get<{ webhooks?: unknown; next_cursor?: unknown }>(
    "/api/v1/outbound-webhooks",
    {
      query: {
        limit: SIMULATOR_TARGET_PAGE_SIZE,
        cursor: cursor || undefined,
      },
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: opts.signal,
    },
  );
  if (!r || !Array.isArray(r.webhooks)) {
    throw new Error("The service returned an invalid webhook destination list.");
  }
  const webhooks: SimulatorTarget[] = [];
  for (const row of r.webhooks) {
    const parsed = parseSimulatorTarget(row);
    if (parsed) webhooks.push(parsed);
  }
  return { webhooks, next_cursor: str(r.next_cursor) };
}

/** The exact caller-known identity of one logical simulator fire. */
export interface PlaygroundFireRequest {
  fireId: string;
  idempotencyKey: string;
  webhookId: string;
  expectedWebhookConfigVersion: number;
  eventType: string;
  /** Exact JSON object text from the editor or recovery checkpoint. */
  payloadJSON: string;
}

/**
 * The request body, byte-for-byte deterministic from the identity.
 *
 * The payload text is embedded VERBATIM rather than re-serialised: the server
 * hashes the exact body under the Idempotency-Key, so a recovery replay that
 * re-stringified (rounding an integer above 2^53, reordering whitespace) would
 * be refused as a different request instead of returning the retained receipt.
 * Desktop's fireWebhookPlayground makes the same choice.
 */
export function playgroundFireBody(request: PlaygroundFireRequest): string {
  const metadata = JSON.stringify({
    fire_id: request.fireId,
    event_type: request.eventType,
    expected_webhook_config_version: request.expectedWebhookConfigVersion,
  });
  return `${metadata.slice(0, -1)},"payload":${request.payloadJSON}}`;
}

export type PlaygroundFireOutcome =
  | "receiver_responded"
  | "filtered"
  | "transport_ambiguous";

export interface PlaygroundFireResponse {
  fire_id: string;
  event_id: string;
  delivery_id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The signed request body as sent (credentials already redacted). */
  body: unknown;
  signature: string;
  requested_at: string;
  status_code: number;
  response_body: string;
  latency_ms: number;
  error: string;
  filtered: boolean;
  outcome: string;
  ambiguous: boolean;
  response_body_truncated: boolean;
}

/**
 * A trustworthy fire receipt, or null.
 *
 * Null is not "failed": it means the server answered 2xx with a body that does
 * not name THIS fire, so nothing on screen may claim the receiver outcome is
 * known. The caller fences the fire for reconciliation instead.
 */
export function parsePlaygroundFireResponse(
  value: unknown,
  expectedFireId: string,
): PlaygroundFireResponse | null {
  const row = obj(value);
  if (str(row.fire_id) !== expectedFireId) return null;
  if (typeof row.status_code !== "number" || typeof row.ambiguous !== "boolean")
    return null;
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(obj(row.headers))) {
    if (typeof headerValue === "string") headers[name] = headerValue;
  }
  return {
    fire_id: expectedFireId,
    event_id: str(row.event_id),
    delivery_id: str(row.delivery_id),
    url: str(row.url),
    method: str(row.method) || "POST",
    headers,
    body: row.body,
    signature: str(row.signature),
    requested_at: str(row.requested_at),
    status_code: row.status_code,
    response_body: str(row.response_body),
    latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : 0,
    error: str(row.error),
    filtered: row.filtered === true,
    outcome: str(row.outcome),
    ambiguous: row.ambiguous,
    response_body_truncated: row.response_body_truncated === true,
  };
}

/**
 * POST /api/v1/outbound-webhooks/{id}/playground/fire — ONE real signed POST.
 *
 * Rate-governed server-side (10/min per tenant, 2 concurrent): a 429 arrives
 * as an ApiError carrying the server's sentence, which the page renders
 * verbatim. Resolves to null when the 2xx body is not a receipt for this fire.
 */
export async function fireWebhookPlayground(
  request: PlaygroundFireRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<PlaygroundFireResponse | null> {
  const r = await api.postRaw<unknown>(
    `/api/v1/outbound-webhooks/${encodeURIComponent(request.webhookId)}/playground/fire`,
    playgroundFireBody(request),
    {
      headers: { "Content-Type": "application/json" },
      idempotencyKey: request.idempotencyKey,
      requireOnline: true,
      maxAttempts: 1,
      // The API's receiver client has a 10s deadline and then durably
      // completes its receipt; stay beyond both so a healthy slow handler is
      // not turned into a needless ambiguous outcome.
      timeoutMs: 20_000,
      cache: "no-store",
      signal: opts.signal,
    },
  );
  return parsePlaygroundFireResponse(r, request.fireId);
}

export interface PlaygroundFireReceipt {
  fire_id: string;
  webhook_id: string;
  event_type: string;
  delivery_id: string;
  /** pending | completed | ambiguous | receipt_expired */
  state: string;
  outcome: string;
  receiver_status_code: number | null;
  response_body_truncated: boolean;
  created_at: string;
  completed_at: string | null;
}

/**
 * GET /api/v1/outbound-webhooks/playground/fires/{fire_id} — reconcile a
 * retained identity WITHOUT contacting the receiver. A 404 is a point-in-time
 * absence (the original POST may still arrive), never permission to mint a
 * replacement identity.
 */
export async function getWebhookPlaygroundFire(
  fireId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PlaygroundFireReceipt> {
  const r = await api.get<unknown>(
    `/api/v1/outbound-webhooks/playground/fires/${encodeURIComponent(fireId)}`,
    {
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      signal: opts.signal,
    },
  );
  const row = obj(r);
  const status = row.receiver_status_code;
  return {
    fire_id: str(row.fire_id),
    webhook_id: str(row.webhook_id),
    event_type: str(row.event_type),
    delivery_id: str(row.delivery_id),
    state: str(row.state),
    outcome: str(row.outcome),
    receiver_status_code: typeof status === "number" ? status : null,
    response_body_truncated: row.response_body_truncated === true,
    created_at: str(row.created_at),
    completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

/* ------------------------------------------------------------------ *
 * Audience-field (merge-field) schema editing — parity row audience-44.
 *
 * Web could read the schema above and never change it; desktop has had
 * MergeFieldsSchemaModal. POST / PATCH / DELETE are ScopeWriteSubscribers, so
 * editors may use them as well as owners and admins — viewers may not.
 *
 * THE SCHEMA IS PRODUCTION DATA. Changing a field's type can invalidate stored
 * values and deleting a field destroys them, so the server refuses both while
 * `value_count > 0` and the editor mirrors that lock instead of letting the
 * request fail. The list read is fail-closed: a row that does not carry the
 * full contract, a duplicate key or a second tenant disables editing rather
 * than offering a PATCH against an ambiguous row.
 * ------------------------------------------------------------------ */

export const MERGE_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "address",
  "phone",
] as const;
export type MergeFieldType = (typeof MERGE_FIELD_TYPES)[number];

export const MERGE_FIELD_TYPE_COPY: Record<MergeFieldType, string> = {
  text: "Free-form text",
  number: "Numeric values",
  boolean: "True or false",
  date: "Calendar date",
  address: "Postal address",
  phone: "Phone number",
};

/** A new key as typed: letter first, ≤32 letters/digits/underscores. */
export const MERGE_FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const STORED_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
export const MERGE_FIELD_MAX_LABEL = 200;
export const MERGE_FIELD_MIN_POSITION = -1_000_000;
export const MERGE_FIELD_MAX_POSITION = 1_000_000;
const MERGE_FIELD_MAX_VALUE = 4096;

export interface MergeFieldSchemaRow {
  tenant_id: string;
  key: string;
  label: string;
  type: MergeFieldType;
  default_value: string;
  required: boolean;
  position: number;
  /** Subscribers holding a value. > 0 locks type changes and deletion. */
  value_count: number;
  created_at: string;
  updated_at: string;
}

export interface MergeFieldSchemaInput {
  key: string;
  label: string;
  type: MergeFieldType;
  default_value: string;
  required: boolean;
  position: number;
}

/** PATCH carries only what changed; an absent field is left untouched. */
export type MergeFieldSchemaPatch = Partial<
  Omit<MergeFieldSchemaInput, "key">
>;

export function isMergeFieldSchemaRow(
  value: unknown,
): value is MergeFieldSchemaRow {
  const row = obj(value);
  return (
    typeof row.tenant_id === "string" &&
    row.tenant_id.length > 0 &&
    typeof row.key === "string" &&
    STORED_KEY_PATTERN.test(row.key) &&
    typeof row.label === "string" &&
    typeof row.type === "string" &&
    (MERGE_FIELD_TYPES as readonly string[]).includes(row.type) &&
    typeof row.default_value === "string" &&
    typeof row.required === "boolean" &&
    Number.isSafeInteger(row.position) &&
    Number.isSafeInteger(row.value_count) &&
    (row.value_count as number) >= 0 &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

/**
 * The editable schema, or the reason editing is disabled. Accepts the raw
 * `items` the reference read above returns, so both share one fetch.
 */
export function parseMergeFieldSchemaRows(
  items: unknown,
): { rows: MergeFieldSchemaRow[] } | { error: string } {
  if (!Array.isArray(items) || !items.every(isMergeFieldSchemaRow)) {
    return {
      error:
        "The server returned an incomplete schema contract. Editing is disabled until the service is upgraded.",
    };
  }
  const keys = new Set(items.map((item) => item.key));
  const tenants = new Set(items.map((item) => item.tenant_id));
  if (keys.size !== items.length || tenants.size > 1) {
    return {
      error:
        "The server returned an ambiguous schema. Editing is disabled to prevent a cross-workspace or duplicate-key update.",
    };
  }
  return {
    rows: [...items].sort(
      (left, right) =>
        left.position - right.position ||
        left.created_at.localeCompare(right.created_at),
    ),
  };
}

export function validateMergeFieldPosition(value: number): string | null {
  if (!Number.isSafeInteger(value)) return "Enter a whole number.";
  if (value < MERGE_FIELD_MIN_POSITION || value > MERGE_FIELD_MAX_POSITION) {
    return `Use a value from ${MERGE_FIELD_MIN_POSITION.toLocaleString()} to ${MERGE_FIELD_MAX_POSITION.toLocaleString()}.`;
  }
  return null;
}

export function validateMergeFieldLabel(value: string): string | null {
  const label = value.trim();
  if (!label) return "A label is required.";
  if (Array.from(label).length > MERGE_FIELD_MAX_LABEL) {
    return `Use ${MERGE_FIELD_MAX_LABEL} characters or fewer.`;
  }
  return null;
}

/** A default must be a value the field's type could actually hold. */
export function validateMergeFieldDefault(
  type: MergeFieldType,
  value: string,
): string | null {
  const normalized = value.trim();
  if (Array.from(normalized).length > MERGE_FIELD_MAX_VALUE) {
    return `Use ${MERGE_FIELD_MAX_VALUE.toLocaleString()} characters or fewer.`;
  }
  if (!normalized) return null;
  if (type === "number" && !Number.isFinite(Number(normalized))) {
    return "Enter a valid number.";
  }
  if (type === "boolean" && normalized !== "true" && normalized !== "false") {
    return "Choose true or false.";
  }
  if (type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      return "Use a complete date in YYYY-MM-DD format.";
    }
    const [year, month, day] = normalized.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      year < 1 ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day
    ) {
      return "Enter a real calendar date.";
    }
  }
  return null;
}

function requireRow(value: unknown, key: string, verb: string) {
  if (!isMergeFieldSchemaRow(value) || value.key !== key) {
    throw new Error(
      `The audience-field service did not return the ${verb} field. Nothing changed locally; reload the schema.`,
    );
  }
  return value;
}

/** POST /api/v1/merge-fields/schema (ScopeWriteSubscribers). */
export async function createMergeField(
  input: MergeFieldSchemaInput,
): Promise<MergeFieldSchemaRow> {
  const key = input.key.trim().toUpperCase();
  const res = await api.post<unknown>(
    "/api/v1/merge-fields/schema",
    {
      key,
      label: input.label.trim(),
      type: input.type,
      default_value: input.default_value.trim(),
      required: input.required,
      position: input.position,
    },
    { requireOnline: true },
  );
  return requireRow(res, key, "created");
}

/** PATCH /api/v1/merge-fields/schema/{key} (ScopeWriteSubscribers). */
export async function patchMergeField(
  key: string,
  patch: MergeFieldSchemaPatch,
): Promise<MergeFieldSchemaRow> {
  const res = await api.patch<unknown>(
    `/api/v1/merge-fields/schema/${encodeURIComponent(key)}`,
    patch,
    { requireOnline: true },
  );
  return requireRow(res, key, "updated");
}

/**
 * DELETE /api/v1/merge-fields/schema/{key} (ScopeWriteSubscribers). The server
 * rechecks for stored values at delete time and refuses a field in use.
 */
export async function deleteMergeField(key: string): Promise<void> {
  const res = await api.delete<{ ok?: unknown }>(
    `/api/v1/merge-fields/schema/${encodeURIComponent(key)}`,
    { requireOnline: true },
  );
  if (res?.ok !== true) {
    throw new Error(
      "The service did not confirm removal. Nothing changed locally.",
    );
  }
}
