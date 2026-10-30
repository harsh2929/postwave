// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client for the audit investigation agent (governance-34..37).
 *
 * Server: apps/api/internal/handlers/audit_investigations.go. Reads are gated
 * on audit:read + audit:read_pii (the pages check that before asking);
 * approve/reject are admin-only. Approval records a human decision only —
 * Moosewave never applies the proposed identity, key, token, MFA, or IP
 * changes — and rejection requires a reason that anyone with audit:read can
 * later see on the investigation.
 *
 * The list/get handlers answer 503 `agent_unavailable` with an EMPTY message
 * when the agent is not wired, so `describeInvestigationError` is the one
 * place that turns that code into a sentence; everywhere else the server's
 * own text is rendered.
 *
 * Mutations are online-only and single-attempt: an approval replayed from the
 * offline outbox would land on a plan someone else may have rejected since.
 */
import { parseErrorEnvelope } from "@postwave/errors";

import { mintStreamToken } from "@/lib/alerting-access-api";
import { api, apiErrorMessage, isApiError } from "@/lib/api";
import type { AuditRow } from "@/lib/audit-api";

const ONLINE_WRITE = { requireOnline: true, maxAttempts: 1 } as const;

export const AUDIT_INVESTIGATION_STATUSES = [
  "draft",
  "approved",
  "rejected",
  "executed",
] as const;
export type AuditInvestigationStatus =
  (typeof AUDIT_INVESTIGATION_STATUSES)[number];

/** One numbered hypothesis. Every finding cites at least one audit_log id. */
export interface AuditInvestigationFinding {
  num: number;
  hypothesis: string;
  mitre_techniques: string[];
  confidence: number;
  evidence_audit_ids: number[];
  detector_reasons?: string[];
}

/** One remediation candidate. `requires_human_approval` is always true. */
export interface AuditInvestigationProposedAction {
  id: string;
  action: string;
  target_id: string;
  rationale: string;
  severity: string;
  requires_human_approval: boolean;
  evidence_audit_ids: number[];
  linked_finding_nums?: number[];
}

/** Persisted investigation, as GET /api/v1/audit/investigations/{id} returns it. */
export interface AuditInvestigation {
  id: string;
  tenant_id: string;
  seed_audit_id: number;
  findings: AuditInvestigationFinding[];
  evidence_audit_ids: number[];
  proposed_actions: AuditInvestigationProposedAction[];
  mitre_techniques: string[];
  confidence: number;
  status: AuditInvestigationStatus;
  approved_at?: string;
  approved_by?: string;
  rejection_reason?: string;
  completed_at?: string;
  executed_at?: string;
  executed_by?: string;
  created_at: string;
  updated_at: string;
}

export interface AuditInvestigationApprovalReceipt {
  id: string;
  status: "approved";
  execution_state: "not_executed";
  /** The server's own statement of what approval did (and did not) do. */
  message: string;
  approval_notes?: string;
}

export interface AuditInvestigationRejectionReceipt {
  id: string;
  status: "rejected";
}

export const INVESTIGATION_LIST_LIMIT = 50;

/** Server-enforced ceiling on GET /api/v1/audit/events?ids= per call. */
export const EVIDENCE_BATCH_SIZE = 100;

export const REJECTION_REASON_REQUIRED =
  "A reason is required to reject this investigation.";

export const INVESTIGATION_AGENT_UNAVAILABLE =
  "The investigation agent is not configured for this workspace, so investigations cannot be read here.";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is AuditInvestigationStatus {
  return (
    typeof value === "string" &&
    (AUDIT_INVESTIGATION_STATUSES as readonly string[]).includes(value)
  );
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((n) => Number.isFinite(n))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Go marshals a nil slice as `null`, and every one of these lists is read
 * with `.length` or `.map` downstream — so normalise here rather than at each
 * call site. Anything without a string id and a known status is not an
 * investigation and is refused rather than rendered half-empty.
 */
function parseInvestigation(value: unknown): AuditInvestigation {
  if (!record(value) || typeof value.id !== "string" || !isStatus(value.status)) {
    throw new Error("The investigation response was invalid.");
  }
  return {
    ...(value as unknown as AuditInvestigation),
    findings: list<AuditInvestigationFinding>(value.findings).map((f) => ({
      ...f,
      mitre_techniques: strings(f.mitre_techniques),
      evidence_audit_ids: numbers(f.evidence_audit_ids),
    })),
    evidence_audit_ids: numbers(value.evidence_audit_ids),
    proposed_actions: list<AuditInvestigationProposedAction>(
      value.proposed_actions,
    ).map((a) => ({ ...a, evidence_audit_ids: numbers(a.evidence_audit_ids) })),
    mitre_techniques: strings(value.mitre_techniques),
    confidence: typeof value.confidence === "number" ? value.confidence : 0,
    status: value.status,
  };
}

/** GET /api/v1/audit/investigations?limit=50 — newest first. */
export async function listAuditInvestigations(
  filters: { status?: AuditInvestigationStatus; limit?: number } = {},
  opts: { signal?: AbortSignal } = {},
): Promise<AuditInvestigation[]> {
  const params = new URLSearchParams();
  params.set("limit", String(filters.limit ?? INVESTIGATION_LIST_LIMIT));
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  const value = await api.get<unknown>(
    `/api/v1/audit/investigations${qs ? `?${qs}` : ""}`,
    opts,
  );
  if (!record(value) || !Array.isArray(value.investigations)) {
    throw new Error("The investigations response was invalid.");
  }
  return value.investigations.map(parseInvestigation);
}

/** GET /api/v1/audit/investigations/{id}. */
export async function getAuditInvestigation(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditInvestigation> {
  const value = await api.get<unknown>(
    `/api/v1/audit/investigations/${encodeURIComponent(id)}`,
    opts,
  );
  return parseInvestigation(value);
}

/**
 * POST /api/v1/audit/investigations/{id}/approve — admin only.
 *
 * The whole plan or nothing: the server refuses `action_ids`, so this client
 * never offers a per-action approval it would have to fake.
 */
export function approveAuditInvestigation(
  id: string,
  input: { notes?: string } = {},
  opts: { signal?: AbortSignal } = {},
): Promise<AuditInvestigationApprovalReceipt> {
  return api.post<AuditInvestigationApprovalReceipt>(
    `/api/v1/audit/investigations/${encodeURIComponent(id)}/approve`,
    { notes: input.notes?.trim() ?? "" },
    { ...ONLINE_WRITE, ...opts },
  );
}

/** The validation the reject dialog shows inline, and the request refuses on. */
export function rejectionReasonError(reason: string): string | null {
  return reason.trim() ? null : REJECTION_REASON_REQUIRED;
}

/**
 * POST /api/v1/audit/investigations/{id}/reject — admin only. The server
 * answers 400 `reason_required` for a blank reason; refusing it here means
 * the dialog never sends a request it knows will be rejected.
 */
export async function rejectAuditInvestigation(
  id: string,
  reason: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AuditInvestigationRejectionReceipt> {
  const error = rejectionReasonError(reason);
  if (error) throw new Error(error);
  return api.post<AuditInvestigationRejectionReceipt>(
    `/api/v1/audit/investigations/${encodeURIComponent(id)}/reject`,
    { reason: reason.trim() },
    { ...ONLINE_WRITE, ...opts },
  );
}

/** Deduplicated ≤`size`-id chunks for the batch evidence lookup. */
export function chunkEvidenceIds(
  ids: readonly number[],
  size: number = EVIDENCE_BATCH_SIZE,
): number[][] {
  const unique = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))];
  const out: number[][] = [];
  for (let i = 0; i < unique.length; i += size) {
    out.push(unique.slice(i, i + size));
  }
  return out;
}

/**
 * GET /api/v1/audit/events?ids=1,2,3 — batch lookup of cited audit rows, same
 * wire shape as the audit log list. Rows the tenant does not own, or that
 * retention trimmed, are simply absent; callers diff against what they asked
 * for. Unlike the log list this endpoint does NOT hide `audit.read.*` meta
 * rows, which is exactly what an exfiltration investigation cites.
 */
export async function getAuditEventsByIds(
  ids: readonly number[],
  opts: { signal?: AbortSignal } = {},
): Promise<AuditRow[]> {
  if (ids.length === 0) return [];
  if (ids.length > EVIDENCE_BATCH_SIZE) {
    throw new Error(
      `getAuditEventsByIds accepts at most ${EVIDENCE_BATCH_SIZE} ids per call.`,
    );
  }
  const params = new URLSearchParams();
  params.set("ids", ids.map(String).join(","));
  const qs = params.toString();
  const value = await api.get<unknown>(
    `/api/v1/audit/events${qs ? `?${qs}` : ""}`,
    opts,
  );
  if (!record(value) || !Array.isArray(value.items)) {
    throw new Error("The audit event detail response was invalid.");
  }
  return value.items as AuditRow[];
}

/** Same-origin path of the per-investigation SSE feed. */
export function auditInvestigationStreamPath(id: string): string {
  return `/api/v1/audit/investigations/${encodeURIComponent(id)}/stream`;
}

/**
 * URL for `new EventSource(...)`. Carries a short-lived `stream_token` the
 * way desktop's buildStreamUrl does — the server allowlists exactly this path
 * for token auth, and it is what lets the stream open from a context without
 * a session cookie. Cookie auth is the documented fallback (the middleware
 * ignores the token whenever a cookie already resolved the tenant), so a
 * failed mint degrades to the same-origin URL every other web stream uses;
 * if that cannot connect either, the stream's onerror falls back to polling,
 * which the page shows rather than hides.
 */
export async function auditInvestigationStreamUrl(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  const path = auditInvestigationStreamPath(id);
  try {
    const token = await mintStreamToken(opts);
    return `${path}?stream_token=${encodeURIComponent(token.token)}`;
  } catch {
    return path;
  }
}

/**
 * The sentence to show for a failed investigation read or decision. The
 * server's message wins whenever it sent one; the 503 `agent_unavailable`
 * refusal from list/get carries none, and "GET … failed: 503" is not an
 * explanation an operator can act on.
 */
export function describeInvestigationError(
  err: unknown,
  fallback: string,
): string {
  if (isApiError(err) && err.code === "agent_unavailable") {
    const server = parseErrorEnvelope(err.body).message;
    return server || INVESTIGATION_AGENT_UNAVAILABLE;
  }
  return apiErrorMessage(err, fallback);
}
