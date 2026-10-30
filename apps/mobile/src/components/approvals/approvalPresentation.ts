/**
 * approvalPresentation — every pure decision the Approvals surface makes.
 *
 * The screen files own layout only. Anything that decides whether a row is
 * tappable, what it says, or what the summary strip claims lives here so it
 * is unit-testable: a wrong answer on this surface commits an irreversible,
 * audit-logged decision.
 */
import { dateTime, duration, num, relativeTime } from "@/lib/format";
import { governanceEmptyCopy } from "@/lib/governanceEmptyStates";

export type FilterKey = "pending" | "all";

export type RejectDraft = { id: string; label: string; reason: string } | null;

export type ApprovalGateNotice = {
  title: string;
  description: string;
  staleMessage: string;
} | null;

export type ApprovalRowDecisionState = {
  disabled: boolean;
  opacity: number;
  accessibilityLabelSuffix: string;
};

export function approvalGateNotice({
  gateEnabled,
  hasTenant,
}: {
  gateEnabled: boolean;
  hasTenant: boolean;
}): ApprovalGateNotice {
  if (gateEnabled) return null;
  if (!hasTenant) {
    return {
      title: "Reconnect your workspace",
      description:
        "Approvals need an authenticated workspace before they can refresh.",
      staleMessage: "Reconnect your workspace to refresh approvals.",
    };
  }
  return {
    title: "Reconnect to load approvals",
    description:
      "This cached session has not been validated online yet. Reconnect before reviewing approval requests.",
    staleMessage:
      "Reconnect before deciding approvals. Showing the last loaded results.",
  };
}

export function approvalEmptyCopy({
  filter,
  query,
  gateNotice,
}: {
  filter: FilterKey;
  query: string;
  gateNotice: ApprovalGateNotice;
}): { title: string; description: string } {
  if (gateNotice) {
    return {
      title: gateNotice.title,
      description: gateNotice.description,
    };
  }
  if (filter === "pending") {
    return {
      title: "You're caught up",
      description: "Nothing pending right now. Pull to refresh.",
    };
  }
  const trimmed = query.trim();
  if (trimmed) {
    // A narrowed result is about the FILTER, not about the surface — the user
    // has learned something, and handing this to the shared governance copy
    // would flatten a real distinction.
    return {
      title: "Nothing matches",
      description: `No approvals match "${trimmed}"`,
    };
  }
  // First run. `"No approvals on file yet."` restated the empty list and told a
  // first-time admin nothing about what the queue is for or what puts a row in
  // it — the shared governance copy answers both (GOVERNANCE#30).
  return governanceEmptyCopy("approvals");
}

export function canRefreshApprovals(gateNotice: ApprovalGateNotice): boolean {
  return !gateNotice;
}

/**
 * approvalRowDecisionState — can this row be acted on, and what does
 * VoiceOver say about why not?
 *
 * `isExpired` and `isOwnRequest` are the two conditions the screen could
 * always see and never checked. Both end in a guaranteed server refusal
 * (410 `expired`, 403 `self_approval`), so letting the row stay tappable
 * walked the user through a confirmation for a decision that could only
 * fail. The row already renders the expiry, and `requestedByUserId` sits
 * next to the signed-in `userId` — every input was in hand.
 *
 * The returned shape is deliberately unchanged (disabled / opacity /
 * accessibilityLabelSuffix); the extra reasons are surfaced separately by
 * `approvalRowNotices` so the row can render a Pill for them.
 */
export function approvalRowDecisionState({
  isPending,
  isRowDeciding,
  gateNotice,
  isExpired = false,
  isOwnRequest = false,
}: {
  isPending: boolean;
  isRowDeciding: boolean;
  gateNotice: ApprovalGateNotice;
  isExpired?: boolean;
  isOwnRequest?: boolean;
}): ApprovalRowDecisionState {
  const gateDisabled = Boolean(gateNotice);
  const blockedByRow = isPending && (isExpired || isOwnRequest);
  const disabled = !isPending || isRowDeciding || gateDisabled || blockedByRow;
  const suffix = !isPending
    ? ""
    : gateDisabled
      ? " - reconnect before deciding"
      : isExpired
        ? " - expired, no decision possible"
        : isOwnRequest
          ? " - you requested this, someone else must decide"
          : " - tap to approve or reject";
  return {
    disabled,
    opacity:
      isRowDeciding || gateDisabled || blockedByRow
        ? 0.6
        : isPending
          ? 1
          : 0.85,
    accessibilityLabelSuffix: suffix,
  };
}

export type ApprovalRowNotice = {
  key: "expired" | "self";
  label: string;
  tone: "danger" | "warning";
};

/**
 * The badges explaining why a still-pending row cannot be decided. Colour
 * alone never carries this — each is a text Pill, so it survives both
 * greyscale and VoiceOver.
 */
export function approvalRowNotices({
  isPending,
  isExpired,
  isOwnRequest,
}: {
  isPending: boolean;
  isExpired: boolean;
  isOwnRequest: boolean;
}): ApprovalRowNotice[] {
  if (!isPending) return [];
  const out: ApprovalRowNotice[] = [];
  if (isExpired) out.push({ key: "expired", label: "Expired", tone: "danger" });
  if (isOwnRequest) {
    out.push({ key: "self", label: "You requested this", tone: "warning" });
  }
  return out;
}

/** Human-readable resource label, e.g. "Campaign send". */
export function resourceLabel(resourceType: string): string {
  switch (resourceType) {
    case "campaign":
      return "Campaign send";
    case "sequence":
      return "Sequence activation";
    case "automation_send":
      return "Automation send";
    default:
      return resourceType || "Approval";
  }
}

/**
 * The timestamp footer for a row: relative age plus the absolute instant.
 * `requestedAt` is typed non-optional but arrives via an unvalidated
 * `as`-cast wire shape, so a missing / malformed value must produce ""
 * rather than "Invalid Date" or a dangling separator.
 *
 * `now` is injected (rather than read from Date.now() inside) so the line
 * ages with the screen's ticking clock instead of freezing at first render.
 */
export function requestedAtLine(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const rel = relativeTime(iso, { now, fallback: "" });
  const abs = dateTime(at);
  return rel ? `${rel} · ${abs}` : abs;
}

/**
 * "Expires in …" for a still-pending approval. Returns "" when there is no
 * usable expiry or it is far out (>7d, not worth the noise). An already-
 * past expiry reads "Expired" — paired with a disabled row, since the
 * server answers 410 for a decision past this instant.
 */
export function expiryHint(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.floor((at - now) / 1000);
  if (seconds <= 0) return "Expired";
  if (seconds < 3600) {
    return `Expires in ${Math.max(1, Math.floor(seconds / 60))}m`;
  }
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `Expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `Expires in ${days}d`;
  return "";
}

/** Has this approval's expiry passed? Unparseable / absent = not expired. */
export function isApprovalExpired(
  expiresAt: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return false;
  return at <= now;
}

/**
 * The minimum row shape the summary strip reads. Deliberately structural
 * rather than importing the hook's `Approval` type, so this module stays
 * free of transport concerns and testable in a node environment.
 */
export interface ApprovalStatRow {
  status: string;
  requestedAt: string;
  decidedAt?: string | null;
}

export interface ApprovalDecisionStats {
  pending: number;
  approved7d: number;
  rejected7d: number;
  /** Mean time from request to decision over the last 7d, or null. */
  avgTimeToDecideMs: number | null;
  /** Rows the average is derived from — an average of one is not a trend. */
  decidedSample: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * approvalDecisionStats — "is this queue healthy?", not just "how long is
 * it?". Every input is already on the wire, so this costs no request.
 *
 * The averages inherit whatever window the caller fetched, which is why the
 * screen pairs them with the 100-row truncation disclosure.
 */
export function approvalDecisionStats(
  rows: readonly ApprovalStatRow[],
  now: number = Date.now(),
): ApprovalDecisionStats {
  const stats: ApprovalDecisionStats = {
    pending: 0,
    approved7d: 0,
    rejected7d: 0,
    avgTimeToDecideMs: null,
    decidedSample: 0,
  };
  let totalMs = 0;
  for (const row of rows) {
    if (row.status === "pending") {
      stats.pending += 1;
      continue;
    }
    if (!row.decidedAt) continue;
    const decided = Date.parse(row.decidedAt);
    if (Number.isNaN(decided) || now - decided > WEEK_MS) continue;
    if (row.status === "approved") stats.approved7d += 1;
    else if (row.status === "rejected") stats.rejected7d += 1;
    else continue;
    const requested = Date.parse(row.requestedAt);
    // A clock-skewed row (decided before requested) would drag the mean
    // negative; drop it from the sample rather than reporting a negative
    // time-to-decide.
    if (Number.isNaN(requested) || decided < requested) continue;
    totalMs += decided - requested;
    stats.decidedSample += 1;
  }
  if (stats.decidedSample > 0) {
    stats.avgTimeToDecideMs = Math.round(totalMs / stats.decidedSample);
  }
  return stats;
}

/** The time-to-decide tile's display value. */
export function formatTimeToDecide(ms: number | null): string {
  return ms == null ? "—" : duration(ms);
}

/**
 * The server caps GET /api/v1/approvals at 100 rows and the repo has no
 * cursor at all (a bare ORDER BY + LIMIT), so the "All" tab can only ever
 * be a window. Saying "N total" of a truncated set is a false claim and the
 * history search silently misses older rows — so say so, exactly as the
 * audit screen does. Returns null when nothing was truncated.
 */
export function approvalTruncationNotice(
  rowCount: number,
  limit: number,
): string | null {
  if (rowCount < limit) return null;
  return `Showing the most recent ${num(limit)} approvals — counts and search cover this window only. Use the web app for full history.`;
}

export interface ApprovalActionGateInput {
  /** True when the request is still `pending` on the server. */
  pending: boolean;
  expired: boolean;
  /** The reader is the requester — the server refuses a self-approval. */
  ownRequest: boolean;
  /** Offline / cached-session notice, if any. */
  gated: boolean;
  busy: boolean;
}

export interface ApprovalActionGate {
  canAct: boolean;
  /** Why the buttons are inert, or null when they are not. */
  blockedReason: string | null;
}

/**
 * Whether the decision bar may act, and the sentence explaining it when not.
 *
 * Extracted from the detail screen because the four-branch ternary that used
 * to live in its JSX was the single largest contributor to that file's
 * cyclomatic complexity — and because the ORDER of the branches is a product
 * decision, not an accident: connectivity is reported before expiry, and
 * expiry before self-approval, so the reader is told the thing they can
 * actually change first.
 */
export function approvalActionGate(
  input: ApprovalActionGateInput,
): ApprovalActionGate {
  if (input.gated) {
    return { canAct: false, blockedReason: "Reconnect before deciding." };
  }
  if (input.expired) {
    return {
      canAct: false,
      blockedReason:
        "This request expired — the server will refuse a decision. Ask the requester to re-submit.",
    };
  }
  if (input.ownRequest) {
    return {
      canAct: false,
      blockedReason: "You requested this, so someone else has to decide it.",
    };
  }
  if (!input.pending || input.busy) {
    return { canAct: false, blockedReason: null };
  }
  return { canAct: true, blockedReason: null };
}

export function rejectReasonModalState(
  reason: string,
  busy?: boolean,
): { trimmedReason: string; submitDisabled: boolean; submitLabel: string } {
  const trimmedReason = reason.trim();
  return {
    trimmedReason,
    submitDisabled: Boolean(busy) || trimmedReason.length === 0,
    submitLabel: busy ? "Rejecting..." : "Reject",
  };
}

export type RejectDraftSubmit =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "reason_required"; title: string; message: string }
  | {
      kind: "submit";
      input: { id: string; decision: "reject"; notes: string };
    };

export function rejectDraftSubmitState(
  draft: RejectDraft,
  busy?: boolean,
): RejectDraftSubmit {
  if (busy) return { kind: "busy" };
  if (!draft) return { kind: "idle" };
  const { trimmedReason } = rejectReasonModalState(draft.reason);
  if (!trimmedReason) {
    return {
      kind: "reason_required",
      title: "Reason required",
      message: "Add a short reason so the requester knows what to fix.",
    };
  }
  return {
    kind: "submit",
    input: {
      id: draft.id,
      decision: "reject",
      notes: trimmedReason,
    },
  };
}
