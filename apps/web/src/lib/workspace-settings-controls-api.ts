// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Strict clients for the two workspace settings that are shared with desktop
 * but are not part of the general privacy-policy representation.
 *
 * Neither server route currently supports If-Match or another atomic compare
 * and swap token. Callers therefore perform an online re-read immediately
 * before writing and compare the mutable representation with the baseline the
 * operator reviewed. That is intentionally exposed through the equality
 * helpers below rather than hidden inside a client-side pseudo-ETag.
 */

import { api } from "@/lib/api";

const EXPORT_RETENTION_PATH = "/api/v1/exports/retention-policy";
const WEBHOOK_ALERT_PREFS_PATH = "/api/v1/webhooks/alert-prefs";

export const EXPORT_RETENTION_DAYS_MIN = 7;
export const EXPORT_RETENTION_DAYS_MAX = 2_555;
export const EXPORT_RETENTION_COUNT_MIN = 1;
export const EXPORT_RETENTION_COUNT_MAX = 500;

export class WorkspaceSettingContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSettingContractError";
  }
}

export interface ExportRetentionPolicy {
  retentionDays: number;
  maxPerTenant: number;
  currentStorageBytes: number;
  updatedAt: string;
}

export interface ExportRetentionPolicyInput {
  retentionDays: number;
  maxPerTenant: number;
}

export interface WebhookOwnerEmailPreference {
  userId: string;
  tenantId: string;
  notifyAutoDisabled: boolean;
  /** Compatibility fields must be round-tripped because PUT is replacement. */
  notifyFailureRate: boolean;
  failureRatePct: number;
  notifyLatency: boolean;
  latencyMs: number;
  lastAlertedAt: string | null;
  updatedAt: string;
}

interface ReadOptions {
  signal?: AbortSignal;
  /** Refuse offline cache/replay and retry only at the explicit call site. */
  fresh?: boolean;
}

export async function getExportRetentionPolicy(
  options: ReadOptions = {},
): Promise<ExportRetentionPolicy> {
  const response = await api.get<unknown>(
    EXPORT_RETENTION_PATH,
    readOptions(options),
  );
  return parseExportRetentionPolicy(response);
}

export async function updateExportRetentionPolicy(
  input: ExportRetentionPolicyInput,
  options: { signal?: AbortSignal } = {},
): Promise<ExportRetentionPolicy> {
  const retentionDays = boundedInteger(
    input.retentionDays,
    "retentionDays",
    EXPORT_RETENTION_DAYS_MIN,
    EXPORT_RETENTION_DAYS_MAX,
  );
  const maxPerTenant = boundedInteger(
    input.maxPerTenant,
    "maxPerTenant",
    EXPORT_RETENTION_COUNT_MIN,
    EXPORT_RETENTION_COUNT_MAX,
  );
  const response = await api.patch<unknown>(
    EXPORT_RETENTION_PATH,
    {
      retention_days: retentionDays,
      max_per_tenant: maxPerTenant,
    },
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  return parseExportRetentionPolicy(response);
}

export function parseExportRetentionPolicy(
  value: unknown,
): ExportRetentionPolicy {
  const policy = record(value, "export retention response");
  return {
    retentionDays: boundedInteger(
      policy.retention_days,
      "retention_days",
      EXPORT_RETENTION_DAYS_MIN,
      EXPORT_RETENTION_DAYS_MAX,
    ),
    maxPerTenant: boundedInteger(
      policy.max_per_tenant,
      "max_per_tenant",
      EXPORT_RETENTION_COUNT_MIN,
      EXPORT_RETENTION_COUNT_MAX,
    ),
    currentStorageBytes: boundedInteger(
      policy.current_storage_bytes,
      "current_storage_bytes",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    updatedAt: timestamp(policy.updated_at, "updated_at"),
  };
}

/**
 * `currentStorageBytes` is live evidence, not policy state, so a background
 * export completing must not create a false edit conflict.
 */
export function sameExportRetentionRevision(
  baseline: ExportRetentionPolicy,
  fresh: ExportRetentionPolicy,
): boolean {
  return (
    baseline.retentionDays === fresh.retentionDays &&
    baseline.maxPerTenant === fresh.maxPerTenant &&
    baseline.updatedAt === fresh.updatedAt
  );
}

export async function getWebhookOwnerEmailPreference(
  options: ReadOptions = {},
): Promise<WebhookOwnerEmailPreference> {
  const response = await api.get<unknown>(
    WEBHOOK_ALERT_PREFS_PATH,
    readOptions(options),
  );
  return parseWebhookOwnerEmailPreference(response);
}

export async function updateWebhookOwnerEmailPreference(
  preference: WebhookOwnerEmailPreference,
  notifyAutoDisabled: boolean,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (typeof notifyAutoDisabled !== "boolean") {
    throw contract("notifyAutoDisabled must be a boolean");
  }
  // Validate the entire source row before reflecting its compatibility fields
  // back to a replacement-only endpoint. This prevents a malformed read from
  // being normalized into a destructive overwrite.
  const source = parseWebhookOwnerEmailPreference({
    user_id: preference.userId,
    tenant_id: preference.tenantId,
    notify_auto_disabled: preference.notifyAutoDisabled,
    notify_failure_rate: preference.notifyFailureRate,
    failure_rate_pct: preference.failureRatePct,
    notify_latency: preference.notifyLatency,
    latency_ms: preference.latencyMs,
    last_alerted_at: preference.lastAlertedAt,
    updated_at: preference.updatedAt,
  });
  const response = record(
    await api.put<unknown>(
      WEBHOOK_ALERT_PREFS_PATH,
      {
        notify_auto_disabled: notifyAutoDisabled,
        notify_failure_rate: source.notifyFailureRate,
        failure_rate_pct: source.failureRatePct,
        notify_latency: source.notifyLatency,
        latency_ms: source.latencyMs,
      },
      {
        signal: options.signal,
        requireOnline: true,
        maxAttempts: 1,
      },
    ),
    "webhook notification acknowledgement",
  );
  if (response.ok !== true) {
    throw contract("webhook notification acknowledgement.ok must be true");
  }
}

export function parseWebhookOwnerEmailPreference(
  value: unknown,
): WebhookOwnerEmailPreference {
  const preference = record(value, "webhook notification response");
  return {
    userId: uuid(preference.user_id, "user_id"),
    tenantId: uuid(preference.tenant_id, "tenant_id"),
    notifyAutoDisabled: boolean(
      preference.notify_auto_disabled,
      "notify_auto_disabled",
    ),
    notifyFailureRate: boolean(
      preference.notify_failure_rate,
      "notify_failure_rate",
    ),
    failureRatePct: boundedInteger(
      preference.failure_rate_pct,
      "failure_rate_pct",
      1,
      100,
    ),
    notifyLatency: boolean(preference.notify_latency, "notify_latency"),
    latencyMs: boundedInteger(
      preference.latency_ms,
      "latency_ms",
      1,
      600_000,
    ),
    lastAlertedAt: nullableTimestamp(
      preference.last_alerted_at,
      "last_alerted_at",
    ),
    updatedAt: timestamp(preference.updated_at, "updated_at"),
  };
}

/**
 * Compare every mutable field the replacement PUT would preserve. The GET
 * handler fabricates `updated_at = now()` while no row exists, so timestamp
 * equality would permanently block the first save; equal values are the
 * meaningful best-effort revision in that verified-empty/default state.
 */
export function sameWebhookPreferenceRevision(
  baseline: WebhookOwnerEmailPreference,
  fresh: WebhookOwnerEmailPreference,
): boolean {
  return (
    baseline.userId === fresh.userId &&
    baseline.tenantId === fresh.tenantId &&
    baseline.notifyAutoDisabled === fresh.notifyAutoDisabled &&
    baseline.notifyFailureRate === fresh.notifyFailureRate &&
    baseline.failureRatePct === fresh.failureRatePct &&
    baseline.notifyLatency === fresh.notifyLatency &&
    baseline.latencyMs === fresh.latencyMs
  );
}

function readOptions(options: ReadOptions) {
  return {
    signal: options.signal,
    ...(options.fresh
      ? { requireOnline: true as const, maxAttempts: 1, cache: "no-store" as const }
      : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contract(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw contract(`${label} must be a boolean`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw contract(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function uuid(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      parsed,
    )
  ) {
    throw contract(`${label} must be a UUID`);
  }
  return parsed;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : timestamp(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 128);
  if (Number.isNaN(Date.parse(parsed))) {
    throw contract(`${label} must be a valid timestamp`);
  }
  return parsed;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > max
  ) {
    throw contract(`${label} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

function contract(message: string): WorkspaceSettingContractError {
  return new WorkspaceSettingContractError(message);
}
