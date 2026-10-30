/**
 * lib/auditInvestigations.ts — the AI investigation queue's vocabulary.
 *
 * Import-free (node-testable). Read off apps/api/internal/handlers/
 * audit_investigations.go, apps/api/internal/audit/agent/store.go and
 * apps/api/internal/server/audit_operations.go:79-83. NOT off openapi.json.
 *
 * WHAT THIS SUBSYSTEM ACTUALLY IS, because the name oversells it and getting
 * the copy wrong here would be a genuine safety problem:
 *
 *   The investigator agent reads an audit row, correlates a window around it,
 *   and emits FINDINGS (hypotheses, each of which MUST cite at least one
 *   audit_log id — `Result.Validate`, enforced twice) plus PROPOSED ACTIONS
 *   (disable this key, force MFA on that user…).
 *
 *   APPROVING DOES NOT EXECUTE ANYTHING. The handler says so in its own
 *   doc comment (audit_investigations.go:194) and in the response body:
 *   `execution_state: "not_executed"` and "Moosewave did not apply account
 *   changes". `Store.Approve` only flips status draft→approved. A mobile
 *   button labelled "Approve" beside a list of account-disabling actions,
 *   with no such disclosure, would let an approver believe they had contained
 *   an incident when they had merely filed a decision. Every copy string
 *   below carries that.
 *
 * THREE MORE FACTS THE UI DEPENDS ON:
 *
 *  1. ONLY `draft` IS DECIDABLE. Both `Store.Approve` and `Store.Reject`
 *     update `WHERE id = $1 AND status = 'draft'` and the handlers translate
 *     a zero rowcount into 409. So approved / rejected / executed rows are
 *     read-only, and offering a button on them can only produce a conflict.
 *  2. REJECTION REQUIRES A REASON. `reason == ""` is a 400 `reason_required`
 *     (audit_investigations.go:290) — validated client-side so the operator
 *     is not taught to tap a button that fails.
 *  3. PARTIAL APPROVAL IS EXPLICITLY UNSUPPORTED. Sending `action_ids` gets a
 *     422 `partial_approval_unsupported`: "approve or reject the complete
 *     remediation plan". So the UI must never offer per-action checkboxes.
 */

export type InvestigationStatus = "draft" | "approved" | "rejected" | "executed";

export interface InvestigationFinding {
  num: number;
  hypothesis: string;
  mitre_techniques?: string[];
  confidence?: number;
  evidence_audit_ids?: number[];
  detector_reasons?: string[];
}

export interface InvestigationAction {
  id: string;
  action: string;
  target_id?: string;
  rationale?: string;
  severity?: string;
  requires_human_approval?: boolean;
  evidence_audit_ids?: number[];
  linked_finding_nums?: number[];
}

export interface AuditInvestigation {
  id: string;
  seed_audit_id: number;
  findings: InvestigationFinding[];
  evidence_audit_ids: number[];
  proposed_actions: InvestigationAction[];
  mitre_techniques: string[];
  confidence: number;
  status: InvestigationStatus;
  approved_at?: string | null;
  approved_by?: string;
  rejection_reason?: string;
  executed_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

const STATUSES: readonly InvestigationStatus[] = [
  "draft",
  "approved",
  "rejected",
  "executed",
];

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((v): v is number => typeof v === "number")
    : [];
}

function normalizeFinding(raw: unknown, index: number): InvestigationFinding {
  const f = (raw ?? {}) as Partial<InvestigationFinding>;
  return {
    num: num(f.num, index + 1),
    hypothesis:
      typeof f.hypothesis === "string" && f.hypothesis.trim()
        ? f.hypothesis
        : "(no hypothesis recorded)",
    mitre_techniques: stringArray(f.mitre_techniques),
    confidence: num(f.confidence),
    evidence_audit_ids: numberArray(f.evidence_audit_ids),
    detector_reasons: stringArray(f.detector_reasons),
  };
}

function normalizeAction(raw: unknown, index: number): InvestigationAction {
  const a = (raw ?? {}) as Partial<InvestigationAction>;
  return {
    id: typeof a.id === "string" && a.id ? a.id : `action-${index}`,
    action: typeof a.action === "string" ? a.action : "unknown",
    ...(typeof a.target_id === "string" ? { target_id: a.target_id } : {}),
    ...(typeof a.rationale === "string" ? { rationale: a.rationale } : {}),
    ...(typeof a.severity === "string" ? { severity: a.severity } : {}),
    requires_human_approval: a.requires_human_approval !== false,
    evidence_audit_ids: numberArray(a.evidence_audit_ids),
    linked_finding_nums: numberArray(a.linked_finding_nums),
  };
}

export function normalizeInvestigation(raw: unknown): AuditInvestigation | null {
  if (!raw || typeof raw !== "object") return null;
  const inv = raw as Partial<AuditInvestigation>;
  if (typeof inv.id !== "string" || !inv.id) return null;
  const status = STATUSES.includes(inv.status as InvestigationStatus)
    ? (inv.status as InvestigationStatus)
    : "draft";
  return {
    id: inv.id,
    seed_audit_id: num(inv.seed_audit_id),
    findings: (Array.isArray(inv.findings) ? inv.findings : []).map(
      normalizeFinding,
    ),
    evidence_audit_ids: numberArray(inv.evidence_audit_ids),
    proposed_actions: (Array.isArray(inv.proposed_actions)
      ? inv.proposed_actions
      : []
    ).map(normalizeAction),
    mitre_techniques: stringArray(inv.mitre_techniques),
    confidence: num(inv.confidence),
    status,
    ...(inv.approved_at ? { approved_at: inv.approved_at } : {}),
    ...(inv.approved_by ? { approved_by: inv.approved_by } : {}),
    ...(inv.rejection_reason ? { rejection_reason: inv.rejection_reason } : {}),
    ...(inv.executed_at ? { executed_at: inv.executed_at } : {}),
    ...(inv.created_at ? { created_at: inv.created_at } : {}),
    ...(inv.updated_at ? { updated_at: inv.updated_at } : {}),
  };
}

/** `{investigations: […]}` per the handler; tolerant of a bare array. */
export function normalizeInvestigationList(res: unknown): AuditInvestigation[] {
  const raw = Array.isArray(res)
    ? res
    : ((res as { investigations?: unknown } | null)?.investigations ?? []);
  if (!Array.isArray(raw)) return [];
  const out: AuditInvestigation[] = [];
  for (const entry of raw) {
    const inv = normalizeInvestigation(entry);
    if (inv) out.push(inv);
  }
  return out;
}

/** Only a draft can be decided — everything else 409s. */
export function isInvestigationDecidable(
  inv: Pick<AuditInvestigation, "status"> | null | undefined,
): boolean {
  return inv?.status === "draft";
}

/**
 * Which investigation is worth holding a status stream open for.
 *
 * `GET /audit/investigations/{id}/stream` emits status TRANSITIONS, so a
 * socket on a terminal row can only ever heartbeat: `rejected` and `executed`
 * never change again, and an `approved` row with `executed_at` set has made
 * its last transition. The first still-mutable row in server order (newest
 * first) is the one whose change the sheet is actually waiting on — one
 * socket, not one per row.
 */
export function streamableInvestigationId(
  rows:
    | readonly Pick<AuditInvestigation, "id" | "status" | "executed_at">[]
    | null
    | undefined,
): string | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row.status === "draft") return row.id;
    // An approved row that has EXECUTED has made its last transition — a
    // socket over it can only heartbeat forever.
    if (row.status === "approved" && !row.executed_at) return row.id;
  }
  return null;
}

export function investigationStatusLabel(status: InvestigationStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "executed":
      return "Executed";
    default:
      return "Awaiting review";
  }
}

export function investigationStatusTone(
  status: InvestigationStatus,
): "warning" | "success" | "danger" | "info" {
  switch (status) {
    case "approved":
      return "success";
    case "rejected":
      return "danger";
    case "executed":
      return "info";
    default:
      return "warning";
  }
}

/**
 * Confidence as a percentage string, or an em-dash.
 *
 * The column is a float the agent sets; a MISSING confidence is not 0%
 * confidence — "0% confident" reads as "certainly wrong", which is a strong
 * claim nobody made.
 */
export function investigationConfidenceLabel(
  confidence: number | null | undefined,
): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return "—";
  if (confidence <= 0) return "—";
  const pct = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(Math.min(100, pct))}%`;
}

/** "3 findings · 2 proposed actions · 11 cited events" */
export function investigationSummaryLine(inv: AuditInvestigation): string {
  const parts = [
    `${inv.findings.length} finding${inv.findings.length === 1 ? "" : "s"}`,
    `${inv.proposed_actions.length} proposed action${
      inv.proposed_actions.length === 1 ? "" : "s"
    }`,
  ];
  if (inv.evidence_audit_ids.length > 0) {
    parts.push(
      `${inv.evidence_audit_ids.length} cited event${
        inv.evidence_audit_ids.length === 1 ? "" : "s"
      }`,
    );
  }
  return parts.join(" · ");
}

/**
 * The sentence that has to appear anywhere an approval decision is offered.
 * Not optional, not a tooltip: it is the difference between "I contained the
 * incident" and what actually happened.
 */
export const INVESTIGATION_NO_EXECUTION_NOTE =
  "Approving records a human review decision. Moosewave does NOT apply these account changes — carrying them out is a separate, manual step.";

export interface InvestigationDecisionCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

export function investigationDecisionCopy(
  inv: AuditInvestigation,
  decision: "approve" | "reject",
): InvestigationDecisionCopy {
  const plan = `${inv.proposed_actions.length} proposed action${
    inv.proposed_actions.length === 1 ? "" : "s"
  }`;
  return decision === "approve"
    ? {
        title: "Approve this remediation plan?",
        message: `Marks the complete plan (${plan}) as reviewed and approved. Individual actions cannot be approved separately.`,
        consequence: INVESTIGATION_NO_EXECUTION_NOTE,
        confirmLabel: "Approve plan",
        destructive: false,
      }
    : {
        title: "Reject this remediation plan?",
        message: `Records that the plan (${plan}) was reviewed and declined.`,
        consequence: "This is final — a rejected investigation cannot be re-opened from here.",
        confirmLabel: "Reject plan",
        destructive: true,
      };
}

/** The 409 both decide routes return once a row has left `draft`. */
export function investigationDecisionError(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? Number((err as { status?: unknown }).status) || 0
      : 0;
  switch (status) {
    case 409:
      return "Someone already decided this investigation. Pull to refresh.";
    case 403:
      return "Deciding an investigation is limited to workspace owners and admins.";
    case 422:
      return "The server only accepts a decision on the complete plan.";
    case 503:
      return "The investigation agent is not configured on this workspace.";
    default:
      return "Couldn't record the decision. Nothing was changed.";
  }
}
