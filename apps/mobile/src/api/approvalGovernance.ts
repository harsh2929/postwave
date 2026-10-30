/**
 * api/approvalGovernance.ts — approval delegation + escalation policy.
 *
 * Mobile has Approvals as one of five bottom tabs and a killed-app actionable
 * push approve/reject flow, yet the governance controls that matter when you're
 * travelling — "who is covering my approvals", "escalate anything sitting
 * longer than N hours" — existed only on desktop, against endpoints that have
 * shipped the whole time.
 *
 * SCOPE NOTE (honest): CREATING a delegation needs a target user id, and the
 * API exposes no workspace-members listing (GET /api/v1/roles returns ROLES,
 * not people), so a mobile "delegate to Sam" picker cannot be built without a
 * backend addition. What ships here is everything that can be done correctly
 * today: read the active delegations, REVOKE one, and read/write the escalation
 * policy. Revoking a delegation when you're back from leave is the half a phone
 * is genuinely good at.
 *
 * These are AUTHORIZATION writes and deliberately never route through
 * src/lib/offlineMutations.ts — an access change replayed hours later is a
 * security hazard, not a convenience.
 */
import { rawRequest, type AIApiResult } from "./request";

/** Mirrors approvals.Delegation (Go). Note the camelCase JSON tags. */
export interface ApprovalDelegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt?: string;
  reason?: string;
  createdAt: string;
  revokedAt?: string;
}

/** Mirrors approvals.EscalationPolicy (Go). */
export interface EscalationPolicy {
  tenantId?: string;
  /** Absent/null means escalation is disabled. */
  escalateAfterHours?: number | null;
  notifyOwners: boolean;
}

/** Bounds the UI offers. The API stores whatever it is given, so the client is
 *  the only thing preventing a "escalate after 0 hours" paging storm. */
export const ESCALATION_HOUR_CHOICES: readonly number[] = [4, 8, 24, 48, 72];

export function isDelegationActive(
  delegation: ApprovalDelegation,
  now = Date.now(),
): boolean {
  if (delegation.revokedAt) return false;
  const starts = Date.parse(delegation.startsAt);
  if (Number.isFinite(starts) && starts > now) return false;
  if (!delegation.endsAt) return true;
  const ends = Date.parse(delegation.endsAt);
  return !Number.isFinite(ends) || ends > now;
}

/**
 * Active first (newest first within each group), then everything else.
 * A revoked delegation from March above a live one is the wrong answer to
 * "who currently holds my approvals?".
 */
export function sortDelegations(
  rows: readonly ApprovalDelegation[],
  now = Date.now(),
): ApprovalDelegation[] {
  return [...rows].sort((a, b) => {
    const activeA = isDelegationActive(a, now);
    const activeB = isDelegationActive(b, now);
    if (activeA !== activeB) return activeA ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

/** Normalise the policy payload: an absent/0/negative value means disabled. */
export function normalizeEscalationPolicy(
  raw: EscalationPolicy | null | undefined,
): EscalationPolicy {
  const hours = raw?.escalateAfterHours;
  return {
    escalateAfterHours:
      typeof hours === "number" && hours > 0 ? Math.round(hours) : null,
    notifyOwners: Boolean(raw?.notifyOwners),
  };
}

export function listApprovalDelegations(): Promise<
  AIApiResult<{ delegations: ApprovalDelegation[] }>
> {
  return rawRequest<{ delegations: ApprovalDelegation[] }>(
    "GET",
    "/api/v1/approvals/delegations",
  );
}

/**
 * The workspace roster, used to pick a delegate.
 *
 * GATE#11 — this module's sibling component said "the API exposes no
 * workspace-members listing, so the 'delegate to Sam' picker is not buildable on
 * mobile yet". `GET /api/v1/workspace/members` is mounted at
 * apps/api/internal/handlers/workspace_members.go:562 behind ScopeAdmin, the same
 * floor createDelegation already requires, so the blocker is stale.
 *
 * `status=active` is asked of the SERVER as well as filtered client-side: there is
 * no reason to transfer a suspended member's row just to drop it.
 */
export function listWorkspaceMembers(): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "GET",
    "/api/v1/workspace/members?status=active",
  );
}

/**
 * POST /api/v1/approvals/delegations (approvals/handlers.go:91, requireAdmin).
 *
 * The body is the endpoint's own camelCase — see delegation.go:25-34. Build it
 * with `delegationRequestBody` rather than by hand; snake_case binds nothing and
 * fails as "tenant + from + to required".
 */
export function createApprovalDelegation(
  body: Record<string, unknown>,
): Promise<AIApiResult<ApprovalDelegation>> {
  return rawRequest<ApprovalDelegation>(
    "POST",
    "/api/v1/approvals/delegations",
    body,
  );
}

export function revokeApprovalDelegation(
  id: string,
): Promise<AIApiResult<{ ok: boolean }>> {
  return rawRequest<{ ok: boolean }>(
    "DELETE",
    `/api/v1/approvals/delegations/${encodeURIComponent(id)}`,
  );
}

export function getEscalationPolicy(): Promise<AIApiResult<EscalationPolicy>> {
  return rawRequest<EscalationPolicy>(
    "GET",
    "/api/v1/approvals/escalation-policy",
  );
}

export function putEscalationPolicy(
  policy: EscalationPolicy,
): Promise<AIApiResult<EscalationPolicy>> {
  const normalized = normalizeEscalationPolicy(policy);
  return rawRequest<EscalationPolicy>(
    "PUT",
    "/api/v1/approvals/escalation-policy",
    {
      // The Go struct uses `omitempty` on a *int, so null disables escalation.
      escalateAfterHours: normalized.escalateAfterHours,
      notifyOwners: normalized.notifyOwners,
    },
  );
}
