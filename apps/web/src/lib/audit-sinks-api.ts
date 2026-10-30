// SPDX-License-Identifier: AGPL-3.0-only
//
// audit-sinks-api.ts (SETA-056) — typed client for the audit streaming sinks
// and scheduled-export CRUD, already mounted server-side (auditsink/admin.go +
// handlers/audit_export_schedules.go). Reads need audit:read; every mutation
// needs audit:configure_sinks (enforced server-side). Interfaces use snake_case
// to match the Go JSON tags 1:1.

import { api } from "@/lib/api";

export type SinkKind =
  | "s3"
  | "datadog"
  | "splunk"
  | "http"
  | "archive"
  | "snowflake_shareback"
  | "otlp_logs";

export type OutputFormat = "postwave_native" | "ocsf_1_8";
export type WebhookFormat = "postwave_v1" | "standard_webhooks";
export type CircuitState = "closed" | "open" | "half_open";
export type ScheduleCadence = "weekly" | "monthly";

/** One audit sink row (GET). Credentials are write-only — never returned. */
export interface AuditSink {
  id: string;
  kind: SinkKind;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  output_format: OutputFormat;
  webhook_format: WebhookFormat;
  consecutive_failures: number;
  auto_disable_after: number;
  circuit_state: CircuitState;
  cooldown_until?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  /** Raw provider error text is discarded before it reaches rendering/cache. */
  has_last_error: boolean;
}

export interface CreateSinkInput {
  kind: SinkKind;
  name: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  output_format?: OutputFormat;
  webhook_format?: WebhookFormat;
}

// kind is intentionally NOT patchable (changing it invalidates cursor + DLQ —
// delete-and-recreate instead).
export interface PatchSinkInput {
  enabled?: boolean;
  name?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  output_format?: OutputFormat;
  webhook_format?: WebhookFormat;
}

/** Create returns a PARTIAL object (no secret echoed) — refetch for the full row. */
export interface CreateSinkResponse {
  id: string;
  kind: SinkKind;
  name: string;
  enabled: boolean;
  output_format: OutputFormat;
  webhook_format: WebhookFormat;
}

export interface PatchSinkResponse {
  id: string;
  enabled?: boolean;
  name?: string;
  credentials_rotated?: boolean;
  output_format?: OutputFormat;
  webhook_format?: WebhookFormat;
}

export interface AuditExportSchedule {
  id: string;
  cadence: ScheduleCadence;
  recipients: string[];
  filters?: Record<string, unknown>;
  enabled: boolean;
  created_by_email?: string;
  last_enqueued_at?: string | null;
  created_at: string;
}

export interface CreateExportScheduleInput {
  cadence: ScheduleCadence;
  recipients: string[];
  filters?: Record<string, unknown>;
}

/**
 * Per-kind form field roster: which config keys (non-secret) and credential
 * keys (secret, write-only) each sink kind expects. Mirrors the Go validators
 * so the form collects exactly the right inputs. `archive` and
 * `snowflake_shareback` use nested config the UI doesn't form-build yet, so
 * they carry no flat specs (advanced kinds).
 */
export const SINK_FIELD_SPECS: Record<
  SinkKind,
  { config: string[]; credentials: string[] }
> = {
  s3: {
    config: ["bucket", "region", "prefix"],
    credentials: ["aws_access_key_id", "aws_secret_access_key"],
  },
  datadog: { config: ["site"], credentials: ["api_key"] },
  splunk: { config: ["hec_url", "index"], credentials: ["token"] },
  http: { config: ["url"], credentials: ["bearer_token", "hmac_secret"] },
  otlp_logs: { config: ["endpoint"], credentials: [] },
  archive: { config: [], credentials: [] },
  snowflake_shareback: { config: [], credentials: [] },
};

const SINKS_BASE = "/api/v1/audit-sinks";
const SCHEDULES_BASE = "/api/v1/audit/export-schedules";
const WRITE_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;
type WriteOptions = { signal?: AbortSignal; idempotencyKey?: string | null };
const SINK_KIND_SET = new Set<SinkKind>(
  Object.keys(SINK_FIELD_SPECS) as SinkKind[],
);
const OUTPUT_FORMAT_SET = new Set<OutputFormat>([
  "postwave_native",
  "ocsf_1_8",
]);
const WEBHOOK_FORMAT_SET = new Set<WebhookFormat>([
  "postwave_v1",
  "standard_webhooks",
]);
const CIRCUIT_STATE_SET = new Set<CircuitState>([
  "closed",
  "open",
  "half_open",
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function invalid(label: string): never {
  throw new Error(`The server returned an invalid ${label} response.`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 512): string | null {
  if (typeof value !== "string" || value.length > max || CONTROL_RE.test(value))
    return null;
  return value.trim() || null;
}

function optionalInstant(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const candidate = text(value, 80);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function integer(value: unknown, min = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= min
    ? Number(value)
    : null;
}

function decodeSink(value: unknown): AuditSink | null {
  const row = record(value);
  if (!row) return null;
  const id = text(row.id, 128);
  const name = text(row.name, 256);
  const kind = SINK_KIND_SET.has(row.kind as SinkKind)
    ? (row.kind as SinkKind)
    : null;
  const output = OUTPUT_FORMAT_SET.has(row.output_format as OutputFormat)
    ? (row.output_format as OutputFormat)
    : null;
  const webhook = WEBHOOK_FORMAT_SET.has(row.webhook_format as WebhookFormat)
    ? (row.webhook_format as WebhookFormat)
    : null;
  const circuit = CIRCUIT_STATE_SET.has(row.circuit_state as CircuitState)
    ? (row.circuit_state as CircuitState)
    : null;
  const failures = integer(row.consecutive_failures);
  const autoDisable = integer(row.auto_disable_after, 1);
  const cooldown = optionalInstant(row.cooldown_until);
  const lastSuccess = optionalInstant(row.last_success_at);
  const lastFailure = optionalInstant(row.last_failure_at);
  const config = record(row.config);
  if (
    !id ||
    !name ||
    !kind ||
    typeof row.enabled !== "boolean" ||
    !config ||
    JSON.stringify(config).length > 65_536 ||
    !output ||
    !webhook ||
    failures === null ||
    autoDisable === null ||
    !circuit ||
    cooldown === null ||
    lastSuccess === null ||
    lastFailure === null ||
    (row.last_error !== undefined &&
      row.last_error !== null &&
      typeof row.last_error !== "string")
  )
    return null;
  return {
    id,
    kind,
    name,
    enabled: row.enabled,
    config,
    output_format: output,
    webhook_format: webhook,
    consecutive_failures: failures,
    auto_disable_after: autoDisable,
    circuit_state: circuit,
    ...(cooldown ? { cooldown_until: cooldown } : {}),
    ...(lastSuccess ? { last_success_at: lastSuccess } : {}),
    ...(lastFailure ? { last_failure_at: lastFailure } : {}),
    has_last_error:
      typeof row.last_error === "string" && row.last_error.length > 0,
  };
}

export async function listAuditSinks(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<{ sinks: AuditSink[] }> {
  const response = record(await api.get<unknown>(SINKS_BASE, opts));
  if (
    !response ||
    !Array.isArray(response.sinks) ||
    response.sinks.length > 1_000
  )
    return invalid("audit-sink inventory");
  const sinks = response.sinks.map(decodeSink);
  if (sinks.some((sink) => !sink)) return invalid("audit-sink inventory");
  return { sinks: sinks as AuditSink[] };
}

export async function createAuditSink(
  input: CreateSinkInput,
  options?: WriteOptions,
): Promise<CreateSinkResponse> {
  const response = record(
    await api.post<unknown>(SINKS_BASE, input, {
      ...options,
      ...WRITE_OPTIONS,
    }),
  );
  const id = response ? text(response.id, 128) : null;
  const expectedEnabled = input.enabled ?? true;
  const expectedOutput = input.output_format ?? "postwave_native";
  const expectedWebhook = input.webhook_format ?? "postwave_v1";
  if (
    !response ||
    !id ||
    response.kind !== input.kind ||
    response.name !== input.name ||
    response.enabled !== expectedEnabled ||
    response.output_format !== expectedOutput ||
    response.webhook_format !== expectedWebhook
  )
    return invalid("audit-sink creation receipt");
  return {
    id,
    kind: input.kind,
    name: input.name,
    enabled: expectedEnabled,
    output_format: expectedOutput,
    webhook_format: expectedWebhook,
  };
}

export async function testAuditSinkPreflight(
  input: CreateSinkInput,
  options?: WriteOptions,
): Promise<{ delivered: true; kind: SinkKind; action: "audit_sink.test" }> {
  const response = await api.post<unknown>(`${SINKS_BASE}/test`, input, {
    ...options,
    ...WRITE_OPTIONS,
    idempotencyKey: null,
  });
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    (response as Record<string, unknown>).delivered !== true ||
    (response as Record<string, unknown>).kind !== input.kind ||
    (response as Record<string, unknown>).action !== "audit_sink.test"
  ) {
    throw new Error("The server returned an invalid sink-test receipt.");
  }
  return { delivered: true, kind: input.kind, action: "audit_sink.test" };
}

export async function patchAuditSink(
  id: string,
  input: PatchSinkInput,
  options?: WriteOptions,
): Promise<PatchSinkResponse> {
  const response = record(
    await api.patch<unknown>(`${SINKS_BASE}/${encodeURIComponent(id)}`, input, {
      ...options,
      ...WRITE_OPTIONS,
    }),
  );
  if (
    !response ||
    response.id !== id ||
    (input.enabled !== undefined && response.enabled !== input.enabled) ||
    (input.name !== undefined && response.name !== input.name.trim()) ||
    (input.credentials !== undefined &&
      response.credentials_rotated !== true) ||
    (input.output_format !== undefined &&
      response.output_format !== input.output_format) ||
    (input.webhook_format !== undefined &&
      response.webhook_format !== input.webhook_format)
  )
    return invalid("audit-sink update receipt");
  return response as unknown as PatchSinkResponse;
}

export async function deleteAuditSink(
  id: string,
  options?: WriteOptions,
): Promise<{ deleted: boolean }> {
  const response = record(
    await api.delete<unknown>(`${SINKS_BASE}/${encodeURIComponent(id)}`, {
      ...options,
      ...WRITE_OPTIONS,
    }),
  );
  if (!response || response.deleted !== true)
    return invalid("audit-sink deletion receipt");
  return { deleted: true };
}

export function listExportSchedules(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<{ schedules: AuditExportSchedule[] }> {
  return api.get<{ schedules: AuditExportSchedule[] }>(SCHEDULES_BASE, opts);
}

export async function createExportSchedule(
  input: CreateExportScheduleInput,
  options?: WriteOptions,
): Promise<AuditExportSchedule> {
  const response = await api.post<AuditExportSchedule>(SCHEDULES_BASE, input, {
    ...options,
    ...WRITE_OPTIONS,
  });
  if (
    !response ||
    response.cadence !== input.cadence ||
    response.enabled !== true ||
    !Array.isArray(response.recipients) ||
    response.recipients.length !== input.recipients.length ||
    response.recipients.some(
      (recipient, index) => recipient !== input.recipients[index],
    ) ||
    !text(response.id, 128) ||
    !optionalInstant(response.created_at)
  )
    return invalid("audit export-schedule creation receipt");
  return response;
}

export async function deleteExportSchedule(
  id: string,
  options?: WriteOptions,
): Promise<{ deleted: boolean }> {
  const response = record(
    await api.delete<unknown>(`${SCHEDULES_BASE}/${encodeURIComponent(id)}`, {
      ...options,
      ...WRITE_OPTIONS,
    }),
  );
  if (!response || response.deleted !== true)
    return invalid("audit export-schedule deletion receipt");
  return { deleted: true };
}
