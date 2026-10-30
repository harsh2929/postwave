import type { IntelligentRetryEvent } from "../../lib/api-client";

const MAX_ROWS = 10_000;
const MAX_TEXT = 8_192;
const INTELLIGENT_RETRY_STATUSES = new Set([
  "pending",
  "ready",
  "retrying",
  "retried",
  "failed",
  "dismissed",
]);

export interface SpamTrapStats {
  hits_last_30_days: number;
  blocklisted_count: number;
  eligible_now: number;
  observed_at: string;
}

export interface SpamTrapHitEvidence {
  masked_email: string;
  first_hit_at: string;
  last_hit_at: string;
  hit_count: number;
  row_key: string;
}

export interface SpamTrapRunReceipt {
  blocklisted: number;
  completed_at: string;
}

export interface SoftBounceStats {
  disabled_count: number;
  eligible_now: number;
  eligible_suppressions_now: number;
  recovery_window_days: number;
  automatic_reactivation_active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT &&
    value.trim().length > 0
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T/.test(value)
  );
}

function maskEmail(value: string): string | null {
  const normalized = value.trim();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const visible = local.slice(0, 1);
  return `${visible}${"•".repeat(Math.min(Math.max(local.length - 1, 3), 8))}@${domain}`;
}

export function parseSpamTrapStats(value: unknown): SpamTrapStats | null {
  if (!isRecord(value)) return null;
  if (
    !isCount(value.hits_last_30_days) ||
    !isCount(value.blocklisted_count) ||
    !isCount(value.eligible_now) ||
    !isTimestamp(value.observed_at)
  ) {
    return null;
  }
  return {
    hits_last_30_days: value.hits_last_30_days,
    blocklisted_count: value.blocklisted_count,
    eligible_now: value.eligible_now,
    observed_at: value.observed_at,
  };
}

export function parseSoftBounceStats(value: unknown): SoftBounceStats | null {
  if (!isRecord(value)) return null;
  if (
    !isCount(value.disabled_count) ||
    !isCount(value.eligible_now) ||
    !isCount(value.eligible_suppressions_now) ||
    typeof value.automatic_reactivation_active !== "boolean" ||
    typeof value.recovery_window_days !== "number" ||
    !Number.isSafeInteger(value.recovery_window_days) ||
    (value.recovery_window_days as number) <= 0
  ) {
    return null;
  }
  return {
    disabled_count: value.disabled_count,
    eligible_now: value.eligible_now,
    eligible_suppressions_now: value.eligible_suppressions_now,
    recovery_window_days: value.recovery_window_days as number,
    automatic_reactivation_active: value.automatic_reactivation_active,
  };
}

function parseSpamTrapHit(
  value: unknown,
  index: number,
): SpamTrapHitEvidence | null {
  if (!isRecord(value)) return null;
  const maskedEmail =
    typeof value.email === "string" ? maskEmail(value.email) : null;
  if (
    !maskedEmail ||
    !isTimestamp(value.first_hit_at) ||
    !isTimestamp(value.last_hit_at) ||
    !isCount(value.hit_count)
  ) {
    return null;
  }
  if (
    (value.subscriber_id !== undefined &&
      typeof value.subscriber_id !== "string") ||
    (value.status !== undefined && typeof value.status !== "string")
  ) {
    return null;
  }
  return {
    masked_email: maskedEmail,
    first_hit_at: value.first_hit_at,
    last_hit_at: value.last_hit_at,
    hit_count: value.hit_count,
    row_key:
      typeof value.subscriber_id === "string" && value.subscriber_id.length > 0
        ? value.subscriber_id
        : `${index}:${maskedEmail}:${value.last_hit_at}`,
  };
}

export function parseSpamTrapHits(
  value: unknown,
): SpamTrapHitEvidence[] | null {
  if (!isRecord(value) || !Array.isArray(value.hits) || !isCount(value.count)) {
    return null;
  }
  if (value.hits.length > MAX_ROWS || value.count !== value.hits.length) {
    return null;
  }
  const hits: SpamTrapHitEvidence[] = [];
  for (const [index, candidate] of value.hits.entries()) {
    const hit = parseSpamTrapHit(candidate, index);
    if (!hit) return null;
    hits.push(hit);
  }
  return hits;
}

export function parseSpamTrapRunReceipt(
  value: unknown,
): SpamTrapRunReceipt | null {
  if (
    !isRecord(value) ||
    !isCount(value.blocklisted) ||
    !isTimestamp(value.completed_at)
  ) {
    return null;
  }
  return {
    blocklisted: value.blocklisted,
    completed_at: value.completed_at,
  };
}

export function parseRunCount(
  value: unknown,
  key: "blocklisted" | "recovered",
): number | null {
  if (!isRecord(value) || !isCount(value[key])) return null;
  return value[key];
}

export function parseSoftBounceCleanupCount(value: unknown): number | null {
  if (
    !isRecord(value) ||
    !isCount(value.recovered) ||
    value.recovered !== 0 ||
    !isCount(value.expired_suppressions)
  ) {
    return null;
  }
  return value.expired_suppressions;
}

export function parseIntelligentRetryEvents(
  value: unknown,
  expectedTenantID: string,
): IntelligentRetryEvent[] | null {
  const tenantID = expectedTenantID.trim();
  if (
    tenantID.length === 0 ||
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ROWS ||
    !value.items.every((item) => isIntelligentRetryEvent(item, tenantID))
  ) {
    return null;
  }
  return value.items as IntelligentRetryEvent[];
}

export function parseIntelligentRetryEvent(
  value: unknown,
  expectedTenantID: string,
): IntelligentRetryEvent | null {
  return isIntelligentRetryEvent(value, expectedTenantID.trim())
    ? (value as IntelligentRetryEvent)
    : null;
}

function isIntelligentRetryEvent(
  value: unknown,
  expectedTenantID: string,
): boolean {
  if (!expectedTenantID || !isRecord(value)) return false;
  const breakdown = value.breakdown;
  const validBreakdown =
    breakdown === undefined ||
    (Array.isArray(breakdown) &&
      breakdown.length <= MAX_ROWS &&
      breakdown.every(
        (row) =>
          isRecord(row) &&
          (row.rule_id === undefined || isNonEmptyString(row.rule_id)) &&
          (row.rule_label === undefined || isNonEmptyString(row.rule_label)) &&
          (row.skipped === undefined || isCount(row.skipped)),
      ));
  return (
    isNonEmptyString(value.id) &&
    value.tenant_id === expectedTenantID &&
    isNonEmptyString(value.campaign_id) &&
    isNonEmptyString(value.subscriber_email) &&
    value.reason === "frequency_cap" &&
    isNonEmptyString(value.status) &&
    INTELLIGENT_RETRY_STATUSES.has(value.status) &&
    isNonEmptyString(value.retry_after) &&
    !Number.isNaN(new Date(value.retry_after).getTime()) &&
    isCount(value.attempts) &&
    validBreakdown &&
    isNonEmptyString(value.created_at) &&
    !Number.isNaN(new Date(value.created_at).getTime()) &&
    isNonEmptyString(value.updated_at) &&
    !Number.isNaN(new Date(value.updated_at).getTime())
  );
}
