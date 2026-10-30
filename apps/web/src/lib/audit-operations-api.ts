// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fail-closed clients for the operator-facing audit surfaces.
 *
 * Audit delivery responses cross a particularly sensitive trust boundary:
 * sink errors can contain upstream text and alert channel_config can contain
 * credentials.  Decoders below retain only fields the web UI can safely use.
 * Mutation calls are online-only and single-attempt; replaying them from the
 * offline outbox or automatically retrying them could duplicate deliveries.
 */
import { api } from "@/lib/api";

export const AUDIT_SCOPES = [
  "audit:read",
  "audit:read_pii",
  "audit:read_all_tenants",
  "audit:configure_sinks",
  "audit:configure_retention",
  "audit:execute_actions",
] as const;

export type AuditScope = (typeof AUDIT_SCOPES)[number];

export interface AuditAuthority {
  scopes: string[];
  auditScopes: AuditScope[];
  isAdmin: boolean;
}

export type RecoverySinkKind =
  | "s3"
  | "datadog"
  | "splunk"
  | "http"
  | "archive"
  | "snowflake_shareback"
  | "otlp_logs";
export type RecoveryCircuitState = "closed" | "open" | "half_open";

export interface RecoverySink {
  id: string;
  kind: RecoverySinkKind;
  name: string;
  enabled: boolean;
  outputFormat: "postwave_native" | "ocsf_1_8";
  webhookFormat: "postwave_v1" | "standard_webhooks";
  consecutiveFailures: number;
  autoDisableAfter: number;
  circuitState: RecoveryCircuitState;
  cooldownUntil?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  /** Only a boolean crosses into rendering; upstream error text may echo secrets. */
  hasLastError: boolean;
}

export interface AuditDLQEntry {
  id: number;
  sinkId: string;
  fromAuditId: number;
  toAuditId: number;
  attemptCount: number;
  firstFailedAt: string;
  lastAttemptAt: string;
  /** Error text is intentionally discarded at the trust boundary. */
  hasLastError: boolean;
}

export interface AuditSinkProbeReceipt {
  delivered: true;
  kind: RecoverySinkKind;
  action: "audit_sink.test";
}

export interface AuditDLQReplayReceipt {
  replayed: true;
  rows: number;
  note?: string;
}

export interface AuditDLQBulkEntryReceipt {
  id: number;
  status: "ok" | "failed" | "skipped" | "not_found";
  rows: number;
  /** Safe summary only; raw upstream error text is never retained. */
  hasError: boolean;
}

export interface AuditDLQBulkReceipt {
  replayed: number;
  failed: number;
  skipped: number;
  entries: AuditDLQBulkEntryReceipt[];
}

export interface AuditSinkSigningKey {
  id: string;
  kid: string;
  alg: "HS256";
  rotatedAt: string;
  revokedAt?: string;
  status: "active" | "revoked";
}

export type AuditReplayStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface AuditReplayJob {
  id: string;
  tenantId: string;
  sinkId: string;
  fromAuditId: number;
  toAuditId: number;
  status: AuditReplayStatus;
  rowsSent: number;
  rowsFailed: number;
  nextCursorId?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  createdBy?: string;
  hasLastError: boolean;
}

export interface AuditReplayCreateReceipt {
  jobId: string;
  status: "pending";
  createdAt: string;
  fromId: number;
  toId: number;
}

export type AuditAlertOperatorKind =
  | "glob"
  | "threshold_window"
  | "rate_deviation"
  | "outlier";
export type AuditAlertChannelKind =
  | "email"
  | "slack"
  | "webhook"
  | "servicenow"
  | "jira"
  | "pagerduty";

export interface AuditAlertRule {
  id: string;
  name: string;
  enabled: boolean;
  actionGlob: string;
  actorType?: string;
  actorLabelGlob?: string;
  resourceType?: string;
  operatorKind: AuditAlertOperatorKind;
  channelKind: AuditAlertChannelKind;
  notifySlack: boolean;
  firedCount: number;
  lastFiredAt?: string;
  createdAt: string;
  /** Raw channel_config and last_error are deliberately absent. */
  hasDeliveryError: boolean;
}

export interface AuditAlertRuleInput {
  name: string;
  action_glob: string;
  actor_type?: string;
  actor_label_glob?: string;
  resource_type?: string;
  operator_kind?: AuditAlertOperatorKind;
  operator_config?: Record<string, unknown>;
  channel_kind: AuditAlertChannelKind;
  channel_config: Record<string, unknown>;
  notify_slack?: boolean;
}

export interface AuditAlertFire {
  id: number;
  auditId: number;
  delivered: boolean;
  firedAt: string;
  hasDeliveryError: boolean;
}

export interface AuditAlertIncident {
  id: number;
  ruleId: string;
  auditId?: number;
  externalSystem: "servicenow" | "jira" | "pagerduty";
  externalIncidentId: string;
  status?: string;
  /** Only validated HTTPS destinations are retained as links. */
  url?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditStats {
  totalEvents: number;
  byActorType: Array<{ label: string; count: number }>;
  topActions: Array<{ label: string; count: number }>;
  daily: Array<{ date: string; count: number }>;
}

export interface AuditCheckpoint {
  checkpointId: number;
  treeSize: number;
  uptoAuditId: number;
  rootHash: string;
  rootSignature?: string;
  rootKid?: string;
  anchoredAt: string;
}

export interface AuditInclusionProof {
  leafId: number;
  leafHash: string;
  auditPath: string[];
  treeSize: number;
  rootHash: string;
  rootSignature?: string;
  rootKid?: string;
  anchoredAt: string;
}

export interface AuditExportManifest {
  exportId: string;
  fromAuditId: number;
  toAuditId: number;
  rowCount: number;
  treeSize: number;
  rootHash: string;
  signatureKid?: string;
  hasSignature: boolean;
  createdAt: string;
}

export type AuditExportJobStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export interface AuditExportJob {
  id: string;
  status: AuditExportJobStatus;
  estimatedRows?: number;
  exportedRows: number;
  totalBytes: number;
  emailOnComplete: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  etaSeconds?: number;
  /** Provider/worker detail is discarded at the decode boundary. */
  hasError: boolean;
}

export interface AuditExportJobInput {
  actorType?: string;
  actorLabel?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
  emailOnComplete?: boolean;
  emailAddress?: string;
}

const SINK_KINDS = new Set<RecoverySinkKind>([
  "s3",
  "datadog",
  "splunk",
  "http",
  "archive",
  "snowflake_shareback",
  "otlp_logs",
]);
const CIRCUIT_STATES = new Set<RecoveryCircuitState>([
  "closed",
  "open",
  "half_open",
]);
const REPLAY_STATUSES = new Set<AuditReplayStatus>([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
const OPERATOR_KINDS = new Set<AuditAlertOperatorKind>([
  "glob",
  "threshold_window",
  "rate_deviation",
  "outlier",
]);
const CHANNEL_KINDS = new Set<AuditAlertChannelKind>([
  "email",
  "slack",
  "webhook",
  "servicenow",
  "jira",
  "pagerduty",
]);
const EXPORT_JOB_STATUSES = new Set<AuditExportJobStatus>([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);
const AUDIT_SCOPE_SET = new Set<string>(AUDIT_SCOPES);
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const HEX_RE = /^[0-9a-f]+$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}$/u;
const WRITE_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;
export interface AuditMutationOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}
const writeOptions = (options: AuditMutationOptions = {}) => ({
  ...WRITE_OPTIONS,
  signal: options.signal,
  idempotencyKey: options.idempotencyKey,
});

function invalid(label: string): never {
  throw new Error(`The server returned an invalid ${label} response.`);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function textValue(
  value: unknown,
  max = 512,
  allowEmpty = false,
): string | null {
  if (
    typeof value !== "string" ||
    value.length > max ||
    CONTROL_RE.test(value)
  ) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || allowEmpty ? trimmed : null;
}

function optionalText(value: unknown, max = 512): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return textValue(value, max);
}

function safeInteger(value: unknown, min = 0): number | null {
  return Number.isSafeInteger(value) && Number(value) >= min
    ? Number(value)
    : null;
}

function instant(value: unknown): string | null {
  const candidate = textValue(value, 80);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function optionalInstant(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return instant(value);
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
): T | null {
  return typeof value === "string" && values.has(value as T)
    ? (value as T)
    : null;
}

function decodeAuthority(value: unknown): AuditAuthority | null {
  const row = object(value);
  if (!row || !hasOnly(row, ["scopes", "auditScopes", "isAdmin"])) return null;
  if (!Array.isArray(row.scopes) || !Array.isArray(row.auditScopes))
    return null;
  if (row.scopes.length > 512 || row.auditScopes.length > AUDIT_SCOPES.length) {
    return null;
  }
  const scopes = row.scopes.map((scope) => textValue(scope, 128));
  const auditScopes = row.auditScopes.map((scope) => textValue(scope, 128));
  if (scopes.some((scope) => !scope) || auditScopes.some((scope) => !scope)) {
    return null;
  }
  const concreteScopes = scopes as string[];
  const concreteAudit = auditScopes as string[];
  if (
    new Set(concreteScopes).size !== concreteScopes.length ||
    new Set(concreteAudit).size !== concreteAudit.length ||
    concreteAudit.some(
      (scope) => !AUDIT_SCOPE_SET.has(scope) || !concreteScopes.includes(scope),
    ) ||
    concreteScopes.some(
      (scope) => scope.startsWith("audit:") && !concreteAudit.includes(scope),
    ) ||
    typeof row.isAdmin !== "boolean"
  ) {
    return null;
  }
  return {
    scopes: concreteScopes,
    auditScopes: concreteAudit as AuditScope[],
    isAdmin: row.isAdmin,
  };
}

export async function getAuditAuthority(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<AuditAuthority> {
  const response = await api.get<unknown>("/api/v1/audit/my-scopes", opts);
  return decodeAuthority(response) ?? invalid("audit-authority");
}

function decodeSink(value: unknown): RecoverySink | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, [
      "id",
      "kind",
      "name",
      "enabled",
      "config",
      "output_format",
      "webhook_format",
      "consecutive_failures",
      "auto_disable_after",
      "circuit_state",
      "cooldown_until",
      "last_success_at",
      "last_failure_at",
      "last_error",
    ])
  )
    return null;
  const id = textValue(row.id, 128);
  const kind = enumValue(row.kind, SINK_KINDS);
  const name = textValue(row.name, 256);
  const consecutiveFailures = safeInteger(row.consecutive_failures);
  const autoDisableAfter = safeInteger(row.auto_disable_after, 1);
  const circuitState = enumValue(row.circuit_state, CIRCUIT_STATES);
  const cooldownUntil = optionalInstant(row.cooldown_until);
  const lastSuccessAt = optionalInstant(row.last_success_at);
  const lastFailureAt = optionalInstant(row.last_failure_at);
  if (
    !id ||
    !kind ||
    !name ||
    typeof row.enabled !== "boolean" ||
    !object(row.config) ||
    (row.output_format !== "postwave_native" &&
      row.output_format !== "ocsf_1_8") ||
    (row.webhook_format !== "postwave_v1" &&
      row.webhook_format !== "standard_webhooks") ||
    consecutiveFailures === null ||
    autoDisableAfter === null ||
    !circuitState ||
    cooldownUntil === null ||
    lastSuccessAt === null ||
    lastFailureAt === null ||
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
    outputFormat: row.output_format,
    webhookFormat: row.webhook_format,
    consecutiveFailures,
    autoDisableAfter,
    circuitState,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(lastSuccessAt ? { lastSuccessAt } : {}),
    ...(lastFailureAt ? { lastFailureAt } : {}),
    hasLastError:
      typeof row.last_error === "string" && row.last_error.length > 0,
  };
}

export async function listRecoverySinks(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<RecoverySink[]> {
  const response = object(await api.get<unknown>("/api/v1/audit-sinks", opts));
  if (
    !response ||
    !hasOnly(response, ["sinks"]) ||
    !Array.isArray(response.sinks) ||
    response.sinks.length > 1_000
  ) {
    return invalid("audit-sinks inventory");
  }
  const sinks = response.sinks.map(decodeSink);
  if (sinks.some((sink) => !sink)) return invalid("audit-sinks inventory");
  const concrete = sinks as RecoverySink[];
  if (new Set(concrete.map((sink) => sink.id)).size !== concrete.length) {
    return invalid("audit-sinks inventory");
  }
  return concrete;
}

function decodeDLQEntry(value: unknown): AuditDLQEntry | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, [
      "id",
      "sink_id",
      "from_audit_id",
      "to_audit_id",
      "last_error",
      "attempt_count",
      "first_failed_at",
      "last_attempt_at",
      "replayed_at",
      "replayed_by",
    ])
  )
    return null;
  const id = safeInteger(row.id, 1);
  const sinkId = textValue(row.sink_id, 128);
  const fromAuditId = safeInteger(row.from_audit_id);
  const toAuditId = safeInteger(row.to_audit_id);
  const attemptCount = safeInteger(row.attempt_count);
  const firstFailedAt = instant(row.first_failed_at);
  const lastAttemptAt = instant(row.last_attempt_at);
  if (
    id === null ||
    !sinkId ||
    fromAuditId === null ||
    toAuditId === null ||
    fromAuditId > toAuditId ||
    attemptCount === null ||
    !firstFailedAt ||
    !lastAttemptAt ||
    typeof row.last_error !== "string"
  )
    return null;
  return {
    id,
    sinkId,
    fromAuditId,
    toAuditId,
    attemptCount,
    firstFailedAt,
    lastAttemptAt,
    hasLastError: row.last_error.length > 0,
  };
}

export async function listAuditSinkDLQ(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<AuditDLQEntry[]> {
  const response = object(
    await api.get<unknown>("/api/v1/audit-sinks/dlq", opts),
  );
  if (
    !response ||
    !hasOnly(response, ["entries", "count"]) ||
    !Array.isArray(response.entries) ||
    response.entries.length > 1_000 ||
    safeInteger(response.count) !== response.entries.length
  )
    return invalid("audit-sink DLQ");
  const entries = response.entries.map(decodeDLQEntry);
  if (entries.some((entry) => !entry)) return invalid("audit-sink DLQ");
  return entries as AuditDLQEntry[];
}

function decodeProbe(value: unknown): AuditSinkProbeReceipt | null {
  const row = object(value);
  const kind = row ? enumValue(row.kind, SINK_KINDS) : null;
  return row &&
    hasOnly(row, ["delivered", "kind", "action"]) &&
    row.delivered === true &&
    kind &&
    row.action === "audit_sink.test"
    ? { delivered: true, kind, action: "audit_sink.test" }
    : null;
}

export async function testExistingAuditSink(
  id: string,
  options: AuditMutationOptions = {},
): Promise<AuditSinkProbeReceipt> {
  const response = await api.post<unknown>(
    `/api/v1/audit-sinks/${encodeURIComponent(requireID(id, "sink"))}/test`,
    {},
    writeOptions(options),
  );
  return decodeProbe(response) ?? invalid("audit-sink test receipt");
}

export async function setRecoverySinkEnabled(
  id: string,
  enabled: boolean,
  options: AuditMutationOptions = {},
): Promise<void> {
  const response = object(
    await api.patch<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(requireID(id, "sink"))}`,
      { enabled },
      writeOptions(options),
    ),
  );
  if (
    !response ||
    textValue(response.id, 128) !== id ||
    response.enabled !== enabled
  )
    invalid("audit-sink state receipt");
}

export async function resetAuditSinkCircuit(id: string, options: AuditMutationOptions = {}): Promise<void> {
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(requireID(id, "sink"))}/circuit/reset`,
      {},
      writeOptions(options),
    ),
  );
  if (!response || !hasOnly(response, ["reset"]) || response.reset !== true)
    invalid("circuit-reset receipt");
}

export async function replayAuditSinkDLQEntry(
  id: number,
  options: AuditMutationOptions = {},
): Promise<AuditDLQReplayReceipt> {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("A positive DLQ entry id is required.");
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-sinks/dlq/${encodeURIComponent(String(id))}/replay`,
      {},
      writeOptions(options),
    ),
  );
  const rows = response ? safeInteger(response.rows) : null;
  const note = response ? optionalText(response.note, 512) : null;
  if (
    !response ||
    !hasOnly(response, ["replayed", "rows", "note"]) ||
    response.replayed !== true ||
    rows === null ||
    note === null
  )
    return invalid("DLQ replay receipt");
  return { replayed: true, rows, ...(note ? { note } : {}) };
}

export async function replayAuditSinkDLQBulk(
  ids: number[],
  options: AuditMutationOptions = {},
): Promise<AuditDLQBulkReceipt> {
  const unique = [...new Set(ids)];
  if (
    unique.length < 1 ||
    unique.length > 500 ||
    unique.some((id) => !Number.isSafeInteger(id) || id < 1)
  )
    throw new Error("Select between 1 and 500 valid DLQ entries.");
  const response = object(
    await api.post<unknown>(
      "/api/v1/audit-sinks/dlq/replay-bulk",
      { ids: unique },
      writeOptions(options),
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["replayed", "failed", "skipped", "entries"]) ||
    !Array.isArray(response.entries) ||
    response.entries.length !== unique.length
  )
    return invalid("bulk DLQ replay receipt");
  const replayed = safeInteger(response.replayed);
  const failed = safeInteger(response.failed);
  const skipped = safeInteger(response.skipped);
  if (
    replayed === null ||
    failed === null ||
    skipped === null ||
    replayed + failed + skipped !== unique.length
  )
    return invalid("bulk DLQ replay receipt");
  const entries: AuditDLQBulkEntryReceipt[] = [];
  for (const candidate of response.entries) {
    const row = object(candidate);
    const id = row ? safeInteger(row.id, 1) : null;
    const rows = row ? safeInteger(row.rows) : null;
    if (
      !row ||
      !hasOnly(row, ["id", "status", "rows", "errorMsg"]) ||
      id === null ||
      rows === null ||
      !["ok", "failed", "skipped", "not_found"].includes(String(row.status)) ||
      (row.errorMsg !== undefined && typeof row.errorMsg !== "string")
    )
      return invalid("bulk DLQ replay receipt");
    entries.push({
      id,
      status: row.status as AuditDLQBulkEntryReceipt["status"],
      rows,
      hasError: typeof row.errorMsg === "string" && row.errorMsg.length > 0,
    });
  }
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    entries.some((entry) => !unique.includes(entry.id))
  )
    return invalid("bulk DLQ replay receipt");
  return { replayed, failed, skipped, entries };
}

function decodeSigningKey(value: unknown): AuditSinkSigningKey | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, ["id", "kid", "alg", "rotated_at", "revoked_at", "status"])
  )
    return null;
  const id = textValue(row.id, 128);
  const kid = textValue(row.kid, 256);
  const rotatedAt = instant(row.rotated_at);
  const revokedAt = optionalInstant(row.revoked_at);
  if (
    !id ||
    !kid ||
    row.alg !== "HS256" ||
    !rotatedAt ||
    revokedAt === null ||
    (row.status !== "active" && row.status !== "revoked") ||
    (row.status === "active" && revokedAt) ||
    (row.status === "revoked" && !revokedAt)
  )
    return null;
  return {
    id,
    kid,
    alg: "HS256",
    rotatedAt,
    ...(revokedAt ? { revokedAt } : {}),
    status: row.status,
  };
}

export async function listAuditSinkSigningKeys(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditSinkSigningKey[]> {
  const response = object(
    await api.get<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(requireID(id, "sink"))}/signing-keys`,
      opts,
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["keys"]) ||
    !Array.isArray(response.keys) ||
    response.keys.length > 100
  )
    return invalid("signing-key inventory");
  const keys = response.keys.map(decodeSigningKey);
  if (keys.some((key) => !key)) return invalid("signing-key inventory");
  return keys as AuditSinkSigningKey[];
}

export async function rotateAuditSinkSigningKey(
  id: string,
  options: AuditMutationOptions = {},
): Promise<{ kid: string }> {
  const sinkId = requireID(id, "sink");
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/rotate-key`,
      {},
      writeOptions(options),
    ),
  );
  const kid = response ? textValue(response.kid, 256) : null;
  if (
    !response ||
    !hasOnly(response, ["kid", "alg", "sink_id"]) ||
    !kid ||
    response.alg !== "HS256" ||
    response.sink_id !== sinkId
  )
    return invalid("signing-key rotation receipt");
  return { kid };
}

function decodeReplayJob(
  value: unknown,
  tenantId: string,
  sinkId: string,
): AuditReplayJob | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, [
      "id",
      "tenant_id",
      "sink_id",
      "from_audit_id",
      "to_audit_id",
      "status",
      "rows_sent",
      "rows_failed",
      "last_error",
      "next_cursor_id",
      "created_at",
      "started_at",
      "completed_at",
      "created_by",
    ])
  )
    return null;
  const id = textValue(row.id, 128);
  const fromAuditId = safeInteger(row.from_audit_id);
  const toAuditId = safeInteger(row.to_audit_id);
  const status = enumValue(row.status, REPLAY_STATUSES);
  const rowsSent = safeInteger(row.rows_sent);
  const rowsFailed = safeInteger(row.rows_failed);
  const nextCursorId =
    row.next_cursor_id === undefined || row.next_cursor_id === null
      ? undefined
      : safeInteger(row.next_cursor_id);
  const createdAt = instant(row.created_at);
  const startedAt = optionalInstant(row.started_at);
  const completedAt = optionalInstant(row.completed_at);
  const createdBy = optionalText(row.created_by, 256);
  if (
    !id ||
    row.tenant_id !== tenantId ||
    row.sink_id !== sinkId ||
    fromAuditId === null ||
    toAuditId === null ||
    fromAuditId > toAuditId ||
    !status ||
    rowsSent === null ||
    rowsFailed === null ||
    nextCursorId === null ||
    !createdAt ||
    startedAt === null ||
    completedAt === null ||
    createdBy === null ||
    (row.last_error !== undefined && typeof row.last_error !== "string")
  )
    return null;
  return {
    id,
    tenantId,
    sinkId,
    fromAuditId,
    toAuditId,
    status,
    rowsSent,
    rowsFailed,
    ...(nextCursorId === undefined ? {} : { nextCursorId }),
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(createdBy ? { createdBy } : {}),
    hasLastError:
      typeof row.last_error === "string" && row.last_error.length > 0,
  };
}

export async function listAuditSinkReplayJobs(
  tenantId: string,
  sinkId: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{ jobs: AuditReplayJob[]; nextCursor?: string }> {
  const boundTenant = requireID(tenantId, "tenant");
  const boundSink = requireID(sinkId, "sink");
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Replay-job page size must be between 1 and 100.");
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) params.set("cursor", requireID(options.cursor, "cursor"));
  const response = object(
    await api.get<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(boundSink)}/replay-jobs?${params.toString()}`,
      { signal: options.signal },
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["jobs", "count", "nextCursor"]) ||
    !Array.isArray(response.jobs) ||
    response.jobs.length > limit ||
    safeInteger(response.count) !== response.jobs.length
  )
    return invalid("replay-job list");
  const jobs = response.jobs.map((job) =>
    decodeReplayJob(job, boundTenant, boundSink),
  );
  const nextCursor = optionalText(response.nextCursor, 128);
  if (
    jobs.some((job) => !job) ||
    nextCursor === null ||
    (nextCursor !== undefined && nextCursor === options.cursor)
  )
    return invalid("replay-job list");
  return {
    jobs: jobs as AuditReplayJob[],
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export async function createAuditSinkReplayJob(
  sinkId: string,
  fromId: number,
  toId: number,
  options: AuditMutationOptions = {},
): Promise<AuditReplayCreateReceipt> {
  const boundSink = requireID(sinkId, "sink");
  if (
    !Number.isSafeInteger(fromId) ||
    !Number.isSafeInteger(toId) ||
    fromId < 0 ||
    fromId > toId ||
    toId - fromId + 1 > 100_000
  )
    throw new Error(
      "Replay range must be ordered, non-negative, and at most 100,000 rows.",
    );
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(boundSink)}/replay`,
      { from_id: fromId, to_id: toId },
      writeOptions(options),
    ),
  );
  const jobId = response ? textValue(response.job_id, 128) : null;
  const createdAt = response ? instant(response.created_at) : null;
  if (
    !response ||
    !hasOnly(response, [
      "job_id",
      "status",
      "created_at",
      "from_id",
      "to_id",
    ]) ||
    !jobId ||
    response.status !== "pending" ||
    !createdAt ||
    response.from_id !== fromId ||
    response.to_id !== toId
  )
    return invalid("replay-job creation receipt");
  return { jobId, status: "pending", createdAt, fromId, toId };
}

export async function cancelAuditSinkReplayJob(
  sinkId: string,
  jobId: string,
  options: AuditMutationOptions = {},
): Promise<void> {
  const boundSink = requireID(sinkId, "sink");
  const boundJob = requireID(jobId, "replay job");
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-sinks/${encodeURIComponent(boundSink)}/replay-jobs/${encodeURIComponent(boundJob)}/cancel`,
      {},
      writeOptions(options),
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["cancelled", "job_id"]) ||
    response.cancelled !== true ||
    response.job_id !== boundJob
  )
    invalid("replay cancellation receipt");
}

function decodeAlertRule(value: unknown): AuditAlertRule | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, [
      "id",
      "name",
      "enabled",
      "action_glob",
      "actor_type",
      "actor_label_glob",
      "resource_type",
      "operator_kind",
      "operator_config",
      "channel_kind",
      "channel_config",
      "notify_slack",
      "fired_count",
      "last_fired_at",
      "last_error",
      "created_at",
    ])
  )
    return null;
  const id = textValue(row.id, 128);
  const name = textValue(row.name, 256);
  const actionGlob = textValue(row.action_glob, 256);
  const actorType = optionalText(row.actor_type, 64);
  const actorLabelGlob = optionalText(row.actor_label_glob, 256);
  const resourceType = optionalText(row.resource_type, 128);
  const operatorKind = enumValue(row.operator_kind, OPERATOR_KINDS);
  const channelKind = enumValue(row.channel_kind, CHANNEL_KINDS);
  const firedCount = safeInteger(row.fired_count);
  const lastFiredAt = optionalInstant(row.last_fired_at);
  const createdAt = instant(row.created_at);
  if (
    !id ||
    !name ||
    !actionGlob ||
    typeof row.enabled !== "boolean" ||
    actorType === null ||
    actorLabelGlob === null ||
    resourceType === null ||
    !operatorKind ||
    !object(row.operator_config) ||
    !channelKind ||
    !object(row.channel_config) ||
    typeof row.notify_slack !== "boolean" ||
    firedCount === null ||
    lastFiredAt === null ||
    !createdAt ||
    (row.last_error !== undefined && typeof row.last_error !== "string")
  )
    return null;
  return {
    id,
    name,
    enabled: row.enabled,
    actionGlob,
    ...(actorType ? { actorType } : {}),
    ...(actorLabelGlob ? { actorLabelGlob } : {}),
    ...(resourceType ? { resourceType } : {}),
    operatorKind,
    channelKind,
    notifySlack: row.notify_slack,
    firedCount,
    ...(lastFiredAt ? { lastFiredAt } : {}),
    createdAt,
    hasDeliveryError:
      typeof row.last_error === "string" && row.last_error.length > 0,
  };
}

export async function listAuditAlertRules(
  opts: { signal?: AbortSignal; cache?: RequestCache } = {},
): Promise<AuditAlertRule[]> {
  const response = object(await api.get<unknown>("/api/v1/audit-alerts", opts));
  if (
    !response ||
    !hasOnly(response, ["rules"]) ||
    !Array.isArray(response.rules) ||
    response.rules.length > 1_000
  )
    return invalid("audit-alert rule list");
  const rules = response.rules.map(decodeAlertRule);
  if (rules.some((rule) => !rule)) return invalid("audit-alert rule list");
  return rules as AuditAlertRule[];
}

function validateAlertInput(input: AuditAlertRuleInput): AuditAlertRuleInput {
  if (
    !textValue(input.name, 256) ||
    !textValue(input.action_glob, 256) ||
    !CHANNEL_KINDS.has(input.channel_kind) ||
    (input.operator_kind !== undefined &&
      !OPERATOR_KINDS.has(input.operator_kind)) ||
    !object(input.channel_config) ||
    (input.operator_config !== undefined && !object(input.operator_config))
  )
    throw new Error(
      "Complete the valid alert rule, operator, and channel fields.",
    );
  return input;
}

export async function verifyAuditAlertChannel(
  kind: "servicenow" | "jira" | "pagerduty",
  config: Record<string, unknown>,
): Promise<void> {
  let body: Record<string, string>;
  if (kind === "servicenow") {
    const instanceURL = publicHTTPSOrigin(config.instance_url, "ServiceNow");
    const bearerToken = optionalSecret(config.bearer_token);
    const username = optionalSecret(config.username);
    const password = optionalSecret(config.password);
    if (
      (!bearerToken && (!username || !password)) ||
      (bearerToken && (username || password))
    ) {
      throw new Error(
        "Provide either a ServiceNow bearer token or username and password.",
      );
    }
    body = bearerToken
      ? { instance_url: instanceURL, bearer_token: bearerToken }
      : {
          instance_url: instanceURL,
          username: username!,
          password: password!,
        };
  } else if (kind === "jira") {
    const siteURL = publicHTTPSOrigin(config.site_url, "Jira");
    const email = textValue(config.email, 254);
    const apiToken = optionalSecret(config.api_token);
    if (!email || !EMAIL_RE.test(email) || !apiToken) {
      throw new Error("A valid Jira account email and API token are required.");
    }
    body = { site_url: siteURL, email, api_token: apiToken };
  } else {
    const routingKey = optionalSecret(config.routing_key);
    if (!routingKey || routingKey.length < 8) {
      throw new Error("The PagerDuty routing key is too short.");
    }
    body = { routing_key: routingKey };
  }
  const response = object(
    await api.post<unknown>(
      `/api/v1/audit-alerts/${kind}/auth`,
      body,
      WRITE_OPTIONS,
    ),
  );
  if (!response || !hasOnly(response, ["ok"]) || response.ok !== true) {
    invalid("audit-alert channel-verification receipt");
  }
}

function publicHTTPSOrigin(value: unknown, label: string): string {
  const candidate = textValue(value, 2_048);
  if (!candidate) throw new Error(`${label} requires a public HTTPS origin.`);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} requires a public HTTPS origin.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${label} requires a public HTTPS origin without credentials, path, query, or fragment.`,
    );
  }
  return parsed.origin;
}

function optionalSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8_192 || CONTROL_RE.test(trimmed))
    return null;
  return trimmed;
}

export async function createAuditAlertRule(
  input: AuditAlertRuleInput,
): Promise<{ id: string }> {
  const response = object(
    await api.post<unknown>(
      "/api/v1/audit-alerts",
      validateAlertInput(input),
      WRITE_OPTIONS,
    ),
  );
  const id = response ? textValue(response.id, 128) : null;
  if (!response || !hasOnly(response, ["id"]) || !id)
    return invalid("audit-alert creation receipt");
  return { id };
}

export async function patchAuditAlertRule(
  id: string,
  patch: { enabled?: boolean; notify_slack?: boolean; name?: string },
): Promise<void> {
  const boundId = requireID(id, "alert rule");
  if (
    Object.keys(patch).length < 1 ||
    Object.keys(patch).some(
      (key) => !["enabled", "notify_slack", "name"].includes(key),
    ) ||
    (patch.name !== undefined && !textValue(patch.name, 256))
  )
    throw new Error("A valid alert-rule change is required.");
  const response = object(
    await api.patch<unknown>(
      `/api/v1/audit-alerts/${encodeURIComponent(boundId)}`,
      patch,
      WRITE_OPTIONS,
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["updated", "id"]) ||
    response.updated !== true ||
    (response.id !== undefined && response.id !== boundId)
  )
    invalid("audit-alert update receipt");
}

export async function deleteAuditAlertRule(id: string): Promise<void> {
  const boundId = requireID(id, "alert rule");
  const response = object(
    await api.delete<unknown>(
      `/api/v1/audit-alerts/${encodeURIComponent(boundId)}`,
      WRITE_OPTIONS,
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["deleted", "id"]) ||
    response.deleted !== true ||
    (response.id !== undefined && response.id !== boundId)
  )
    invalid("audit-alert deletion receipt");
}

export async function listAuditAlertFires(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditAlertFire[]> {
  const response = object(
    await api.get<unknown>(
      `/api/v1/audit-alerts/${encodeURIComponent(requireID(id, "alert rule"))}/fires`,
      opts,
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["fires"]) ||
    !Array.isArray(response.fires) ||
    response.fires.length > 100
  )
    return invalid("audit-alert fire list");
  const fires: AuditAlertFire[] = [];
  for (const candidate of response.fires) {
    const row = object(candidate);
    const fireId = row ? safeInteger(row.id, 1) : null;
    const auditId = row ? safeInteger(row.audit_id, 1) : null;
    const firedAt = row ? instant(row.fired_at) : null;
    if (
      !row ||
      !hasOnly(row, [
        "id",
        "audit_id",
        "delivered",
        "delivery_error",
        "fired_at",
      ]) ||
      fireId === null ||
      auditId === null ||
      typeof row.delivered !== "boolean" ||
      typeof row.delivery_error !== "string" ||
      !firedAt
    )
      return invalid("audit-alert fire list");
    fires.push({
      id: fireId,
      auditId,
      delivered: row.delivered,
      firedAt,
      hasDeliveryError: row.delivery_error.length > 0,
    });
  }
  return fires;
}

export async function listAuditAlertIncidents(
  id: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<{ incidents: AuditAlertIncident[]; nextCursor?: string }> {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Incident page size must be between 1 and 200.");
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) params.set("cursor", requireID(options.cursor, "cursor"));
  const ruleId = requireID(id, "alert rule");
  const response = object(
    await api.get<unknown>(
      `/api/v1/audit-alerts/${encodeURIComponent(ruleId)}/incidents?${params.toString()}`,
      { signal: options.signal },
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["incidents", "nextCursor"]) ||
    !Array.isArray(response.incidents) ||
    response.incidents.length > limit
  )
    return invalid("audit-alert incident list");
  const incidents: AuditAlertIncident[] = [];
  for (const candidate of response.incidents) {
    const row = object(candidate);
    const incidentId = row ? safeInteger(row.id, 1) : null;
    const externalSystem =
      row &&
      ["servicenow", "jira", "pagerduty"].includes(String(row.external_system))
        ? (row.external_system as AuditAlertIncident["externalSystem"])
        : null;
    const externalIncidentId = row
      ? textValue(row.external_incident_id, 512)
      : null;
    const status = row ? optionalText(row.incident_status, 128) : null;
    const lastSyncedAt = row ? optionalInstant(row.last_synced_at) : null;
    const createdAt = row ? instant(row.created_at) : null;
    const updatedAt = row ? instant(row.updated_at) : null;
    const auditId =
      row?.audit_id === undefined || row.audit_id === null
        ? undefined
        : safeInteger(row.audit_id, 1);
    const rawUrl = row ? optionalText(row.incident_url, 2_048) : null;
    if (
      !row ||
      !hasOnly(row, [
        "id",
        "rule_id",
        "audit_id",
        "external_system",
        "external_incident_id",
        "incident_status",
        "incident_url",
        "last_synced_at",
        "created_at",
        "updated_at",
      ]) ||
      incidentId === null ||
      row.rule_id !== ruleId ||
      !externalSystem ||
      !externalIncidentId ||
      status === null ||
      lastSyncedAt === null ||
      !createdAt ||
      !updatedAt ||
      auditId === null ||
      rawUrl === null
    )
      return invalid("audit-alert incident list");
    let url: string | undefined;
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === "https:") url = parsed.toString();
      } catch {
        /* unsafe/malformed URLs are rendered as plain text */
      }
    }
    incidents.push({
      id: incidentId,
      ruleId,
      ...(auditId === undefined ? {} : { auditId }),
      externalSystem,
      externalIncidentId,
      ...(status ? { status } : {}),
      ...(url ? { url } : {}),
      ...(lastSyncedAt ? { lastSyncedAt } : {}),
      createdAt,
      updatedAt,
    });
  }
  const nextCursor = optionalText(response.nextCursor, 1_024);
  if (nextCursor === null) return invalid("audit-alert incident list");
  return { incidents, ...(nextCursor ? { nextCursor } : {}) };
}

function auditQuery(
  filters: {
    actorType?: string;
    actorLabel?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    since?: string;
  } = {},
): string {
  const params = new URLSearchParams();
  for (const [wire, value, max] of [
    ["actor_type", filters.actorType, 64],
    ["actor_label", filters.actorLabel, 256],
    ["action", filters.action, 256],
    ["resource_type", filters.resourceType, 128],
    ["resource_id", filters.resourceId, 256],
    ["since", filters.since, 80],
  ] as const) {
    if (value === undefined || value === "") continue;
    if (!textValue(value, max))
      throw new Error("Audit filters contain invalid text.");
    params.set(wire, value);
  }
  return params.toString();
}

function decodeCounts(
  value: unknown,
  max: number,
): Array<{ label: string; count: number }> | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: Array<{ label: string; count: number }> = [];
  for (const candidate of value) {
    const row = object(candidate);
    const label = row ? textValue(row.label, 256) : null;
    const count = row ? safeInteger(row.count) : null;
    if (!row || !hasOnly(row, ["label", "count"]) || !label || count === null)
      return null;
    out.push({ label, count });
  }
  return out;
}

export async function getAuditStats(
  filters: Parameters<typeof auditQuery>[0] = {},
  opts: { signal?: AbortSignal } = {},
): Promise<AuditStats> {
  const qs = auditQuery(filters);
  const row = object(
    await api.get<unknown>(`/api/v1/audit/stats${qs ? `?${qs}` : ""}`, opts),
  );
  const totalEvents = row ? safeInteger(row.totalEvents) : null;
  const byActorType = row ? decodeCounts(row.byActorType, 32) : null;
  const topActions = row ? decodeCounts(row.topActions, 10) : null;
  if (
    !row ||
    !hasOnly(row, [
      "totalEvents",
      "byActorType",
      "topActions",
      "daily",
      "window",
    ]) ||
    totalEvents === null ||
    !byActorType ||
    !topActions ||
    !Array.isArray(row.daily) ||
    row.daily.length > 500
  )
    return invalid("audit statistics");
  const daily: AuditStats["daily"] = [];
  for (const candidate of row.daily) {
    const bucket = object(candidate);
    const date = bucket ? textValue(bucket.date, 10) : null;
    const count = bucket ? safeInteger(bucket.count) : null;
    if (
      !bucket ||
      !hasOnly(bucket, ["date", "count"]) ||
      !date ||
      !DATE_RE.test(date) ||
      count === null
    )
      return invalid("audit statistics");
    daily.push({ date, count });
  }
  return { totalEvents, byActorType, topActions, daily };
}

function proofHash(value: unknown): string | null {
  const candidate = textValue(value, 4_096);
  return candidate && candidate.length % 2 === 0 && HEX_RE.test(candidate)
    ? candidate
    : null;
}

export async function getLatestAuditCheckpoint(
  opts: { signal?: AbortSignal } = {},
): Promise<AuditCheckpoint> {
  const row = object(
    await api.get<unknown>("/api/v1/audit/checkpoint/latest", opts),
  );
  const checkpointId = row ? safeInteger(row.checkpoint_id, 1) : null;
  const treeSize = row ? safeInteger(row.tree_size, 1) : null;
  const uptoAuditId = row ? safeInteger(row.upto_audit_id, 1) : null;
  const rootHash = row ? proofHash(row.root_hash) : null;
  const rootSignature = row ? optionalText(row.root_signature, 4_096) : null;
  const rootKid = row ? optionalText(row.root_kid, 512) : null;
  const anchoredAt = row ? instant(row.anchored_at) : null;
  if (
    !row ||
    !hasOnly(row, [
      "checkpoint_id",
      "tree_size",
      "upto_audit_id",
      "root_hash",
      "root_signature",
      "root_kid",
      "anchored_at",
    ]) ||
    checkpointId === null ||
    treeSize === null ||
    uptoAuditId === null ||
    !rootHash ||
    rootSignature === null ||
    rootKid === null ||
    !anchoredAt
  )
    return invalid("audit checkpoint");
  return {
    checkpointId,
    treeSize,
    uptoAuditId,
    rootHash,
    ...(rootSignature ? { rootSignature } : {}),
    ...(rootKid ? { rootKid } : {}),
    anchoredAt,
  };
}

export async function getAuditInclusionProof(
  id: number,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditInclusionProof> {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("A positive audit event id is required.");
  const row = object(
    await api.get<unknown>(
      `/api/v1/audit/${encodeURIComponent(String(id))}/inclusion-proof`,
      opts,
    ),
  );
  const leafId = row ? safeInteger(row.leaf_id, 1) : null;
  const leafHash = row ? proofHash(row.leaf_hash) : null;
  const treeSize = row ? safeInteger(row.tree_size, 1) : null;
  const rootHash = row ? proofHash(row.root_hash) : null;
  const rootSignature = row ? optionalText(row.root_signature, 4_096) : null;
  const rootKid = row ? optionalText(row.root_kid, 512) : null;
  const anchoredAt = row ? instant(row.anchored_at) : null;
  if (
    !row ||
    !hasOnly(row, [
      "leaf_id",
      "leaf_hash",
      "audit_path",
      "tree_size",
      "root_hash",
      "root_signature",
      "root_kid",
      "anchored_at",
    ]) ||
    leafId !== id ||
    !leafHash ||
    treeSize === null ||
    !rootHash ||
    rootSignature === null ||
    rootKid === null ||
    !anchoredAt ||
    !Array.isArray(row.audit_path) ||
    row.audit_path.length > 10_000
  )
    return invalid("audit inclusion proof");
  const auditPath = row.audit_path.map(proofHash);
  if (auditPath.some((hash) => !hash)) return invalid("audit inclusion proof");
  return {
    leafId,
    leafHash,
    auditPath: auditPath as string[],
    treeSize,
    rootHash,
    ...(rootSignature ? { rootSignature } : {}),
    ...(rootKid ? { rootKid } : {}),
    anchoredAt,
  };
}

function decodeAuditExportJob(value: unknown): AuditExportJob | null {
  const row = object(value);
  if (
    !row ||
    !hasOnly(row, [
      "id",
      "status",
      "estimatedRows",
      "exportedRows",
      "totalBytes",
      "fileUrl",
      "errorReason",
      "emailOnComplete",
      "emailAddress",
      "createdAt",
      "startedAt",
      "completedAt",
      "etaSeconds",
    ])
  )
    return null;
  const id = textValue(row.id, 128);
  const status = enumValue(row.status, EXPORT_JOB_STATUSES);
  const estimatedRows =
    row.estimatedRows === undefined
      ? undefined
      : safeInteger(row.estimatedRows);
  const exportedRows = safeInteger(row.exportedRows);
  const totalBytes = safeInteger(row.totalBytes);
  const fileURL = optionalText(row.fileUrl, 512);
  const errorReason = optionalText(row.errorReason, 4_096);
  const emailAddress = optionalText(row.emailAddress, 254);
  const createdAt = instant(row.createdAt);
  const startedAt = optionalInstant(row.startedAt);
  const completedAt = optionalInstant(row.completedAt);
  const etaSeconds =
    row.etaSeconds === undefined ? undefined : safeInteger(row.etaSeconds);
  if (
    !id ||
    !status ||
    estimatedRows === null ||
    exportedRows === null ||
    totalBytes === null ||
    fileURL === null ||
    errorReason === null ||
    emailAddress === null ||
    typeof row.emailOnComplete !== "boolean" ||
    !createdAt ||
    startedAt === null ||
    completedAt === null ||
    etaSeconds === null ||
    (row.emailOnComplete && (!emailAddress || !EMAIL_RE.test(emailAddress))) ||
    (status === "completed" &&
      fileURL !==
        `/api/v1/audit/export-jobs/${encodeURIComponent(id)}/download`)
  )
    return null;
  return {
    id,
    status,
    ...(estimatedRows === undefined ? {} : { estimatedRows }),
    exportedRows,
    totalBytes,
    emailOnComplete: row.emailOnComplete,
    createdAt,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(etaSeconds === undefined ? {} : { etaSeconds }),
    hasError: Boolean(errorReason),
  };
}

function validateAuditExportInput(
  input: AuditExportJobInput,
): AuditExportJobInput {
  const output: AuditExportJobInput = {};
  for (const [key, value, max] of [
    ["actorType", input.actorType, 64],
    ["actorLabel", input.actorLabel, 256],
    ["action", input.action, 256],
    ["resourceType", input.resourceType, 128],
    ["resourceId", input.resourceId, 256],
  ] as const) {
    if (value === undefined || value === "") continue;
    const safe = textValue(value, max);
    if (!safe) throw new Error("Audit export filters contain invalid text.");
    output[key] = safe;
  }
  if (input.since) {
    const since = instant(input.since);
    if (!since) throw new Error("Audit export start time must be RFC3339.");
    output.since = since;
  }
  output.emailOnComplete = input.emailOnComplete === true;
  if (output.emailOnComplete) {
    const email = textValue(input.emailAddress, 254);
    if (!email || !EMAIL_RE.test(email)) {
      throw new Error("A valid completion email is required.");
    }
    output.emailAddress = email;
  }
  return output;
}

export async function createAuditExportJob(
  input: AuditExportJobInput,
): Promise<AuditExportJob> {
  const response = await api.post<unknown>(
    "/api/v1/audit/export-async",
    validateAuditExportInput(input),
    WRITE_OPTIONS,
  );
  return (
    decodeAuditExportJob(response) ??
    invalid("audit export-job creation receipt")
  );
}

export async function listAuditExportJobs(
  limit = 20,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditExportJob[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Export-job list size must be between 1 and 200.");
  }
  const response = object(
    await api.get<unknown>(`/api/v1/audit/export-jobs?limit=${limit}`, opts),
  );
  if (
    !response ||
    !hasOnly(response, ["jobs"]) ||
    !Array.isArray(response.jobs) ||
    response.jobs.length > limit
  )
    return invalid("audit export-job list");
  const jobs = response.jobs.map(decodeAuditExportJob);
  if (jobs.some((job) => !job)) return invalid("audit export-job list");
  return jobs as AuditExportJob[];
}

export async function getAuditExportJob(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditExportJob> {
  const boundID = requireID(id, "audit export job");
  const response = await api.get<unknown>(
    `/api/v1/audit/export-jobs/${encodeURIComponent(boundID)}`,
    opts,
  );
  const job = decodeAuditExportJob(response);
  if (!job || job.id !== boundID) return invalid("audit export-job detail");
  return job;
}

export function auditExportJobDownloadPath(id: string): string {
  return `/api/v1/audit/export-jobs/${encodeURIComponent(requireID(id, "audit export job"))}/download`;
}

export async function listAuditExportManifests(
  limit = 20,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditExportManifest[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Export-manifest page size must be between 1 and 200.");
  }
  const response = object(
    await api.get<unknown>(
      `/api/v1/audit/export/manifests?limit=${limit}`,
      opts,
    ),
  );
  if (
    !response ||
    !hasOnly(response, ["manifests"]) ||
    !Array.isArray(response.manifests) ||
    response.manifests.length > limit
  ) {
    return invalid("audit export-manifest list");
  }
  const manifests: AuditExportManifest[] = [];
  for (const candidate of response.manifests) {
    const row = object(candidate);
    const exportId = row ? textValue(row.export_id, 256) : null;
    const fromAuditId = row ? safeInteger(row.from_audit_id) : null;
    const toAuditId = row ? safeInteger(row.to_audit_id) : null;
    const rowCount = row ? safeInteger(row.row_count) : null;
    const treeSize = row ? safeInteger(row.tree_size_at_export) : null;
    const rootHash = row ? proofHash(row.root_hash_hex) : null;
    const signature = row ? optionalText(row.signature_hex, 8_192) : null;
    const signatureKid = row ? optionalText(row.signature_kid, 512) : null;
    const createdAt = row ? instant(row.created_at) : null;
    if (
      !row ||
      !hasOnly(row, [
        "export_id",
        "filters_canonical",
        "from_audit_id",
        "to_audit_id",
        "row_count",
        "tree_size_at_export",
        "root_hash_hex",
        "signature_hex",
        "signature_kid",
        "exported_by",
        "created_at",
      ]) ||
      !object(row.filters_canonical) ||
      !exportId ||
      fromAuditId === null ||
      toAuditId === null ||
      fromAuditId > toAuditId ||
      rowCount === null ||
      treeSize === null ||
      !rootHash ||
      signature === null ||
      signatureKid === null ||
      !createdAt
    ) {
      return invalid("audit export-manifest list");
    }
    manifests.push({
      exportId,
      fromAuditId,
      toAuditId,
      rowCount,
      treeSize,
      rootHash,
      ...(signatureKid ? { signatureKid } : {}),
      hasSignature: Boolean(signature),
      createdAt,
    });
  }
  return manifests;
}

function requireID(value: string, label: string): string {
  const id = textValue(value, 1_024);
  if (!id) throw new Error(`A valid ${label} id is required.`);
  return id;
}
