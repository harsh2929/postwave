/**
 * lib/flowApprovals.ts — the in-flow `manual_review` queue: what a row means,
 * which rows may still be decided, and the copy for deciding one.
 *
 * Import-free (node-testable), like lib/approvalPolicy and lib/flowWire.
 *
 * READ OFF apps/api/internal/flow_approvals/flow_approvals.go, and off the
 * table's own DDL in infra/migrations/0202_klaviyo_flow_builder_foundation.sql.
 * FIVE facts shape this module; three of them are things a plausible-looking
 * implementation would get wrong.
 *
 *  1. THE DECIDABLE SET IS `requested` OR `marketing`, NOT JUST `requested`.
 *     `Repo.Decide` (:88) updates `WHERE transactional_status IN
 *     ('requested','marketing')` and 409s otherwise. `marketing` is the COLUMN
 *     DEFAULT (migration 0202) rather than a decision, and the engine's own
 *     gate agrees: `PgxApprovalGate.RequestOrCheck` maps both to "pending" in
 *     its `default:` arm (services/automation/internal/runtime/approvals.go).
 *     So a queue that filtered on `requested` alone would hide rows the server
 *     is perfectly willing to decide — and would leave a flow parked forever
 *     with nothing on screen to explain why. `isDecidable` mirrors that SQL
 *     predicate exactly, and it is the single source of the button's presence.
 *
 *  2. THE ROW CANNOT NAME ITS FLOW, AND MUST NOT PRETEND TO. The handler's
 *     `cols` (:44) selects `automation_id` and never `journey_id`, and
 *     `RequestOrCheck` only ever writes `automation_id`. Flow-builder flows
 *     are rows in `automation_journeys` (`flowSelectSQL`, repo.go:541) — a
 *     DIFFERENT table from `automations`. So `automation_id` will not match
 *     any `Flow.id` from `GET /flow-builder/flows`, and joining the two on
 *     screen would attach a stranger's flow name to a review. The row names
 *     the node and the automation id, and says plainly that it cannot resolve
 *     the flow. That is the honest limit of this endpoint.
 *
 *  3. THERE IS NO PAGINATION AND NO LIMIT. `Repo.List` (:52) is a bare
 *     `SELECT … ORDER BY COALESCE(requested_at, created_at) DESC` with no
 *     LIMIT and no cursor — unlike every other list this app consumes. The
 *     screen therefore asks for the PENDING set by status rather than pulling
 *     the tenant's entire decision history down a phone connection, and
 *     partitions what it gets rather than issuing a second request.
 *
 *  4. A DECISION IS FINAL, AND THE ENGINE RESUMES ON ITS OWN CLOCK. Nothing in
 *     the package moves a row back to `requested`; `Decide` stamps
 *     `decided_at` and the parked execution resumes on its NEXT RETRY, not
 *     immediately. So there is no undo to offer and no "resumed" state to
 *     claim — the confirm copy says both.
 *
 *  5. DECIDING IS `editor`, READING IS `viewer`. Both routes are mounted with
 *     `apikeys.RequireScope` — a SCOPE gate, not `requireAdmin`. On the
 *     session path `RequireScope` (apikeys/middleware.go:183) checks
 *     `read:campaigns` against `readOnlyScopes`, which admits ANY
 *     authenticated dashboard user; `write:campaigns` is in `editorWriteScopes`
 *     (:291), so `sessionRoleAllowsScopes` admits owner, admin AND editor.
 *     Hence viewer reads, editor decides — verified in the middleware, not
 *     taken from routeauth/manifest.json.
 */

/** The `transactional_status` CHECK in migration 0202, in full. */
export const APPROVAL_STATUSES = [
  "marketing",
  "requested",
  "approved",
  "rejected",
  "revoked",
] as const;

/**
 * Mirrors `Repo.Decide`'s `IN ('requested','marketing')` — see fact 1. This is
 * the ONLY predicate allowed to decide whether the buttons appear.
 */
export const DECIDABLE_APPROVAL_STATUSES = ["requested", "marketing"] as const;

export type FlowApprovalDecision = "approve" | "reject";

/** One `automation_message_approvals` row, as `flow_approvals.Approval`. */
export interface MobileFlowApproval {
  id: string;
  /** An `automations` id — NOT a flow-builder flow id. See fact 2. */
  automationId: string;
  nodeId: string;
  /** email | sms | push | webhook (the channel CHECK in migration 0202). */
  channel: string;
  messageRef: string;
  transactionalStatus: string;
  requestedAt: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Go's zero `time.Time` is present-but-meaningless; never render it. */
export function approvalTimestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  if (raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

export function parseFlowApproval(value: unknown): MobileFlowApproval | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  return {
    id,
    automationId: str(row["automation_id"]),
    nodeId: str(row["node_id"]),
    channel: str(row["channel"]),
    messageRef: str(row["message_ref"]),
    // An absent status must NOT default to a decidable one: that would render
    // Approve/Reject on a row the server will answer 409 for.
    transactionalStatus: str(row["transactional_status"]),
    requestedAt: approvalTimestamp(row["requested_at"]),
    decidedAt: approvalTimestamp(row["decided_at"]),
    createdAt: approvalTimestamp(row["created_at"]),
  };
}

/**
 * `GET /flow-builder/approvals` answers `{"items":[…]}` — a plain map, NOT a
 * `pagination.Envelope` (fact 3), so there is no `nextCursor` to read. A bare
 * array is accepted for one line because envelope drift silently emptying a
 * mobile screen is this codebase's most common failure class.
 */
export function parseFlowApprovalList(payload: unknown): MobileFlowApproval[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["items"])
      ? (record(payload)["items"] as unknown[])
      : [];
  return source
    .map(parseFlowApproval)
    .filter((row): row is MobileFlowApproval => row !== null);
}

/** Exactly `Repo.Decide`'s WHERE clause. See fact 1. */
export function isDecidable(approval: MobileFlowApproval): boolean {
  return (DECIDABLE_APPROVAL_STATUSES as readonly string[]).includes(
    approval.transactionalStatus,
  );
}

export interface ApprovalPartition {
  pending: MobileFlowApproval[];
  decided: MobileFlowApproval[];
}

/**
 * Splits on the SAME predicate the server writes with, so "you can act on
 * this" on screen and "I will accept this" in SQL can never disagree.
 */
export function partitionApprovals(
  approvals: readonly MobileFlowApproval[],
): ApprovalPartition {
  const pending: MobileFlowApproval[] = [];
  const decided: MobileFlowApproval[] = [];
  for (const approval of approvals) {
    if (isDecidable(approval)) pending.push(approval);
    else decided.push(approval);
  }
  return { pending, decided };
}

export interface ApprovalStatusPresentation {
  label: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
  spoken: string;
}

export function approvalStatusPresentation(
  status: string,
): ApprovalStatusPresentation {
  switch (status) {
    case "requested":
      return {
        label: "Awaiting review",
        tone: "warning",
        spoken: "Awaiting review. The flow is parked at this step.",
      };
    case "marketing":
      // Fact 1: the column default. It is pending to the engine, so it is
      // pending here — but saying "Awaiting review" would imply the gate
      // deliberately asked for one, and it did not.
      return {
        label: "Not yet requested",
        tone: "neutral",
        spoken:
          "This row still carries the default status, which the engine treats as pending. It can be decided.",
      };
    case "approved":
      return {
        label: "Approved",
        tone: "success",
        spoken: "Approved. The step was allowed to run.",
      };
    case "rejected":
      return {
        label: "Rejected",
        tone: "danger",
        spoken: "Rejected. This branch of the flow ended here.",
      };
    case "revoked":
      return {
        label: "Revoked",
        tone: "danger",
        spoken: "Revoked. A previous decision was withdrawn.",
      };
    default:
      return {
        label: status || "Unknown",
        tone: "neutral",
        spoken: `Status ${status || "unknown"}, which this app does not recognise.`,
      };
  }
}

export function approvalChannelLabel(channel: string): string {
  switch (channel) {
    case "email":
      return "Email";
    case "sms":
      return "SMS";
    case "push":
      return "Push";
    case "webhook":
      return "Webhook";
    default:
      return channel || "Unknown channel";
  }
}

export interface DecisionCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

/**
 * Both verbs get a real confirm sheet because neither has an undo (fact 4),
 * and the copy states the two things an operator cannot see from the row: that
 * the decision is final, and that resumption is on the engine's retry clock
 * rather than instant.
 */
export function decisionCopy(
  approval: MobileFlowApproval,
  decision: FlowApprovalDecision,
): DecisionCopy {
  const step = approval.nodeId || "this step";
  if (decision === "approve") {
    return {
      title: "Approve this step?",
      message: `The flow parked at “${step}” will be allowed to continue past it.`,
      consequence:
        "There is no undo — no endpoint returns a decided review to pending. The parked run resumes on its next retry, not immediately.",
      confirmLabel: "Approve",
      destructive: false,
    };
  }
  return {
    title: "Reject this step?",
    message: `The flow parked at “${step}” will not run it.`,
    consequence:
      "There is no undo — no endpoint returns a decided review to pending. This branch of the flow ends here for the subscribers waiting on it.",
    confirmLabel: "Reject",
    destructive: true,
  };
}

export function decisionSuccessMessage(
  decision: FlowApprovalDecision,
): string {
  return decision === "approve"
    ? "Approved. The parked run resumes on its next retry."
    : "Rejected. This branch ends here.";
}

/**
 * `decide` answers 409 `not_pending` when the row was decided by someone else
 * between the list load and the tap — the single most likely failure on a
 * shared queue, and one a generic "something went wrong" would leave the
 * operator retrying forever.
 */
export function decisionErrorMessage(error: unknown): string {
  const tagged = error as { status?: number; code?: string; message?: string };
  if (tagged?.status === 409 || tagged?.code === "not_pending") {
    return "Already decided by someone else. Pull to refresh to see who.";
  }
  if (tagged?.status === 403) {
    return "Deciding a review needs an editor role or higher.";
  }
  const message = typeof tagged?.message === "string" ? tagged.message : "";
  return message || "That didn't go through. Try again.";
}
