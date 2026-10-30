import type {
  BlocklistHit,
  BounceClassBreakdownResponse,
  DeliverabilityHubBreach,
  DeliverabilityHubHistoryResponse,
  DeliverabilityHubSummary,
  DnsHealthStatus,
  WebhookErrorRow,
} from "../lib/api-client";

const MAX_ROWS = 10_000;
const MAX_TEXT = 16_384;
const SAFE_WEBHOOK_FAILURES = new Set([
  "Connection timed out",
  "DNS lookup failed",
  "TLS validation failed",
  "Connection refused",
  "Connection interrupted",
  "Receiver rate limited",
  "Delivery cancelled",
  "Delivery failed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT;
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isSafeNonEmptyString(value: unknown): value is string {
  return isNonEmptyString(value) && !hasControl(value);
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || isString(value);
}

function isOptionalSafeString(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isString(value) && !hasControl(value))
  );
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isTimestamp(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isOptionalRate(value: unknown): boolean {
  return (
    value === undefined || (isFiniteNumber(value) && value >= 0 && value <= 1)
  );
}

function isBreach(value: unknown): value is DeliverabilityHubBreach {
  if (!isRecord(value)) return false;
  if (
    !isString(value.code) ||
    !["info", "warn", "critical"].includes(String(value.severity)) ||
    !isString(value.title) ||
    !isOptionalString(value.detail) ||
    !isOptionalString(value.since) ||
    !isOptionalString(value.metric) ||
    !isOptionalString(value.suggestion) ||
    !isOptionalFiniteNumber(value.threshold) ||
    !isOptionalFiniteNumber(value.observed)
  ) {
    return false;
  }
  if (value.fix_cta === undefined) return true;
  if (!isRecord(value.fix_cta) || !isString(value.fix_cta.label)) return false;
  return (
    isOptionalString(value.fix_cta.href) &&
    isOptionalString(value.fix_cta.section)
  );
}

export function parseDeliverabilitySummary(
  value: unknown,
): DeliverabilityHubSummary | null {
  if (!isRecord(value) || !isRecord(value.totals)) return null;
  if (
    !isFiniteNumber(value.score) ||
    value.score < 0 ||
    value.score > 100 ||
    !isString(value.grade) ||
    !isString(value.status) ||
    !["up", "down", "flat"].includes(String(value.trend)) ||
    !isFiniteNumber(value.trend_delta) ||
    !isOptionalTimestamp(value.trend_reference_at) ||
    !Array.isArray(value.history) ||
    value.history.length > MAX_ROWS ||
    !value.history.every(
      (score) => isFiniteNumber(score) && score >= 0 && score <= 100,
    ) ||
    !Array.isArray(value.breaches) ||
    value.breaches.length > MAX_ROWS ||
    !value.breaches.every(isBreach) ||
    !isOptionalString(value.tenant_id) ||
    !isOptionalRate(value.bounce_rate) ||
    !isOptionalRate(value.complaint_rate) ||
    !isOptionalRate(value.engagement_rate) ||
    !isOptionalFiniteNumber(value.opens_machine_pct) ||
    value.event_rate_scope !== "campaigns" ||
    !isNonEmptyString(value.model_version) ||
    typeof value.sample_qualified !== "boolean" ||
    !isCount(value.minimum_sample_sends) ||
    value.minimum_sample_sends < 1 ||
    !isOptionalString(value.sample_reason) ||
    (value.window_days !== undefined && !isCount(value.window_days)) ||
    !isOptionalRecord(value.dns_health) ||
    (value.blocklist_hits !== undefined &&
      (!Array.isArray(value.blocklist_hits) ||
        value.blocklist_hits.length > MAX_ROWS ||
        !value.blocklist_hits.every(isBlocklistHit))) ||
    typeof value.auto_throttled !== "boolean" ||
    !isOptionalString(value.auto_throttle_reason) ||
    !isCount(value.totals.sends_7d) ||
    !isCount(value.totals.sends_30d) ||
    !isTimestamp(value.computed_at)
  ) {
    return null;
  }
  return value as unknown as DeliverabilityHubSummary;
}

export function parseDeliverabilityHistory(
  value: unknown,
): DeliverabilityHubHistoryResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length > MAX_ROWS ||
    !isCount(value.window_days) ||
    !isCount(value.count) ||
    value.count !== value.snapshots.length ||
    !isNonEmptyString(value.model_version)
  ) {
    return null;
  }
  for (const snapshot of value.snapshots) {
    if (
      !isRecord(snapshot) ||
      !isTimestamp(snapshot.sampled_at) ||
      !isFiniteNumber(snapshot.score) ||
      snapshot.score < 0 ||
      snapshot.score > 100 ||
      snapshot.model_version !== value.model_version ||
      typeof snapshot.sample_qualified !== "boolean" ||
      !isCount(snapshot.sample_size)
    ) {
      return null;
    }
  }
  return value as unknown as DeliverabilityHubHistoryResponse;
}

function isDnsHealthStatus(value: unknown): value is DnsHealthStatus {
  if (!isRecord(value)) return false;
  if (
    !isSafeNonEmptyString(value.id) ||
    !isSafeNonEmptyString(value.domain) ||
    !["pending", "partial", "verified", "broken"].includes(
      String(value.verify_state),
    ) ||
    typeof value.is_stale !== "boolean" ||
    !Number.isSafeInteger(value.hours_since_last_check) ||
    Number(value.hours_since_last_check) < -1 ||
    !isOptionalTimestamp(value.spf_verified_at) ||
    !isOptionalTimestamp(value.dkim_verified_at) ||
    !isOptionalTimestamp(value.dmarc_verified_at) ||
    !isOptionalTimestamp(value.last_attempt_at) ||
    !isOptionalSafeString(value.last_error)
  ) {
    return false;
  }
  const verifiedLegs = [
    value.spf_verified_at,
    value.dkim_verified_at,
    value.dmarc_verified_at,
  ].filter((timestamp) => typeof timestamp === "string").length;
  switch (value.verify_state) {
    case "verified":
      return verifiedLegs === 3;
    case "partial":
      return verifiedLegs > 0 && verifiedLegs < 3;
    case "pending":
    case "broken":
      return verifiedLegs === 0;
    default:
      return false;
  }
}

export function parseDnsHealthRows(value: unknown): DnsHealthStatus[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.identities) ||
    value.identities.length > MAX_ROWS
  ) {
    return null;
  }
  return value.identities.every(isDnsHealthStatus) ? value.identities : null;
}

function isBlocklistHit(value: unknown): value is BlocklistHit {
  if (!isRecord(value)) return false;
  return (
    isSafeNonEmptyString(value.id) &&
    isSafeNonEmptyString(value.list_name) &&
    isSafeNonEmptyString(value.identifier) &&
    isSafeNonEmptyString(value.identifier_type) &&
    isTimestamp(value.first_seen_at) &&
    isOptionalRate(value.confidence) &&
    (value.tier1 === undefined || typeof value.tier1 === "boolean") &&
    isOptionalSafeString(value.delisting_status) &&
    isOptionalSafeString(value.delist_url)
  );
}

export function parseBlocklistHits(value: unknown): BlocklistHit[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ROWS
  ) {
    return null;
  }
  return value.items.every(isBlocklistHit) ? value.items : null;
}

function sanitizeWebhookOrigin(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isString(value) || hasControl(value)) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    // Origin-only by design: credentials can live in userinfo, path, query,
    // and fragment components, even when their parameter name looks benign.
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function sanitizeWebhookFailure(
  value: unknown,
  statusCode: number | undefined,
): string | undefined {
  if (statusCode !== undefined) {
    return `Receiver returned HTTP ${statusCode}`;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (SAFE_WEBHOOK_FAILURES.has(trimmed)) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (/timeout|timed out|deadline exceeded/u.test(lower))
    return "Connection timed out";
  if (/no such host|dns/u.test(lower)) return "DNS lookup failed";
  if (/tls|x509|certificate/u.test(lower)) return "TLS validation failed";
  if (lower.includes("connection refused")) return "Connection refused";
  if (/connection reset|broken pipe|unexpected eof/u.test(lower))
    return "Connection interrupted";
  if (lower.includes("rate limit")) return "Receiver rate limited";
  if (/cancelled|canceled/u.test(lower)) return "Delivery cancelled";
  return "Delivery failed";
}

function parseWebhookError(value: unknown): WebhookErrorRow | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyString(value.id) ||
    hasControl(value.id) ||
    !isNonEmptyString(value.event) ||
    hasControl(value.event) ||
    !isCount(value.attempt_count) ||
    !isTimestamp(value.last_attempt_at) ||
    (value.status_code !== undefined &&
      (!isCount(value.status_code) ||
        value.status_code < 100 ||
        value.status_code > 599)) ||
    (value.status !== undefined &&
      value.status !== "failed" &&
      value.status !== "retrying")
  ) {
    return null;
  }
  const statusCode =
    typeof value.status_code === "number" ? value.status_code : undefined;
  const url = sanitizeWebhookOrigin(value.url);
  const error = sanitizeWebhookFailure(value.error, statusCode);
  return {
    id: value.id,
    event: value.event,
    attempt_count: value.attempt_count,
    last_attempt_at: value.last_attempt_at,
    ...(url === undefined ? {} : { url }),
    ...(error === undefined ? {} : { error }),
    ...(statusCode === undefined ? {} : { status_code: statusCode }),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
  };
}

export function parseWebhookErrors(value: unknown): WebhookErrorRow[] | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ROWS
  ) {
    return null;
  }
  const rows = value.items.map(parseWebhookError);
  return rows.includes(null) ? null : (rows as WebhookErrorRow[]);
}

export function parseBounceClassBreakdown(
  value: unknown,
): BounceClassBreakdownResponse | null {
  if (
    !isRecord(value) ||
    !isCount(value.window_days) ||
    !isCount(value.total_bounces) ||
    !Array.isArray(value.classes) ||
    value.classes.length > MAX_ROWS
  ) {
    return null;
  }
  for (const entry of value.classes) {
    if (
      !isRecord(entry) ||
      !isString(entry.class_code) ||
      !isString(entry.label) ||
      !isCount(entry.count) ||
      !isFiniteNumber(entry.share) ||
      entry.share < 0 ||
      entry.share > 1
    ) {
      return null;
    }
  }
  return value as unknown as BounceClassBreakdownResponse;
}
