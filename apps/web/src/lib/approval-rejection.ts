// SPDX-License-Identifier: AGPL-3.0-only

import {
  verifyFreshAdminAuthority,
  FreshAdminAuthorityError,
} from "@/lib/admin-mutation-authority";
import { ApiError } from "@/lib/api";
import {
  ApprovalContractError,
  getApproval,
  isActionable,
  isSameApprovalTarget,
  rejectApproval,
  type Approval,
} from "@/lib/approvals-api";
import type { MeResponse } from "@/lib/auth-api";

export interface RejectionAttempt {
  fingerprint: string;
  idempotencyKey: string;
  requestStarted: boolean;
}

/**
 * The preflight found a newer or no-longer-actionable record before the write.
 * Carry the exact server record so callers can evict the frozen target instead
 * of presenting a terminal mismatch as a retryable network failure.
 */
export class ApprovalTargetChangedError extends Error {
  constructor(
    readonly latest: Approval,
    readonly reason: "identity-changed" | "no-longer-actionable",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalTargetChangedError";
  }
}

/** Separation-of-duties is a decision-local policy refusal, not role loss. */
export function isSelfApprovalDenial(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status === 403 &&
    (cause.code === "self_approval" || cause.denial?.code === "self_approval")
  );
}

/**
 * A fresh-identity or response-boundary mismatch, authentication loss, or
 * non-policy 403 invalidates every approval control opened under the old
 * authority. A self-approval refusal applies only to that one record and
 * deliberately stays local.
 */
export function isApprovalAuthorityFailure(cause: unknown): boolean {
  return (
    cause instanceof FreshAdminAuthorityError ||
    (cause instanceof ApprovalContractError &&
      ["foreign-tenant", "identity-mismatch"].includes(cause.reason)) ||
    (cause instanceof ApiError &&
      (cause.status === 401 ||
        (cause.status === 403 && !isSelfApprovalDenial(cause))))
  );
}

function isTerminalDecisionResponse(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    ((cause.status === 404 && cause.code === "not_found") ||
      (cause.status === 409 && cause.code === "not_pending") ||
      (cause.status === 410 && cause.code === "expired"))
  );
}

async function reconcileTerminalDecision(
  opened: Approval,
  identity: MeResponse,
  signal: AbortSignal,
): Promise<Approval> {
  try {
    const latest = await getApproval(opened.id, {
      expectedTenantId: identity.tenant_id,
      signal,
    });
    signal.throwIfAborted();
    // A lagging read must not immediately restore a control after the write
    // endpoint authoritatively said the target is terminal.
    return isActionable(latest) ? { ...latest, status: "unverified" } : latest;
  } catch (cause) {
    if (
      isApprovalAuthorityFailure(cause) ||
      isSelfApprovalDenial(cause) ||
      cause instanceof ApprovalContractError
    ) {
      throw cause;
    }
    signal.throwIfAborted();
    return { ...opened, status: "unverified" };
  }
}

/**
 * Revalidate the exact approval and exact current authority around one reject
 * request, then accept success only after an exact stored-decision readback.
 */
export async function recordVerifiedRejection({
  approval,
  identity,
  notes,
  attempt,
  signal,
}: {
  approval: Approval;
  identity: MeResponse;
  notes: string;
  attempt: RejectionAttempt;
  signal: AbortSignal;
}): Promise<Approval> {
  const fresh = await getApproval(approval.id, {
    expectedTenantId: identity.tenant_id,
    signal,
  });
  signal.throwIfAborted();
  if (
    fresh.tenantId !== identity.tenant_id ||
    !isSameApprovalTarget(approval, fresh)
  ) {
    throw new ApprovalTargetChangedError(
      fresh,
      "identity-changed",
      "The approval record changed after this action opened. No rejection was sent; close it and inspect the latest record.",
    );
  }
  if (fresh.status !== "pending") {
    if (
      fresh.status === "rejected" &&
      attempt.requestStarted &&
      Boolean(fresh.decidedAt) &&
      fresh.decidedByUserId === identity.user_id &&
      fresh.notes?.trim() === notes
    ) {
      return fresh;
    }
    throw new ApprovalTargetChangedError(
      fresh,
      "no-longer-actionable",
      `This request is now ${fresh.status}. No rejection was sent.`,
    );
  }
  if (!isActionable(fresh)) {
    throw new ApprovalTargetChangedError(
      fresh,
      "no-longer-actionable",
      "This pending request has expired or cannot be safely interpreted. No rejection was sent; inspect the latest record.",
    );
  }

  await verifyFreshAdminAuthority(identity, signal);
  signal.throwIfAborted();
  attempt.requestStarted = true;
  let result: { ok: boolean };
  try {
    result = await rejectApproval(approval.id, notes, {
      idempotencyKey: attempt.idempotencyKey,
      signal,
    });
  } catch (cause) {
    if (!isTerminalDecisionResponse(cause)) throw cause;
    const latest = await reconcileTerminalDecision(approval, identity, signal);
    throw new ApprovalTargetChangedError(
      latest,
      "no-longer-actionable",
      "The server reports that this approval is no longer pending. No new rejection is claimed; inspect the latest record.",
    );
  }
  signal.throwIfAborted();
  if (!result.ok) {
    throw new Error(
      "The server did not confirm the rejection request. Its outcome is unknown; refresh before retrying.",
    );
  }
  const recorded = await getApproval(approval.id, {
    expectedTenantId: identity.tenant_id,
    signal,
  });
  signal.throwIfAborted();
  if (
    !isSameApprovalTarget(approval, recorded) ||
    recorded.tenantId !== identity.tenant_id ||
    recorded.status !== "rejected" ||
    !recorded.decidedAt ||
    recorded.decidedByUserId !== identity.user_id ||
    recorded.notes?.trim() !== notes
  ) {
    throw new Error(
      "The rejection request was sent, but the exact stored decision could not be verified. Refresh before retrying; no requester notification or downstream effect is claimed.",
    );
  }
  return recorded;
}
