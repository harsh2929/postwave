/**
 * lib/approvalPolicy.ts — the PURE decision rules for the approvals surface:
 * what a decision request looks like on the wire, and what the approver is
 * told when it succeeds or fails.
 *
 * Extracted from `useApprovals` for two reasons. It kept that hook module
 * under its source budget, and — more usefully — these are the rules most
 * worth testing in isolation: the 409 copy in particular is a deliberate
 * decision NOT to blame a teammate, because on a flaky network a request that
 * committed server-side can still time out client-side, and the user's second
 * tap would otherwise be explained as "a colleague decided it".
 *
 * `useApprovals` re-exports everything here, so call sites are unchanged.
 */

export type ApprovalDecision = "approve" | "reject";
export type ApprovalDecisionInput = {
  id: string;
  decision: ApprovalDecision;
  notes?: string;
};
export type ApprovalDecisionResponse = {
  ok: boolean;
  followup_error?: string;
};

export function approvalDecisionSuccessMessage(
  decision: ApprovalDecision,
  response: ApprovalDecisionResponse,
): { title: string; message: string; followupFailed: boolean } {
  const followupError = response.followup_error?.trim();
  if (followupError) {
    return {
      title: "Decision saved, action failed",
      message: `The request was ${decision === "approve" ? "approved" : "rejected"}, but its follow-up action failed: ${followupError}`,
      followupFailed: true,
    };
  }
  return {
    title: decision === "approve" ? "Approved" : "Rejected",
    message:
      decision === "approve"
        ? "The request was approved and the action will proceed."
        : "The request was rejected and the requester will be notified.",
    followupFailed: false,
  };
}

/**
 * decisionErrorMessage — translate the SDK's thrown error into copy an
 * approver can act on. The backend's decide handlers return precise
 * statuses; everything else falls through to the raw message.
 */
export function decisionErrorMessage(err: unknown): string {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  switch (status) {
    case 409:
      // Do NOT blame a teammate. On a flaky mobile network a request that
      // reached the server and committed can still time out client-side;
      // the user taps again and gets this. Telling them a colleague decided
      // it — when it was their own successful attempt — is worse than
      // saying nothing precise.
      return "This approval is no longer pending — it may already have been decided, possibly by your earlier attempt. The list has been refreshed.";
    case 410:
      return "This approval expired before a decision was made. The requester must re-submit.";
    case 403:
      // The server sends distinct codes here; mobile used to emit both
      // explanations at once because it discarded them at the boundary.
      if (code === "self_approval") {
        return "You requested this approval, so someone else has to decide it.";
      }
      if (code === "forbidden" || code === "admin_required") {
        return "Deciding approvals requires an owner or admin role in this workspace.";
      }
      return "You can't decide this one — requesters can't approve their own requests, and deciding requires an admin role.";
    case 404:
      return "Approval not found — it may have been removed. The list has been refreshed.";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

/** Statuses where the row's pending state is stale on this device. */
export function isStaleDecisionError(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err
      ? (err as { status?: unknown }).status
      : undefined;
  return status === 409 || status === 410 || status === 404;
}

export function buildApprovalDecisionRequest(input: ApprovalDecisionInput): {
  method: "POST";
  path: string;
  body: { notes?: string };
} {
  const notes = input.notes?.trim();
  return {
    method: "POST",
    path: `/api/v1/approvals/${encodeURIComponent(input.id)}/${input.decision}`,
    body: notes ? { notes } : {},
  };
}

/* ------------------------------------------- resource context --- */

export type ApprovalResourceContext = {
  /** Display title (campaign subject, falling back to name). */
  title?: string;
  /** Secondary line (campaign name when distinct from the subject). */
  subtitle?: string;
  /** Current status of the underlying resource (e.g. "draft"). */
  status?: string;
  /** Recipients the report saw (the closest "audience size" signal we
   * have without a dedicated count endpoint). 0/undefined for unsent. */
  recipients?: number;
  /** True while the lookup is in flight. */
  loading: boolean;
};

/**
 * Minimal campaign shape we read off GET /api/v1/campaigns/{id}. We don't
 * import the SDK Campaign type here to keep the hook self-contained; the
 * runtime payload carries these fields (see apps/api/.../campaigns/types.go).
 */
export type ApprovalCampaign = {
  id: string;
  name?: string;
  subject?: string;
  status?: string;
};

/** Minimal report shape — only the recipient count is read here. */
export type ApprovalCampaignReport = { sent?: number };

/**
 * deriveApprovalCampaignContext — pure mapping from a resolved campaign +
 * report into the display fields the row renders. Exported (and unit
 * tested) so the subject/name precedence and the "name only when distinct"
 * rule can't silently regress. Returns undefined fields when there's
 * nothing meaningful to show.
 */
export function deriveApprovalCampaignContext(
  campaign: { name?: string; subject?: string; status?: string } | null,
  report: { sent?: number } | null,
): {
  title?: string;
  subtitle?: string;
  status?: string;
  recipients?: number;
} {
  const subject = campaign?.subject?.trim();
  const name = campaign?.name?.trim();
  const title = subject || name || undefined;
  const subtitle = subject && name && subject !== name ? name : undefined;
  const result: {
    title?: string;
    subtitle?: string;
    status?: string;
    recipients?: number;
  } = {};
  if (title) result.title = title;
  if (subtitle) result.subtitle = subtitle;
  if (campaign?.status) result.status = campaign.status;
  if (typeof report?.sent === "number") result.recipients = report.sent;
  return result;
}

export function optionalResourceStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    return Number((err as { status?: unknown }).status) || 0;
  }
  return 0;
}

export function isOptionalResourceError(err: unknown): boolean {
  const status = optionalResourceStatus(err);
  return status === 404 || status === 405 || status === 501;
}

export interface PendingApprovalsPublishInput {
  /** May this account read GET /api/v1/approvals at all? (owner|admin) */
  permitted: boolean;
  /** The query has produced an answer at least once. */
  loaded: boolean;
  /** Row count from that answer. */
  count: number;
}

/**
 * The pending-approvals number a home-screen widget may publish, or null when
 * it is genuinely unknown.
 *
 * ABSENCE IS NOT ZERO, and this is the case where that rule bites hardest.
 * The widget renders "To approve: 0" — a governance surface asserting there
 * is nothing to do. Publishing that from a device whose stats are cached but
 * whose approvals query is still gated, offline or in flight is a confident
 * false all-clear about an action queue.
 *
 * There are three states, not two:
 *
 *   - NOT PERMITTED. GET /api/v1/approvals is owner/admin-only (requireAdmin
 *     in approvals/handlers.go), so an editor or viewer will never have
 *     approvals to act on. Zero is TRUE for them, not unknown, and returning
 *     null here would block their widget from ever publishing anything.
 *   - LOADED. Whatever the server said.
 *   - ANYTHING ELSE. Unknown → null, and the caller holds the last published
 *     value rather than inventing one.
 */
export function pendingApprovalsWidgetValue(
  input: PendingApprovalsPublishInput,
): number | null {
  if (!input.permitted) return 0;
  if (!input.loaded) return null;
  return Number.isFinite(input.count) && input.count > 0
    ? Math.round(input.count)
    : 0;
}
