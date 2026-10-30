// SPDX-License-Identifier: AGPL-3.0-only

import { api, ApiError } from "@/lib/api";
import { isNeverTimestamp } from "@/lib/go-zero-time";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = ["snowflake", "bigquery", "redshift", "postgres"] as const;
const STORED_STATUSES = ["draft", "paused", "active", "error"] as const;
const EDITABLE_STATUSES = ["draft", "paused"] as const;
const MAX_CURSOR_BYTES = 4_096;
const MAX_EVENT_BYTES = 256;
const MAX_REASON_BYTES = 500;
const MAX_QUERY_BYTES = 128 * 1024;
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export type ZeroCopyProvider = (typeof PROVIDERS)[number];
export type ZeroCopyStoredStatus = (typeof STORED_STATUSES)[number];
export type ZeroCopyEditableStatus = (typeof EDITABLE_STATUSES)[number];
export type ZeroCopyStatusFilter = "all" | ZeroCopyStoredStatus;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AutomationRuntimeDescriptor {
  capability: string;
  runtimeStatus: string;
  executionEnabled: boolean;
  code: string;
  message: string;
  prerequisites: string[];
}

export interface ZeroCopyDraft {
  id: string;
  connectionId?: string;
  journeyId?: string;
  name: string;
  description: string;
  status: ZeroCopyStoredStatus;
  provider: ZeroCopyProvider;
  query: string;
  cursorColumn: string;
  profileKeyColumn: string;
  pollingIntervalSeconds: number;
  maxRowsPerTick: number;
  config: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  runtime: AutomationRuntimeDescriptor;
}

export interface ZeroCopyDraftInput {
  connection_id?: string;
  journey_id?: string;
  name: string;
  description?: string;
  status: ZeroCopyEditableStatus;
  provider: ZeroCopyProvider;
  query: string;
  cursor_column: string;
  profile_key_column: string;
  polling_interval_seconds: number;
  max_rows_per_tick: number;
  config: Record<string, JsonValue>;
}

export interface ZeroCopyDraftPage {
  items: ZeroCopyDraft[];
  nextCursor?: string;
}

export interface ZeroCopyValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  runtime: AutomationRuntimeDescriptor;
}

export interface ManualTriggerDelay {
  kind: "manual";
  subscriberId: string;
  eventName: string;
  optimalDelaySeconds: number;
  reason: string;
  computedAt: string;
  updatedAt: string;
}

export interface LearnedTriggerDelayHeld {
  kind: "learned-held";
  subscriberId: string;
  eventName: string;
  updatedAt: string;
}

export type TriggerDelayLookup =
  | ManualTriggerDelay
  | LearnedTriggerDelayHeld
  | null;

export class AutomationConfigurationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationConfigurationContractError";
  }
}

export class AutomationConfigurationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationConfigurationInputError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AutomationConfigurationContractError(
      `${label} returned an invalid response.`,
    );
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new AutomationConfigurationContractError(
      `${label} returned an invalid or oversized collection.`,
    );
  return value;
}

function text(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxBytes?: number } = {},
): string {
  if (typeof value !== "string")
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  if (!options.allowEmpty && !value.trim())
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  if (bytes(value) > (options.maxBytes ?? 4_096))
    throw new AutomationConfigurationContractError(
      `The service returned an oversized ${field}.`,
    );
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maxBytes = 4_096,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, { maxBytes });
}

function integer(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return Number(value);
}

function finite(value: unknown, field: string, min = 0, max = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return value;
}

function uuid(value: unknown, field: string): string {
  const normalized = text(value, field, { maxBytes: 36 }).toLowerCase();
  if (!UUID.test(normalized))
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return normalized;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return uuid(value, field);
}

function iso(value: unknown, field: string): string {
  const normalized = text(value, field, { maxBytes: 64 });
  if (!Number.isFinite(Date.parse(normalized)))
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return normalized;
}

function messages(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  return array(value, field, 100).map((item) =>
    text(item, field, { maxBytes: 1_024 }),
  );
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeRuntime(value: unknown): AutomationRuntimeDescriptor {
  const row = record(value, "Automation runtime descriptor");
  return {
    capability: text(row.capability, "runtime capability", { maxBytes: 128 }),
    runtimeStatus: text(row.runtime_status, "runtime status", { maxBytes: 64 }),
    executionEnabled: bool(row.execution_enabled, "runtime execution flag"),
    code: text(row.code, "runtime code", { maxBytes: 128 }),
    message: text(row.message, "runtime message", { maxBytes: 1_024 }),
    prerequisites: messages(row.prerequisites, "runtime prerequisite"),
  };
}

function sanitizeJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 1_000 || depth > 8)
    throw new AutomationConfigurationContractError(
      "The trigger config exceeded the safe structural limit.",
    );
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value === "string") {
    if (bytes(value) > 4_096)
      throw new AutomationConfigurationContractError(
        "The trigger config contains an oversized string.",
      );
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100)
      throw new AutomationConfigurationContractError(
        "The trigger config contains an oversized array.",
      );
    return value.map((item) => sanitizeJson(item, state, depth + 1));
  }
  const source = record(value, "Trigger config");
  const keys = Object.keys(source);
  if (keys.length > 100)
    throw new AutomationConfigurationContractError(
      "The trigger config contains too many keys.",
    );
  const out: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (
      !key ||
      bytes(key) > 128 ||
      /[\u0000-\u001f\u007f]/.test(key) ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      throw new AutomationConfigurationContractError(
        "The trigger config contains an unsafe key.",
      );
    out[key] = sanitizeJson(source[key], state, depth + 1);
  }
  return out;
}

export function parseTriggerConfig(value: unknown): Record<string, JsonValue> {
  const parsed = sanitizeJson(value ?? {}, { nodes: 0 });
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    throw new AutomationConfigurationContractError(
      "Trigger config must be a JSON object.",
    );
  return parsed;
}

function decodeDraft(
  value: unknown,
  expectedTenantId: string,
  expectedId?: string,
): ZeroCopyDraft {
  const row = record(value, "Zero-copy trigger definition");
  const tenantId = uuid(row.tenant_id, "trigger tenant identity");
  if (tenantId !== expectedTenantId.toLowerCase())
    throw new AutomationConfigurationContractError(
      "The trigger service returned a definition from another workspace.",
    );
  const id = uuid(row.id, "trigger identity");
  if (expectedId && id !== expectedId.toLowerCase())
    throw new AutomationConfigurationContractError(
      "The trigger service returned a mismatched definition.",
    );
  const status = text(row.status, "trigger status", { maxBytes: 16 });
  const provider = text(row.provider, "trigger provider", { maxBytes: 16 });
  if (!STORED_STATUSES.includes(status as ZeroCopyStoredStatus))
    throw new AutomationConfigurationContractError(
      "The trigger service returned an unsupported stored status.",
    );
  if (!PROVIDERS.includes(provider as ZeroCopyProvider))
    throw new AutomationConfigurationContractError(
      "The trigger service returned an unsupported provider.",
    );
  // Validate sensitive operational fields even though this draft-only client
  // deliberately does not retain or render them.
  optionalText(row.last_seen_cursor, "last-seen cursor", 4_096);
  optionalText(row.last_error, "last trigger error", 4_096);
  integer(row.consecutive_failures, "consecutive failures");
  integer(row.rows_fired_total, "rows fired total");
  if (row.last_polled_at !== undefined && row.last_polled_at !== null)
    iso(row.last_polled_at, "last poll time");
  if (row.last_success_at !== undefined && row.last_success_at !== null)
    iso(row.last_success_at, "last success time");
  return {
    id,
    ...(optionalUuid(row.connection_id, "connection identity")
      ? { connectionId: uuid(row.connection_id, "connection identity") }
      : {}),
    ...(optionalUuid(row.journey_id, "journey identity")
      ? { journeyId: uuid(row.journey_id, "journey identity") }
      : {}),
    name: text(row.name, "trigger name", { maxBytes: 200 }),
    description: text(row.description ?? "", "trigger description", {
      allowEmpty: true,
      maxBytes: 2_000,
    }),
    status: status as ZeroCopyStoredStatus,
    provider: provider as ZeroCopyProvider,
    query: text(row.query ?? "", "warehouse query", {
      allowEmpty: true,
      maxBytes: MAX_QUERY_BYTES,
    }),
    cursorColumn: text(row.cursor_column, "cursor column", { maxBytes: 128 }),
    profileKeyColumn: text(row.profile_key_column, "profile-key column", {
      maxBytes: 128,
    }),
    pollingIntervalSeconds: integer(
      row.polling_interval_seconds,
      "polling interval",
      15,
      86_400,
    ),
    maxRowsPerTick: integer(row.max_rows_per_tick, "row limit", 1, 1_000),
    config: parseTriggerConfig(row.config),
    createdAt: iso(row.created_at, "trigger creation time"),
    updatedAt: iso(row.updated_at, "trigger update time"),
    runtime: decodeRuntime(row.runtime),
  };
}

function validateStatusFilter(status: ZeroCopyStatusFilter): void {
  if (status !== "all" && !STORED_STATUSES.includes(status))
    throw new AutomationConfigurationInputError(
      "The trigger status filter is invalid.",
    );
}

function validateCursor(cursor?: string): void {
  if (
    cursor !== undefined &&
    (!cursor || bytes(cursor) > MAX_CURSOR_BYTES || /[\u0000-\u001f\u007f]/.test(cursor))
  )
    throw new AutomationConfigurationInputError(
      "The trigger pagination cursor is invalid.",
    );
}

function validateOperationKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value))
    throw new AutomationConfigurationInputError(
      "The operation identity is invalid.",
    );
}

export async function listZeroCopyDrafts(input: {
  tenantId: string;
  status?: ZeroCopyStatusFilter;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<ZeroCopyDraftPage> {
  const tenantId = input.tenantId.toLowerCase();
  if (!UUID.test(tenantId))
    throw new AutomationConfigurationInputError("The workspace identity is invalid.");
  const status = input.status ?? "all";
  validateStatusFilter(status);
  validateCursor(input.cursor);
  const root = record(
    await api.get<unknown>("/api/v1/zero-copy-triggers", {
      query: {
        limit: 100,
        status: status === "all" ? undefined : status,
        cursor: input.cursor,
      },
      signal: input.signal,
    }),
    "Zero-copy trigger catalogue",
  );
  const items = array(root.items, "Zero-copy trigger catalogue", 100).map(
    (item) => decodeDraft(item, tenantId),
  );
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new AutomationConfigurationContractError(
      "The trigger service returned duplicate definition identities.",
    );
  const nextCursor = optionalText(root.nextCursor, "trigger pagination cursor", MAX_CURSOR_BYTES);
  if (items.length === 0 && nextCursor)
    throw new AutomationConfigurationContractError(
      "The trigger service returned an empty page that cannot advance safely.",
    );
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

export async function getZeroCopyDraft(
  tenantId: string,
  id: string,
  signal?: AbortSignal,
): Promise<ZeroCopyDraft> {
  if (!UUID.test(tenantId) || !UUID.test(id))
    throw new AutomationConfigurationInputError(
      "The workspace or trigger identity is invalid.",
    );
  return decodeDraft(
    await api.get<unknown>(
      `/api/v1/zero-copy-triggers/${encodeURIComponent(id.toLowerCase())}`,
      { requireOnline: true, maxAttempts: 1, signal },
    ),
    tenantId.toLowerCase(),
    id,
  );
}

export function normalizeZeroCopyDraftInput(
  value: ZeroCopyDraftInput,
): ZeroCopyDraftInput {
  if (!EDITABLE_STATUSES.includes(value.status))
    throw new AutomationConfigurationInputError(
      "Only inert draft or paused definitions can be stored.",
    );
  if (!PROVIDERS.includes(value.provider))
    throw new AutomationConfigurationInputError("Choose a supported warehouse provider.");
  const name = value.name.trim();
  const description = value.description?.trim() ?? "";
  const query = value.query.trim();
  const cursorColumn = value.cursor_column.trim();
  const profileKeyColumn = value.profile_key_column.trim();
  if (!name || bytes(name) > 200)
    throw new AutomationConfigurationInputError("Name must use 1–200 bytes.");
  if (bytes(description) > 2_000)
    throw new AutomationConfigurationInputError("Description must use at most 2,000 bytes.");
  if (!query || bytes(query) > MAX_QUERY_BYTES)
    throw new AutomationConfigurationInputError(
      "A warehouse query of at most 128 KiB is required.",
    );
  if (!cursorColumn || bytes(cursorColumn) > 128)
    throw new AutomationConfigurationInputError(
      "Cursor column must use 1–128 bytes.",
    );
  if (!profileKeyColumn || bytes(profileKeyColumn) > 128)
    throw new AutomationConfigurationInputError(
      "Profile-key column must use 1–128 bytes.",
    );
  if (
    !Number.isSafeInteger(value.polling_interval_seconds) ||
    value.polling_interval_seconds < 15 ||
    value.polling_interval_seconds > 86_400
  )
    throw new AutomationConfigurationInputError(
      "Polling interval must be a whole number from 15 through 86,400 seconds.",
    );
  if (
    !Number.isSafeInteger(value.max_rows_per_tick) ||
    value.max_rows_per_tick < 1 ||
    value.max_rows_per_tick > 1_000
  )
    throw new AutomationConfigurationInputError(
      "Row limit must be a whole number from 1 through 1,000.",
    );
  const connectionId = value.connection_id?.trim().toLowerCase();
  const journeyId = value.journey_id?.trim().toLowerCase();
  if (connectionId && !UUID.test(connectionId))
    throw new AutomationConfigurationInputError(
      "Connection ID must be a canonical UUID.",
    );
  if (journeyId && !UUID.test(journeyId))
    throw new AutomationConfigurationInputError(
      "Journey ID must be a canonical UUID.",
    );
  return {
    ...(connectionId ? { connection_id: connectionId } : {}),
    ...(journeyId ? { journey_id: journeyId } : {}),
    name,
    ...(description ? { description } : {}),
    status: value.status,
    provider: value.provider,
    query,
    cursor_column: cursorColumn,
    profile_key_column: profileKeyColumn,
    polling_interval_seconds: value.polling_interval_seconds,
    max_rows_per_tick: value.max_rows_per_tick,
    config: parseTriggerConfig(value.config),
  };
}

export async function validateZeroCopyDraft(
  value: ZeroCopyDraftInput,
  signal?: AbortSignal,
): Promise<ZeroCopyValidation> {
  const input = normalizeZeroCopyDraftInput(value);
  const row = record(
    await api.post<unknown>("/api/v1/zero-copy-triggers/validate", input, {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: null,
      signal,
    }),
    "Zero-copy trigger validation",
  );
  const valid = bool(row.valid, "validation result");
  const errors = messages(row.errors, "validation error");
  const warnings = messages(row.warnings, "validation warning");
  if ((valid && errors.length > 0) || (!valid && errors.length === 0))
    throw new AutomationConfigurationContractError(
      "The trigger validator returned a contradictory result.",
    );
  return { valid, errors, warnings, runtime: decodeRuntime(row.runtime) };
}

export async function createZeroCopyDraft(input: {
  tenantId: string;
  value: ZeroCopyDraftInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ZeroCopyDraft> {
  if (!UUID.test(input.tenantId))
    throw new AutomationConfigurationInputError(
      "The workspace identity is invalid.",
    );
  validateOperationKey(input.idempotencyKey);
  return decodeDraft(
    await api.post<unknown>(
      "/api/v1/zero-copy-triggers",
      normalizeZeroCopyDraftInput(input.value),
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
    ),
    input.tenantId,
  );
}

export async function updateZeroCopyDraft(input: {
  tenantId: string;
  id: string;
  value: ZeroCopyDraftInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ZeroCopyDraft> {
  if (!UUID.test(input.tenantId) || !UUID.test(input.id))
    throw new AutomationConfigurationInputError(
      "The workspace or trigger identity is invalid.",
    );
  validateOperationKey(input.idempotencyKey);
  return decodeDraft(
    await api.put<unknown>(
      `/api/v1/zero-copy-triggers/${encodeURIComponent(input.id.toLowerCase())}`,
      normalizeZeroCopyDraftInput(input.value),
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
    ),
    input.tenantId,
    input.id,
  );
}

export async function deleteZeroCopyDraft(input: {
  id: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!UUID.test(input.id))
    throw new AutomationConfigurationInputError(
      "The trigger identity is invalid.",
    );
  validateOperationKey(input.idempotencyKey);
  await api.delete(
    `/api/v1/zero-copy-triggers/${encodeURIComponent(input.id.toLowerCase())}`,
    {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    },
  );
}

function normalizeDelayPair(subscriberId: string, eventName: string) {
  const id = subscriberId.trim().toLowerCase();
  const event = eventName.trim().toLowerCase();
  if (!UUID.test(id))
    throw new AutomationConfigurationInputError(
      "Subscriber ID must be a canonical UUID.",
    );
  if (!event || bytes(event) > MAX_EVENT_BYTES)
    throw new AutomationConfigurationInputError(
      "Event name must use 1–256 bytes.",
    );
  return { subscriberId: id, eventName: event };
}

function decodeDelay(
  value: unknown,
  expected: { subscriberId: string; eventName: string },
  requireManual: boolean,
): ManualTriggerDelay | LearnedTriggerDelayHeld {
  const row = record(value, "Trigger-delay preference");
  const subscriberId = uuid(row.subscriber_id, "delay subscriber identity");
  const eventName = text(row.event_name, "delay event name", {
    maxBytes: MAX_EVENT_BYTES,
  }).toLowerCase();
  if (
    subscriberId !== expected.subscriberId ||
    eventName !== expected.eventName
  )
    throw new AutomationConfigurationContractError(
      "The trigger-delay service returned a mismatched preference.",
    );
  const sampleCount = integer(row.sample_count, "delay sample count");
  const confidence = finite(row.confidence, "delay confidence");
  const optimalDelaySeconds = integer(
    row.optimal_delay_seconds,
    "manual delay",
    0,
    2_592_000,
  );
  const reason = text(row.reason ?? "", "manual delay reason", {
    allowEmpty: true,
    maxBytes: MAX_REASON_BYTES,
  });
  const computedAt = iso(row.computed_at, "manual delay computation time");
  const updatedAt = iso(row.updated_at, "delay update time");
  const learned = sampleCount > 0 || confidence > 0;
  if (requireManual && learned)
    throw new AutomationConfigurationContractError(
      "The manual override receipt was marked as learned timing.",
    );
  if (learned) return { kind: "learned-held", subscriberId, eventName, updatedAt };
  return {
    kind: "manual",
    subscriberId,
    eventName,
    optimalDelaySeconds,
    reason,
    computedAt,
    updatedAt,
  };
}

export async function getTriggerDelayPreference(input: {
  subscriberId: string;
  eventName: string;
  signal?: AbortSignal;
}): Promise<TriggerDelayLookup> {
  const pair = normalizeDelayPair(input.subscriberId, input.eventName);
  try {
    return decodeDelay(
      await api.get<unknown>("/api/v1/trigger-delay/preferences", {
        query: {
          subscriber_id: pair.subscriberId,
          event_name: pair.eventName,
        },
        requireOnline: true,
        maxAttempts: 1,
        signal: input.signal,
      }),
      pair,
      false,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function putTriggerDelayPreference(input: {
  subscriberId: string;
  eventName: string;
  optimalDelaySeconds: number;
  reason: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ManualTriggerDelay> {
  const pair = normalizeDelayPair(input.subscriberId, input.eventName);
  const reason = input.reason.trim();
  if (bytes(reason) > MAX_REASON_BYTES)
    throw new AutomationConfigurationInputError(
      "Manual timing reason must use at most 500 bytes.",
    );
  if (
    !Number.isSafeInteger(input.optimalDelaySeconds) ||
    input.optimalDelaySeconds < 0 ||
    input.optimalDelaySeconds > 2_592_000
  )
    throw new AutomationConfigurationInputError(
      "Manual delay must be a whole number from 0 through 2,592,000 seconds.",
    );
  validateOperationKey(input.idempotencyKey);
  const decoded = decodeDelay(
    await api.put<unknown>(
      "/api/v1/trigger-delay/preferences",
      {
        subscriber_id: pair.subscriberId,
        event_name: pair.eventName,
        optimal_delay_seconds: input.optimalDelaySeconds,
        ...(reason ? { reason } : {}),
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
    ),
    pair,
    true,
  );
  if (decoded.kind !== "manual")
    throw new AutomationConfigurationContractError(
      "The trigger-delay service did not return a manual override receipt.",
    );
  if (
    decoded.optimalDelaySeconds !== input.optimalDelaySeconds ||
    decoded.reason !== reason
  )
    throw new AutomationConfigurationContractError(
      "The trigger-delay receipt did not match the requested override.",
    );
  return decoded;
}

export function newAutomationOperationKey(prefix: string): string {
  const clean = prefix.trim().replace(/[^a-z0-9-]/gi, "-").slice(0, 48);
  const id = globalThis.crypto?.randomUUID?.();
  if (!clean || !id || !UUID.test(id))
    throw new AutomationConfigurationInputError(
      "A secure operation identity could not be generated.",
    );
  const key = `${clean}-${id}`;
  validateOperationKey(key);
  return key;
}

export function draftMatchesInput(
  draft: ZeroCopyDraft,
  value: ZeroCopyDraftInput,
): boolean {
  const input = normalizeZeroCopyDraftInput(value);
  return JSON.stringify({
    connection_id: draft.connectionId,
    journey_id: draft.journeyId,
    name: draft.name,
    description: draft.description || undefined,
    status: draft.status,
    provider: draft.provider,
    query: draft.query,
    cursor_column: draft.cursorColumn,
    profile_key_column: draft.profileKeyColumn,
    polling_interval_seconds: draft.pollingIntervalSeconds,
    max_rows_per_tick: draft.maxRowsPerTick,
    config: draft.config,
  }) === JSON.stringify(input);
}

// ---------------------------------------------------------------------------
// Read-only operational inspection.
//
// GET /api/v1/zero-copy-triggers/{id}/fires, /alerts, and /dlq are read-scoped
// reports. The server projects each row through a *View struct that carries
// PRESENCE FLAGS in place of raw cursor, profile-key, subscriber, payload, run,
// and error values; the decoders below rebuild every record from named fields
// so a widened server response can never carry a raw value into this browser.
// Anything not listed here is dropped, and the redaction is asserted by test.
//
// Poll-now, alert editing, and DLQ retry stay withheld behind the ZERO_COPY_*
// availability flags. None of them is exposed by this module.
// ---------------------------------------------------------------------------

const ERROR_CATEGORIES = ["execution_error"] as const;
const ALERT_KINDS = ["failures", "lag", "fires_burst"] as const;
const DLQ_REASONS = [
  "unresolved_subscriber",
  "enqueue_failed",
  "driver_partial_row",
] as const;
const DLQ_STATUSES = ["pending", "resolved", "abandoned"] as const;
/** The service returns the newest 100 rows and exposes no total or cursor. */
const MAX_INSPECTION_ROWS = 100;

export type ZeroCopyErrorCategory = (typeof ERROR_CATEGORIES)[number];
export type ZeroCopyAlertKind = (typeof ALERT_KINDS)[number];
export type ZeroCopyDLQReason = (typeof DLQ_REASONS)[number];
export type ZeroCopyDLQStatus = (typeof DLQ_STATUSES)[number];

export interface ZeroCopyFireRecord {
  id: number;
  triggerId: string;
  status: string;
  firedAt: string;
  hasCursor: boolean;
  hasProfileKey: boolean;
  hasSubscriber: boolean;
  hasPayload: boolean;
  hasFlowRun: boolean;
  errorCategory?: ZeroCopyErrorCategory;
}

export interface ZeroCopyAlertConfig {
  triggerId: string;
  runtime: AutomationRuntimeDescriptor;
  consecutiveFailuresThreshold: number;
  lagSecondsThreshold: number;
  firesPerTickThreshold: number;
  webhookConfigured: boolean;
  cooldownSeconds: number;
  lastAlertFiredAt?: string;
  lastAlertKind?: ZeroCopyAlertKind;
  hasLastAlertMessage: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ZeroCopyDLQEntry {
  id: number;
  triggerId: string;
  reason: ZeroCopyDLQReason;
  retryCount: number;
  lastRetriedAt?: string;
  status: ZeroCopyDLQStatus;
  createdAt: string;
  updatedAt: string;
  hasCursor: boolean;
  hasProfileKey: boolean;
  hasPayload: boolean;
  lastErrorCategory?: ZeroCopyErrorCategory;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new AutomationConfigurationContractError(
      `The service returned an invalid ${field}.`,
    );
  return value as T[number];
}

function optionalOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return oneOf(value, allowed, field);
}

/**
 * Optional wire timestamp. Go's `time.Time` is a struct, so `omitempty` does
 * NOT omit it: an unset alert or retry time arrives as `0001-01-01T00:00:00Z`,
 * which `Date.parse` happily accepts. Treat that as absent, not as a date.
 */
function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = iso(value, field);
  return isNeverTimestamp(normalized) ? undefined : normalized;
}

function triggerIdentity(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!UUID.test(normalized))
    throw new AutomationConfigurationInputError(
      "The trigger identity is invalid.",
    );
  return normalized;
}

function boundTriggerId(
  value: unknown,
  expectedId: string,
  field: string,
): string {
  const triggerId = uuid(value, field);
  if (triggerId !== expectedId)
    throw new AutomationConfigurationContractError(
      "The trigger service returned records for another definition.",
    );
  return triggerId;
}

function inspectionRows(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  const root = record(value, label);
  return array(root.items, label, MAX_INSPECTION_ROWS).map((item) =>
    record(item, label),
  );
}

function requireUniqueIds(items: { id: number }[], label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new AutomationConfigurationContractError(
      `The service returned duplicate ${label}.`,
    );
}

function decodeFire(
  row: Record<string, unknown>,
  expectedId: string,
): ZeroCopyFireRecord {
  const errorCategory = optionalOneOf(
    row.error_category,
    ERROR_CATEGORIES,
    "enqueue error category",
  );
  return {
    id: integer(row.id, "enqueue record identity", 1),
    triggerId: boundTriggerId(
      row.trigger_id,
      expectedId,
      "enqueue record trigger identity",
    ),
    status: text(row.status, "enqueue record status", { maxBytes: 64 }),
    firedAt: iso(row.fired_at, "enqueue record time"),
    hasCursor: bool(row.has_cursor, "enqueue cursor flag"),
    hasProfileKey: bool(row.has_profile_key, "enqueue profile-key flag"),
    hasSubscriber: bool(row.has_subscriber, "enqueue subscriber flag"),
    hasPayload: bool(row.has_payload, "enqueue payload flag"),
    hasFlowRun: bool(row.has_flow_run, "enqueue flow-run flag"),
    ...(errorCategory ? { errorCategory } : {}),
  };
}

function decodeDLQEntry(
  row: Record<string, unknown>,
  expectedId: string,
): ZeroCopyDLQEntry {
  const lastRetriedAt = optionalIso(row.last_retried_at, "recovery retry time");
  const lastErrorCategory = optionalOneOf(
    row.last_error_category,
    ERROR_CATEGORIES,
    "recovery error category",
  );
  return {
    id: integer(row.id, "recovery entry identity", 1),
    triggerId: boundTriggerId(
      row.trigger_id,
      expectedId,
      "recovery entry trigger identity",
    ),
    reason: oneOf(row.reason, DLQ_REASONS, "recovery reason"),
    retryCount: integer(row.retry_count, "recovery retry count"),
    status: oneOf(row.status, DLQ_STATUSES, "recovery status"),
    createdAt: iso(row.created_at, "recovery entry creation time"),
    updatedAt: iso(row.updated_at, "recovery entry update time"),
    hasCursor: bool(row.has_cursor, "recovery cursor flag"),
    hasProfileKey: bool(row.has_profile_key, "recovery profile-key flag"),
    hasPayload: bool(row.has_payload, "recovery payload flag"),
    ...(lastRetriedAt ? { lastRetriedAt } : {}),
    ...(lastErrorCategory ? { lastErrorCategory } : {}),
  };
}

/** GET /api/v1/zero-copy-triggers/{id}/fires — the newest 100 enqueue records. */
export async function listZeroCopyFires(
  id: string,
  signal?: AbortSignal,
): Promise<ZeroCopyFireRecord[]> {
  const triggerId = triggerIdentity(id);
  const items = inspectionRows(
    await api.get<unknown>(
      `/api/v1/zero-copy-triggers/${encodeURIComponent(triggerId)}/fires`,
      { signal },
    ),
    "Zero-copy enqueue records",
  ).map((row) => decodeFire(row, triggerId));
  requireUniqueIds(items, "enqueue record identities");
  return items;
}

/**
 * GET /api/v1/zero-copy-triggers/{id}/alerts — stored thresholds, or the
 * server's effective defaults when nothing has been written. The service may
 * answer 503 `alerts_disabled`; that ApiError is passed through so the caller
 * renders the server's own sentence.
 */
export async function getZeroCopyAlerts(
  id: string,
  signal?: AbortSignal,
): Promise<ZeroCopyAlertConfig> {
  const triggerId = triggerIdentity(id);
  const row = record(
    await api.get<unknown>(
      `/api/v1/zero-copy-triggers/${encodeURIComponent(triggerId)}/alerts`,
      { signal },
    ),
    "Zero-copy alert configuration",
  );
  const lastAlertFiredAt = optionalIso(row.last_alert_fired_at, "last alert time");
  const lastAlertKind = optionalOneOf(
    row.last_alert_kind,
    ALERT_KINDS,
    "last alert kind",
  );
  const createdAt = optionalIso(
    row.created_at,
    "alert configuration creation time",
  );
  const updatedAt = optionalIso(row.updated_at, "alert configuration update time");
  return {
    triggerId: boundTriggerId(
      row.trigger_id,
      triggerId,
      "alert configuration trigger identity",
    ),
    runtime: decodeRuntime(row.runtime),
    consecutiveFailuresThreshold: integer(
      row.consecutive_failures_threshold,
      "failure threshold",
    ),
    lagSecondsThreshold: integer(row.lag_seconds_threshold, "lag threshold"),
    firesPerTickThreshold: integer(
      row.fires_per_tick_threshold,
      "rows-per-poll threshold",
    ),
    webhookConfigured: bool(row.webhook_configured, "webhook flag"),
    cooldownSeconds: integer(row.cooldown_seconds, "alert cooldown"),
    hasLastAlertMessage: bool(row.has_last_alert_message, "alert message flag"),
    ...(lastAlertFiredAt ? { lastAlertFiredAt } : {}),
    ...(lastAlertKind ? { lastAlertKind } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/**
 * GET /api/v1/zero-copy-triggers/{id}/dlq — dead-letter entries for one
 * trigger. The service may answer 503 `dlq_disabled`; passed through as above.
 */
export async function listZeroCopyDLQ(
  id: string,
  signal?: AbortSignal,
): Promise<ZeroCopyDLQEntry[]> {
  const triggerId = triggerIdentity(id);
  const items = inspectionRows(
    await api.get<unknown>(
      `/api/v1/zero-copy-triggers/${encodeURIComponent(triggerId)}/dlq`,
      { signal },
    ),
    "Zero-copy recovery records",
  ).map((row) => decodeDLQEntry(row, triggerId));
  requireUniqueIds(items, "recovery entry identities");
  return items;
}
