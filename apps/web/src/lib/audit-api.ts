// SPDX-License-Identifier: AGPL-3.0-only
//
// Read-side client for the tenant audit log. Backend handlers:
// apps/api/internal/handlers/audit.go (List) and audit_chain.go (AuditChain).
// Cursor pagination uses descending id; pass nextCursor back as ?cursor= to
// continue.

import { api } from "@/lib/api";

const AUDIT_SECRET_KEY_RE =
  /^(?:authorization|cookie|set_cookie|password|passwd|secret|token|api_token|auth_token|api_key|apikey|access_key|secret_access_key|client_secret|private_key|credential|credentials|routing_key|hmac_secret|bearer_token)$/iu;
const AUDIT_SECRET_VALUE_RE = /^(?:bearer|basic)\s+[a-z0-9._~+/=-]+$/iu;
const MAX_AUDIT_METADATA_DEPTH = 6;
const MAX_AUDIT_METADATA_KEYS = 200;
const MAX_AUDIT_METADATA_ARRAY = 100;
const MAX_AUDIT_METADATA_STRING = 2_048;

export interface AuditRow {
  id: number;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  actorType: string;
  actorLabel?: string | null;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata: Record<string, unknown>;
  at: string;
}

export interface AuditPage {
  rows: AuditRow[];
  nextCursor?: string;
}

export interface AuditFilters {
  actorType?: string;
  actorLabel?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Secret-safe, bounded view of an audit metadata object.
 *
 * Audit rows are server-authored, but some metadata originates in provider
 * responses and request diagnostics. Rendering the raw object can therefore
 * expose an echoed credential or make one row allocate an unbounded DOM tree.
 * This function preserves useful forensic structure while redacting known
 * credential fields and truncating overly large values.
 */
export function redactAuditMetadata(
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!metadata) return {};
  const seen = new WeakSet<object>();
  const sanitized = sanitizeAuditValue(metadata, 0, seen);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};
}

function sanitizeAuditValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_AUDIT_METADATA_DEPTH) return "[depth limit]";
  if (typeof value === "string") {
    if (AUDIT_SECRET_VALUE_RE.test(value.trim())) return "[redacted]";
    return value.length > MAX_AUDIT_METADATA_STRING
      ? `${value.slice(0, MAX_AUDIT_METADATA_STRING)}…[truncated]`
      : value;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result = value
      .slice(0, MAX_AUDIT_METADATA_ARRAY)
      .map((item) => sanitizeAuditValue(item, depth + 1, seen));
    if (value.length > MAX_AUDIT_METADATA_ARRAY) result.push("[truncated]");
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, MAX_AUDIT_METADATA_KEYS)) {
      const normalized = key.trim().replaceAll("-", "_");
      output[key] = AUDIT_SECRET_KEY_RE.test(normalized)
        ? "[redacted]"
        : sanitizeAuditValue(child, depth + 1, seen);
    }
    if (entries.length > MAX_AUDIT_METADATA_KEYS) {
      output["__truncated__"] = `${entries.length - MAX_AUDIT_METADATA_KEYS} more fields`;
    }
    return output;
  }
  return String(value).slice(0, MAX_AUDIT_METADATA_STRING);
}

export function listAuditLog(
  filters: AuditFilters = {},
  opts: { signal?: AbortSignal } = {},
): Promise<AuditPage> {
  const params = new URLSearchParams();
  if (filters.actorType) params.set("actor_type", filters.actorType);
  if (filters.actorLabel) params.set("actor_label", filters.actorLabel);
  if (filters.action) params.set("action", filters.action);
  if (filters.resourceType) params.set("resource_type", filters.resourceType);
  if (filters.resourceId) params.set("resource_id", filters.resourceId);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return api.get<AuditPage>(`/api/v1/audit${qs ? `?${qs}` : ""}`, opts);
}

/**
 * The row-count for a filter set, as GET /api/v1/audit/count reports it.
 *
 * `confidence` is the server's own word for how the number was obtained:
 * "exact" is a real COUNT(*); "approximate" is the planner's estimate for a
 * window too large to count cheaply. Render the distinction ("~2,400") rather
 * than flattening both into a number that reads as precise.
 */
export interface AuditCount {
  totalEstimate: number;
  confidence: "exact" | "approximate";
}

/**
 * Count the rows a filter set matches without materialising them.
 *
 * Sends only the parameters the count handler reads (handlers/audit_paging.go
 * Count). `until`, `limit` and `cursor` are list-paging concerns the server
 * ignores here, so they are left off rather than sent as dead weight — like
 * stats, the count always describes the whole filtered window from `since`.
 */
export function countAuditLog(
  filters: AuditFilters = {},
  opts: { signal?: AbortSignal } = {},
): Promise<AuditCount> {
  const params = new URLSearchParams();
  if (filters.actorType) params.set("actor_type", filters.actorType);
  if (filters.actorLabel) params.set("actor_label", filters.actorLabel);
  if (filters.action) params.set("action", filters.action);
  if (filters.resourceType) params.set("resource_type", filters.resourceType);
  if (filters.resourceId) params.set("resource_id", filters.resourceId);
  if (filters.since) params.set("since", filters.since);
  const qs = params.toString();
  return api.get<AuditCount>(
    `/api/v1/audit/count${qs ? `?${qs}` : ""}`,
    opts,
  );
}

/**
 * One row of a correlation chain. Deliberately narrower than AuditRow: the
 * chain endpoint omits the feed's per-row affordances (legal hold, retention
 * override, AIVS bundles) because it does not support them.
 *
 * Optionality mirrors the Go `omitempty` tags on handlers.audit_chain.go
 * exactly — `resourceType` and `at` are always present, everything else can be
 * absent from the JSON rather than null. `metadata` is `omitempty` on a map,
 * so an empty payload arrives as an ABSENT key, not `{}`.
 */
export interface AuditChainRow {
  id: number;
  action: string;
  resourceType: string;
  resourceId?: string;
  actorType?: string;
  actorLabel?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

export interface AuditChain {
  requestId: string;
  /**
   * ASCENDING by id — the server orders a chain as a narrative (what happened,
   * then what happened next), unlike the reverse-chronological feed. Render in
   * the order received; re-sorting descending would make the causal chain read
   * backwards.
   */
  rows: AuditChainRow[];
  /**
   * The server hit its 500-row cap. Stated rather than inferred, so a reader
   * is not left guessing whether the chain ended or was cut off.
   */
  truncated: boolean;
}

/**
 * The chain of audit rows written by one request.
 *
 * An id that audited nothing returns 200 with `rows: []` — that is an answer
 * ("nothing was audited under this request"), not a failure, and callers must
 * not render it as an error.
 */
/**
 * Whether a string is worth asking the chain endpoint about.
 *
 * The server refuses two values with a 422 — the empty string, and the "-"
 * sentinel that `audit.Emit` writes for "no correlation" — and a caller that
 * sends either gets an error where it expected a chain. Worse, a UI that opens
 * a dialog first and discovers the refusal second shows an empty chain for a
 * moment, which reads as "this request touched nothing": a confident wrong
 * answer to the only question the endpoint answers.
 *
 * Checked here rather than at each call site so the pasted-id form and any
 * future entry point refuse the same two values for the same reason.
 */
export function isTraceableRequestId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "-";
}

export function getAuditChain(
  requestId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditChain> {
  // Encoded: chi request ids embed the host name (`web-01/AbC123-7`), so the
  // slash would otherwise split into an extra path segment and miss the route.
  return api.get<AuditChain>(
    `/api/v1/audit/chain/${encodeURIComponent(requestId)}`,
    opts,
  );
}

/**
 * The request id that ties this row to the others written by the same request,
 * or null when the row carries none.
 *
 * Rows written outside a request (workers, queue consumers) have no correlation
 * id at all, so the affordance must be conditional — offering "view the chain"
 * on a row that has none would open an empty screen every time.
 */
export function correlationIdOf(
  row: Pick<AuditRow, "metadata"> | Pick<AuditChainRow, "metadata">,
): string | null {
  const context = (row.metadata as Record<string, unknown> | undefined)?.[
    "context"
  ];
  if (typeof context !== "object" || context === null) return null;
  const id = (context as Record<string, unknown>)["correlation_id"];
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  // "-" is refused by the endpoint (it would otherwise match every row that
  // lacks the field), so a row carrying it has no chain that can be opened.
  if (!trimmed || trimmed === "-") return null;
  return trimmed;
}

export function auditExportPath(filters: AuditFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.actorType) params.set("actor_type", filters.actorType);
  if (filters.actorLabel) params.set("actor_label", filters.actorLabel);
  if (filters.action) params.set("action", filters.action);
  if (filters.resourceType) params.set("resource_type", filters.resourceType);
  if (filters.resourceId) params.set("resource_id", filters.resourceId);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  // Keep browser-triggered exports intentionally smaller than the server's
  // 100k hard ceiling. A caller may choose a lower bound, never a higher one.
  const requestedLimit = Number.isSafeInteger(filters.limit)
    ? Number(filters.limit)
    : 10_000;
  params.set("limit", String(Math.min(10_000, Math.max(1, requestedLimit))));
  params.set("include_manifest", "true");
  return `/api/v1/audit/export?${params.toString()}`;
}
