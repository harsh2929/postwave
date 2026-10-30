/**
 * suppressionContracts — runtime parsers for the suppression write/read
 * surfaces mobile now calls: the per-address audit trail, the 30-day growth
 * trend, and the SMS opt-out table.
 *
 * Same three rules as deliverabilityContracts: coerce numerics, drop malformed
 * rows, throw on an unrecognisable envelope.
 */
import {
  bool,
  itemsOf,
  numberOr,
  str,
  WireShapeError,
} from "./deliverabilityContracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------ audit log --- */

export interface SuppressionAuditEntry {
  id: string;
  action: string;
  reason: string;
  actor: string;
  createdAt: string;
}

export interface SuppressionAuditPage {
  email: string;
  total: number;
  items: SuppressionAuditEntry[];
}

/**
 * `AuditForEmailPaged` is keyed by EMAIL, not by row id, so the trail survives
 * the row's deletion — which is the whole reason the screen is useful after an
 * un-suppress.
 */
export function parseSuppressionAudit(value: unknown): SuppressionAuditPage {
  const rows = itemsOf(value, "suppression audit");
  const items: SuppressionAuditEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const action = str(row.action).trim();
    if (!action) continue;
    items.push({
      id: str(row.id) || `${action}-${str(row.created_at)}`,
      action,
      reason: str(row.reason),
      // The server derives `actor` from user id or api-key id; an automated
      // bounce has neither, and "system" is the honest label for that.
      actor: str(row.actor).trim() || "system",
      createdAt: str(row.created_at),
    });
  }
  const envelope = isRecord(value) ? value : {};
  return {
    email: str(envelope.email),
    total: Math.max(items.length, numberOr(envelope.total, items.length)),
    items,
  };
}

/* ---------------------------------------------------------------- trend --- */

export interface SuppressionTrendPoint {
  date: string;
  count: number;
  byReason: Record<string, number>;
}

export interface SuppressionTrend {
  days: number;
  points: SuppressionTrendPoint[];
  /** Sum over the window — the number the stat row shows. */
  total: number;
  /** Sum over the trailing 7 points, for the "new this week" tile. */
  last7: number;
}

export function parseSuppressionTrend(value: unknown): SuppressionTrend {
  const rows = itemsOf(value, "suppression trend");
  const points: SuppressionTrendPoint[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const date = str(row.date).trim();
    if (!date) continue;
    const byReason: Record<string, number> = {};
    if (isRecord(row.by_reason)) {
      for (const [key, raw] of Object.entries(row.by_reason)) {
        const n = numberOr(raw, 0);
        if (n > 0) byReason[key] = n;
      }
    }
    points.push({ date, count: Math.max(0, numberOr(row.count, 0)), byReason });
  }
  const envelope = isRecord(value) ? value : {};
  const total = points.reduce((sum, point) => sum + point.count, 0);
  const last7 = points.slice(-7).reduce((sum, point) => sum + point.count, 0);
  return {
    days: Math.max(0, numberOr(envelope.days, points.length)),
    points,
    total,
    last7,
  };
}

/** Roll the per-day reason mix up into one ranked list for a bar chart. */
export function trendReasonTotals(
  trend: SuppressionTrend,
): { reason: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const point of trend.points) {
    for (const [reason, count] of Object.entries(point.byReason)) {
      totals.set(reason, (totals.get(reason) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/* ------------------------------------------------------------------ sms --- */

export {
  isReversibleManualSmsSuppression,
  mergeSmsSuppressionPages,
  normalizeSmsSuppressionSearch,
  parseSmsSuppressions,
  SMS_SUPPRESSION_LOCKED_REASON,
  SMS_SUPPRESSION_REASONS,
  SMS_SUPPRESSION_SOURCES,
} from "./smsSuppressionContracts";
export type {
  SmsSuppression,
  SmsSuppressionReason,
  SmsSuppressionsPage,
  SmsSuppressionSource,
} from "./smsSuppressionContracts";

/**
 * E.164 for display: `+15552345678` → `+1 555 234 5678`. Anything that is not
 * a plausible E.164 value comes back untouched — a mangled "pretty" number is
 * worse than a raw one when the operator is comparing it against a ticket.
 */
export function formatE164(raw: string): string {
  const value = raw.trim();
  if (!/^\+\d{8,15}$/.test(value)) return value;
  const digits = value.slice(1);
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  // Generic grouping: country-ish head then 3-digit groups.
  const head = digits.slice(0, digits.length % 3 === 0 ? 3 : digits.length % 3);
  const rest = digits.slice(head.length).match(/.{1,3}/g) ?? [];
  return `+${[head, ...rest].join(" ")}`;
}

/* ---------------------------------------------------------- reputation ---- */

export interface DomainReputation {
  domain: string;
  score: number;
  grade: string;
  sendsLast7d: number;
  bounceRate: number;
  complaintRate: number;
}

export function parseSenderReputation(value: unknown): DomainReputation[] {
  const rows = itemsOf(value, "sender reputation");
  const out: DomainReputation[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const domain = str(row.domain).trim();
    if (!domain) continue;
    out.push({
      domain,
      score: Math.max(0, Math.min(100, numberOr(row.score, 0))),
      grade: str(row.grade),
      sendsLast7d: Math.max(0, numberOr(row.sends_last_7d, 0)),
      bounceRate: numberOr(row.bounce_rate, 0),
      complaintRate: numberOr(row.complaint_rate, 0),
    });
  }
  return out;
}

/* ----------------------------------------------------------- dns health --- */

export interface DnsHealthStatus {
  domain: string;
  verifyState: string;
  spf_verified_at: string | null;
  dkim_verified_at: string | null;
  dmarc_verified_at: string | null;
  lastAttemptAt: string | null;
  lastError: string;
  isStale: boolean;
}

export function parseDnsHealth(value: unknown): DnsHealthStatus[] {
  const rows = itemsOf(value, "DNS health");
  const out: DnsHealthStatus[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const domain = str(row.domain).trim();
    if (!domain) continue;
    out.push({
      domain,
      verifyState: str(row.verify_state),
      spf_verified_at: str(row.spf_verified_at) || null,
      dkim_verified_at: str(row.dkim_verified_at) || null,
      dmarc_verified_at: str(row.dmarc_verified_at) || null,
      lastAttemptAt: str(row.last_attempt_at) || null,
      lastError: str(row.last_error),
      isStale: bool(row.is_stale),
    });
  }
  return out;
}

/** Re-exported so callers need one import for the error type. */
export { WireShapeError };
