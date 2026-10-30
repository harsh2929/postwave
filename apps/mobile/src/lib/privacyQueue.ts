/**
 * privacyQueue — the policy behind the tenant DSAR queue.
 *
 * A data-subject request has a STATUTORY CLOCK. "Is anything overdue?" is the
 * only question that matters on a phone, and mobile could not answer it: the
 * settings screen showed the first four rows of an unsorted list, in wire
 * order, with a "+N more on the web admin" footnote — so the one request that
 * blew its GDPR deadline could sit at position 5 forever.
 *
 * Every transition rule below is copied from the Go handlers' own guards, NOT
 * from a doc or a spec, so the app never offers an action the server will 409:
 *
 *   verify  — privacy/workflow.go:137  rejects fulfilled | cancelled | rejected
 *   deny    — privacy/workflow.go:517  rejects fulfilled; 409 if already rejected
 *   appeal  — privacy/workflow.go:606  requires status === "rejected"
 *   hold    — privacy/workflow.go:310  requires a reason; clear is DELETE
 *
 * Pure and import-free so it is testable under the node vitest environment.
 */

/** The subset of the wire row this policy reasons about. */
export interface PrivacyQueueRow {
  request_id: string;
  type: string;
  status: string;
  region: string;
  due_at: string;
  legal_hold?: boolean | undefined;
  subject_email?: string | undefined;
  requested_at?: string | undefined;
  completed_at?: string | undefined;
}

/** Statuses the server treats as finished — the clock has stopped. */
const CLOSED_STATUSES = new Set(["fulfilled", "cancelled", "rejected"]);

export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status.trim().toLowerCase());
}

export type DueState =
  | "overdue"
  | "due_soon"
  | "on_track"
  | "closed"
  /** No parseable due date on the wire. ABSENCE IS NOT ZERO and it is not "ok". */
  | "unknown";

/** Inside this window the deadline is close enough to act on today. */
export const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000;

export function dueState(row: PrivacyQueueRow, nowMs: number): DueState {
  if (isClosedStatus(row.status)) return "closed";
  const due = Date.parse(row.due_at ?? "");
  if (!Number.isFinite(due)) return "unknown";
  if (due <= nowMs) return "overdue";
  if (due - nowMs <= DUE_SOON_MS) return "due_soon";
  return "on_track";
}

/**
 * Whole days remaining, negative when overdue, null when there is no date.
 * Never 0 for "we don't know" — that is the bug this whole surface exists to
 * avoid repeating.
 */
export function daysUntilDue(
  row: PrivacyQueueRow,
  nowMs: number,
): number | null {
  const due = Date.parse(row.due_at ?? "");
  if (!Number.isFinite(due)) return null;
  const day = 24 * 60 * 60 * 1000;
  return Math.floor((due - nowMs) / day);
}

/** The one-line deadline phrase beside a row. */
export function dueLabel(row: PrivacyQueueRow, nowMs: number): string {
  const state = dueState(row, nowMs);
  if (state === "closed") return "Clock stopped";
  const days = daysUntilDue(row, nowMs);
  if (days === null) return "No deadline recorded";
  if (days < 0) {
    const late = Math.abs(days);
    return `Overdue by ${late} ${late === 1 ? "day" : "days"}`;
  }
  if (days === 0) return "Due today";
  return `Due in ${days} ${days === 1 ? "day" : "days"}`;
}

export interface PrivacyQueueSummary {
  total: number;
  open: number;
  overdue: number;
  dueSoon: number;
  onHold: number;
  /** Rows with no parseable deadline — reported, never folded into "on track". */
  undated: number;
}

export function summarizeQueue(
  rows: readonly PrivacyQueueRow[],
  nowMs: number,
): PrivacyQueueSummary {
  const summary: PrivacyQueueSummary = {
    total: rows.length,
    open: 0,
    overdue: 0,
    dueSoon: 0,
    onHold: 0,
    undated: 0,
  };
  for (const row of rows) {
    if (row.legal_hold) summary.onHold += 1;
    if (isClosedStatus(row.status)) continue;
    summary.open += 1;
    const state = dueState(row, nowMs);
    if (state === "overdue") summary.overdue += 1;
    else if (state === "due_soon") summary.dueSoon += 1;
    else if (state === "unknown") summary.undated += 1;
  }
  return summary;
}

export type PrivacyQueueFilter =
  | "urgent"
  | "open"
  | "on_hold"
  | "closed"
  | "all";

export const PRIVACY_QUEUE_FILTERS: readonly {
  value: PrivacyQueueFilter;
  label: string;
}[] = [
  { value: "urgent", label: "Needs action" },
  { value: "open", label: "Open" },
  { value: "on_hold", label: "On hold" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function matchesFilter(
  row: PrivacyQueueRow,
  filter: PrivacyQueueFilter,
  nowMs: number,
): boolean {
  const closed = isClosedStatus(row.status);
  switch (filter) {
    case "all":
      return true;
    case "closed":
      return closed;
    case "on_hold":
      return Boolean(row.legal_hold);
    case "open":
      return !closed;
    case "urgent": {
      if (closed) return false;
      const state = dueState(row, nowMs);
      return state === "overdue" || state === "due_soon" || state === "unknown";
    }
  }
}

/**
 * Deadline order: overdue first (most overdue at the top), then soonest due,
 * then undated, then closed. The wire order is `requested_at DESC`, which puts
 * the freshest request above the one that is three weeks late.
 */
export function sortQueue(
  rows: readonly PrivacyQueueRow[],
  nowMs: number,
): PrivacyQueueRow[] {
  const rank: Record<DueState, number> = {
    overdue: 0,
    due_soon: 1,
    on_track: 2,
    unknown: 3,
    closed: 4,
  };
  return [...rows].sort((a, b) => {
    const ra = rank[dueState(a, nowMs)];
    const rb = rank[dueState(b, nowMs)];
    if (ra !== rb) return ra - rb;
    const da = Date.parse(a.due_at ?? "");
    const db = Date.parse(b.due_at ?? "");
    const va = Number.isFinite(da) ? da : Number.POSITIVE_INFINITY;
    const vb = Number.isFinite(db) ? db : Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.request_id.localeCompare(b.request_id);
  });
}

export type PrivacyAction = "verify" | "hold" | "clear_hold" | "deny" | "appeal";

/**
 * Which actions the SERVER will accept for this row. Every entry mirrors a
 * guard in apps/api/internal/privacy/workflow.go; an action absent here would
 * be a button whose only possible outcome is a 409.
 */
export function allowedActions(row: PrivacyQueueRow): PrivacyAction[] {
  const status = row.status.trim().toLowerCase();
  const out: PrivacyAction[] = [];
  if (!["fulfilled", "cancelled", "rejected"].includes(status)) {
    out.push("verify");
  }
  if (status !== "fulfilled" && status !== "rejected") out.push("deny");
  if (status === "rejected") out.push("appeal");
  out.push(row.legal_hold ? "clear_hold" : "hold");
  return out;
}

export const PRIVACY_ACTION_LABELS: Readonly<Record<PrivacyAction, string>> = {
  verify: "Send identity verification",
  hold: "Place legal hold",
  clear_hold: "Release legal hold",
  deny: "Deny request",
  appeal: "Record an appeal",
};

/** Actions that need a typed reason — the server 400s without one. */
export function actionRequiresReason(action: PrivacyAction): boolean {
  return action === "hold" || action === "deny" || action === "appeal";
}

/** Destructive-looking actions get the danger treatment in the sheet. */
export function actionIsDestructive(action: PrivacyAction): boolean {
  return action === "deny";
}
