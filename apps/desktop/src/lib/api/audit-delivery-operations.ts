import type { ApiResult } from "./result";

export interface AuditDeliveryRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type AuditDeliveryRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: AuditDeliveryRequestOptions,
) => Promise<ApiResult<T>>;

export interface AuditDeliveryOperationsDependencies {
  request: AuditDeliveryRequester;
}

/** Audit payload format emitted to a sink. */
export type AuditSinkOutputFormat = "postwave_native" | "ocsf_1_8";

/** HTTP audit-sink signature envelope. */
export type AuditSinkWebhookFormat = "postwave_v1" | "standard_webhooks";

export interface AuditSink {
  id: string;
  kind:
    | "s3"
    | "datadog"
    | "splunk"
    | "http"
    | "archive"
    | "snowflake_shareback"
    | "otlp_logs";
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  output_format: AuditSinkOutputFormat;
  /** Defaults to "postwave_v1" for back-compat. Only meaningful when kind=http. */
  webhook_format: AuditSinkWebhookFormat;
  consecutive_failures: number;
  /** Threshold the worker uses to auto-disable. Defaults to 100. */
  auto_disable_after: number;
  /**
   * Circuit-breaker state. `closed` = healthy, `open` = upstream is
   * unhealthy and deliveries are short-circuiting into the DLQ,
   * `half_open` = the next delivery is a probe.
   */
  circuit_state: "closed" | "open" | "half_open";
  /** Set while circuit_state=open — when the next probe will fire. */
  cooldown_until?: string | null;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_error?: string | null;
}

export interface AuditSinkInput {
  kind:
    | "s3"
    | "datadog"
    | "splunk"
    | "http"
    | "archive"
    | "snowflake_shareback"
    | "otlp_logs";
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
  /** Credential blob — server encrypts under the tenant's KEK. */
  credentials?: Record<string, string>;
  output_format?: AuditSinkOutputFormat;
  /** HTTP-only. Defaults to postwave_v1 server-side. */
  webhook_format?: AuditSinkWebhookFormat;
}

/** Patch shape; credentials replace the stored envelope. */
export interface AuditSinkPatch {
  enabled?: boolean;
  name?: string;
  config?: Record<string, unknown>;
  credentials?: Record<string, string>;
  output_format?: AuditSinkOutputFormat;
  webhook_format?: AuditSinkWebhookFormat;
}

/** One signing key in the Standard Webhooks rotation history. */
export interface AuditSinkSigningKey {
  id: string;
  kid: string;
  alg: "HS256";
  rotated_at: string;
  revoked_at?: string | null;
  status: "active" | "revoked";
}

/** RFC 7517 response from a sink's JWKS endpoint. */
export interface AuditSinkJWKS {
  keys: Array<{
    kty: "oct";
    alg: "HS256";
    kid: string;
    use?: "sig";
    k: string;
  }>;
}

/** A pending or replayed dead-letter queue entry. */
export interface AuditSinkDLQEntry {
  id: number;
  sink_id: string;
  from_audit_id: number;
  to_audit_id: number;
  last_error: string;
  attempt_count: number;
  first_failed_at: string;
  last_attempt_at: string;
  replayed_at?: string | null;
  replayed_by?: string | null;
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

export type AuditAlertExternalSystem = "servicenow" | "jira" | "pagerduty";

export interface AuditAlertRule {
  id: string;
  name: string;
  enabled: boolean;
  action_glob: string;
  actor_type?: string;
  actor_label_glob?: string;
  resource_type?: string;
  operator_kind: AuditAlertOperatorKind;
  operator_config: Record<string, unknown>;
  channel_kind: AuditAlertChannelKind;
  channel_config: Record<string, unknown>;
  notify_slack?: boolean;
  fired_count: number;
  last_fired_at?: string | null;
  last_error?: string;
  created_at: string;
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

export interface AuditAlertRulePatch {
  enabled?: boolean;
  name?: string;
  channel_config?: Record<string, unknown>;
  notify_slack?: boolean;
}

export interface AuditAlertIncident {
  id: number;
  rule_id: string;
  audit_id?: number | null;
  external_system: AuditAlertExternalSystem;
  external_incident_id: string;
  incident_status?: string;
  incident_url?: string;
  last_synced_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type ReplayJobStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReplayJobInput {
  from_id: number;
  to_id: number;
}

export interface ReplayJobCreateResponse {
  job_id: string;
  status: ReplayJobStatus;
  created_at: string;
  from_id: number;
  to_id: number;
}

export interface ReplayJob {
  id: string;
  tenant_id: string;
  sink_id: string;
  from_audit_id: number;
  to_audit_id: number;
  status: ReplayJobStatus;
  rows_sent: number;
  rows_failed: number;
  last_error?: string;
  next_cursor_id?: number | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  created_by?: string;
}

export function createAuditSinksList({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinksList(): Promise<ApiResult<{ sinks: AuditSink[] }>> {
    return request<{ sinks: AuditSink[] }>("/api/v1/audit-sinks");
  };
}

export function createAuditSinkCreate({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkCreate(
    input: AuditSinkInput,
  ): Promise<ApiResult<AuditSink>> {
    return request<AuditSink>("/api/v1/audit-sinks", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createAuditSinkPatch({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkPatch(
    id: string,
    patch: AuditSinkPatch,
  ): Promise<ApiResult<AuditSink>> {
    return request<AuditSink>(`/api/v1/audit-sinks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  };
}

export function createAuditSinkDelete({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkDelete(
    id: string,
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

export function createAuditSinkTest({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkTest(
    input: AuditSinkInput,
  ): Promise<ApiResult<{ delivered: boolean; kind: string; action: string }>> {
    return request<{ delivered: boolean; kind: string; action: string }>(
      "/api/v1/audit-sinks/test",
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

export function createAuditSinkTestExisting({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkTestExisting(
    id: string,
  ): Promise<ApiResult<{ delivered: boolean; kind: string; action: string }>> {
    return request<{ delivered: boolean; kind: string; action: string }>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    );
  };
}

export function createAuditSinkDLQList({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkDLQList(): Promise<
    ApiResult<{ entries: AuditSinkDLQEntry[]; count: number }>
  > {
    return request<{ entries: AuditSinkDLQEntry[]; count: number }>(
      "/api/v1/audit-sinks/dlq",
    );
  };
}

export function createAuditSinkSigningKeysList({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkSigningKeysList(
    id: string,
  ): Promise<ApiResult<{ keys: AuditSinkSigningKey[] }>> {
    return request<{ keys: AuditSinkSigningKey[] }>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/signing-keys`,
    );
  };
}

export function createAuditSinkRotateKey({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkRotateKey(
    id: string,
  ): Promise<ApiResult<{ kid: string; alg: "HS256"; sink_id: string }>> {
    return request<{ kid: string; alg: "HS256"; sink_id: string }>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/rotate-key`,
      { method: "POST" },
    );
  };
}

export function createAuditSinkJWKS({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkJWKS(id: string): Promise<ApiResult<AuditSinkJWKS>> {
    return request<AuditSinkJWKS>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/.well-known/jwks.json`,
    );
  };
}

export function createAuditSinkDLQReplay({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkDLQReplay(
    id: number,
  ): Promise<ApiResult<{ replayed: boolean; rows: number; note?: string }>> {
    return request<{ replayed: boolean; rows: number; note?: string }>(
      `/api/v1/audit-sinks/dlq/${id}/replay`,
      { method: "POST" },
    );
  };
}

export function createAuditSinkCircuitReset({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkCircuitReset(
    id: string,
  ): Promise<ApiResult<{ reset: boolean }>> {
    return request<{ reset: boolean }>(
      `/api/v1/audit-sinks/${encodeURIComponent(id)}/circuit/reset`,
      { method: "POST" },
    );
  };
}

export function createAuditAlertsList({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertsList(): Promise<
    ApiResult<{ rules: AuditAlertRule[] }>
  > {
    return request<{ rules: AuditAlertRule[] }>("/api/v1/audit-alerts");
  };
}

export function createAuditAlertCreate({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertCreate(
    input: AuditAlertRuleInput,
  ): Promise<ApiResult<{ id: string }>> {
    return request<{ id: string }>("/api/v1/audit-alerts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
}

export function createAuditAlertPatch({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertPatch(
    id: string,
    patch: AuditAlertRulePatch,
  ): Promise<ApiResult<{ updated: boolean }>> {
    return request<{ updated: boolean }>(
      `/api/v1/audit-alerts/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  };
}

export function createAuditAlertDelete({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertDelete(
    id: string,
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/audit-alerts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  };
}

export function createAuditAlertIncidents({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertIncidents(
    id: string,
  ): Promise<ApiResult<{ incidents: AuditAlertIncident[] }>> {
    return request<{ incidents: AuditAlertIncident[] }>(
      `/api/v1/audit-alerts/${encodeURIComponent(id)}/incidents`,
    );
  };
}

export function createAuditAlertVerifyServiceNow({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertVerifyServiceNow(
    config: Record<string, unknown>,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>("/api/v1/audit-alerts/servicenow/auth", {
      method: "POST",
      body: JSON.stringify(config),
    });
  };
}

export function createAuditAlertVerifyJira({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertVerifyJira(
    config: Record<string, unknown>,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>("/api/v1/audit-alerts/jira/auth", {
      method: "POST",
      body: JSON.stringify(config),
    });
  };
}

export function createAuditAlertVerifyPagerDuty({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditAlertVerifyPagerDuty(
    config: Record<string, unknown>,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>("/api/v1/audit-alerts/pagerduty/auth", {
      method: "POST",
      body: JSON.stringify(config),
    });
  };
}

export function createAuditSinkReplay({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkReplay(
    sinkId: string,
    input: ReplayJobInput,
  ): Promise<ApiResult<ReplayJobCreateResponse>> {
    return request<ReplayJobCreateResponse>(
      `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/replay`,
      { method: "POST", body: JSON.stringify(input) },
    );
  };
}

export function createAuditSinkReplayJobsList({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkReplayJobsList(
    sinkId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<
    ApiResult<{ jobs: ReplayJob[]; count: number; nextCursor?: string }>
  > {
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<{ jobs: ReplayJob[]; count: number; nextCursor?: string }>(
      `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/replay-jobs${qs ? `?${qs}` : ""}`,
    );
  };
}

export function createAuditSinkReplayJobGet({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkReplayJobGet(
    sinkId: string,
    jobId: string,
  ): Promise<ApiResult<ReplayJob>> {
    return request<ReplayJob>(
      `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/replay-jobs/${encodeURIComponent(jobId)}`,
    );
  };
}

export function createAuditSinkReplayJobCancel({
  request,
}: AuditDeliveryOperationsDependencies) {
  return function auditSinkReplayJobCancel(
    sinkId: string,
    jobId: string,
  ): Promise<ApiResult<{ cancelled: boolean; job_id: string }>> {
    return request<{ cancelled: boolean; job_id: string }>(
      `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/replay-jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    );
  };
}

export function createAuditDeliveryOperationsMethods(
  dependencies: AuditDeliveryOperationsDependencies,
) {
  return {
    auditSinksList: createAuditSinksList(dependencies),
    auditSinkCreate: createAuditSinkCreate(dependencies),
    auditSinkPatch: createAuditSinkPatch(dependencies),
    auditSinkDelete: createAuditSinkDelete(dependencies),
    auditSinkTest: createAuditSinkTest(dependencies),
    auditSinkTestExisting: createAuditSinkTestExisting(dependencies),
    auditSinkDLQList: createAuditSinkDLQList(dependencies),
    auditSinkSigningKeysList: createAuditSinkSigningKeysList(dependencies),
    auditSinkRotateKey: createAuditSinkRotateKey(dependencies),
    auditSinkJWKS: createAuditSinkJWKS(dependencies),
    auditSinkDLQReplay: createAuditSinkDLQReplay(dependencies),
    auditSinkCircuitReset: createAuditSinkCircuitReset(dependencies),
    auditAlertsList: createAuditAlertsList(dependencies),
    auditAlertCreate: createAuditAlertCreate(dependencies),
    auditAlertPatch: createAuditAlertPatch(dependencies),
    auditAlertDelete: createAuditAlertDelete(dependencies),
    auditAlertIncidents: createAuditAlertIncidents(dependencies),
    auditAlertVerifyServiceNow: createAuditAlertVerifyServiceNow(dependencies),
    auditAlertVerifyJira: createAuditAlertVerifyJira(dependencies),
    auditAlertVerifyPagerDuty: createAuditAlertVerifyPagerDuty(dependencies),
    auditSinkReplay: createAuditSinkReplay(dependencies),
    auditSinkReplayJobsList: createAuditSinkReplayJobsList(dependencies),
    auditSinkReplayJobGet: createAuditSinkReplayJobGet(dependencies),
    auditSinkReplayJobCancel: createAuditSinkReplayJobCancel(dependencies),
  };
}
