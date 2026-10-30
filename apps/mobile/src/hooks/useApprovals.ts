/**
 * hooks/useApprovals.ts — pending-approval list + decide mutations.
 *
 * The Moosewave approvals system gates risky actions (e.g. a campaign
 * send, a sequence activation, an agent-drafted automation) on a human
 * OK. The web admin has a full approvals dashboard; the mobile surface
 * is the on-the-go approver who's not at a desk.
 *
 * Wire contract (apps/api/internal/approvals/handlers.go + repo.go):
 *
 *   GET  /api/v1/approvals?status=pending   → { approvals: [...], items: [...] }
 *   POST /api/v1/approvals/{id}/approve     → { ok: true }   body: { notes? }
 *   POST /api/v1/approvals/{id}/reject      → { ok: true }   body: { notes? }
 *
 * Rows serialize with camelCase JSON tags (resourceType, requestedAt,
 * requestedByActorLabel, …) — see the Approval struct in approvals.go.
 * Decide errors come back as { error: { code, message } } with
 * meaningful statuses: 409 not_pending, 410 expired, 403 self_approval.
 *
 * The SDK's domain resource still describes a stale snake_case shape, so this
 * hook uses the SDK's typed public transport until code generation catches up.
 *
 * Auth note: unlike most hooks in this folder, the queries here read
 * the tenant id from the auth store rather than calling getClient() at
 * hook top level. That makes them safe to mount in (tabs)/_layout.tsx
 * for the tab badge, where the auth redirect hasn't run yet —
 * getClient() throws when logged out.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  buildApprovalDecisionRequest,
  deriveApprovalCampaignContext,
  isOptionalResourceError,
  isStaleDecisionError,
  optionalResourceStatus,
  pendingApprovalsWidgetValue,
  type ApprovalCampaign,
  type ApprovalCampaignReport,
  type ApprovalDecisionInput,
  type ApprovalDecisionResponse,
  type ApprovalResourceContext,
} from "@/lib/approvalPolicy";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** Mirrors the camelCase JSON of approvals.Approval (Go). */
export type Approval = {
  id: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  requestedByActorType?: string;
  requestedByActorLabel?: string;
  requestedByUserId?: string | null;
  requestedByApiKeyId?: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string | null;
  decidedByUserId?: string | null;
  notes?: string;
  expiresAt: string;
  /**
   * Fingerprint of the approved content (subject + body + segment). The
   * server re-checks it when the action runs, which is what stops an
   * "approve benign content → edit to spam → queue" bypass. Nullable for
   * approvals created before migration 0160.
   */
  contentHash?: string;
  /** Set once the approved side-effect (e.g. the campaign queue) has fired. */
  consumedAt?: string | null;
};

/**
 * The row cap the list requests explicitly.
 *
 * The server silently caps at 100 for a missing/0 limit
 * (approvals/repo.go: `if limit <= 0 || limit > 500 { limit = 100 }`), so
 * the previous no-limit request produced a truncated list the screen then
 * called "N total". Sending it explicitly makes the window a stated
 * contract the UI can disclose rather than an invisible server default.
 * The approvals repo has no cursor at all, so real paging needs a backend
 * increment first — until then the honest move is to say so.
 */
export const APPROVALS_PAGE_LIMIT = 100;

export interface ApprovalPage {
  rows: Approval[];
  /** True when the server returned a full page — older rows exist. */
  truncated: boolean;
}

async function fetchApprovals(status?: ApprovalStatus): Promise<Approval[]> {
  // Guard getClient(): these queries are gated on tenantId presence, but
  // getClient() additionally requires baseUrl + a resolved authMode. During
  // the auth-bootstrap window — where the
  // badge query mounts in (tabs)/_layout.tsx before the auth redirect runs —
  // tenantId can be set while baseUrl/authMode are not, and getClient() would
  // throw "PostwaveClient requested without credentials". Degrade to an empty
  // list (0 badge, normal empty state) rather than a permanent query error.
  let client: ReturnType<typeof getClient>["client"];
  try {
    ({ client } = getClient());
  } catch {
    return [];
  }
  const qs = new URLSearchParams({ limit: String(APPROVALS_PAGE_LIMIT) });
  if (status) qs.set("status", status);
  const res = await client.request<
    Approval[] | { approvals?: Approval[]; items?: Approval[] } | null
  >("GET", `/api/v1/approvals?${qs.toString()}`);
  if (Array.isArray(res)) return res;
  return res?.items ?? res?.approvals ?? [];
}

/** Did this response fill the requested page? */
export function isApprovalPageTruncated(rows: readonly Approval[]): boolean {
  return rows.length >= APPROVALS_PAGE_LIMIT;
}

/**
 * How often each KIND of observer wants this query refreshed.
 *
 * These are per-observer, not per-query, and that distinction is the whole
 * point. TanStack v5 gives every observer its own refetch timer over the
 * shared cache entry, so the effective cadence is whichever mounted observer
 * asks for the shortest one — and it re-aligns the timers on each settle, so
 * two observers do not stack into two requests.
 *
 * The badge from `usePendingApprovalsCount` mounts in the TAB LAYOUT, meaning
 * unconditionally, for the whole session. At the list's cadence that was 60
 * requests an hour for every admin for as long as the app was open, to keep a
 * number fresh that changes when somebody else submits something for review.
 * The list screen still gets its 60s — an operator looking at a queue expects
 * it to move — but only while that screen is focused (the screen passes its
 * focus into `enabled`; Expo Router keeps visited tabs mounted).
 */
export const APPROVALS_LIST_POLL_MS = 60_000;
/** Matches the notification feed's cadence (hooks/useAppBadgeSync.ts). */
export const APPROVALS_BADGE_POLL_MS = 5 * 60_000;

/**
 * usePendingApprovals — the actionable subset, server-filtered via
 * ?status=pending. Polls while the app is foregrounded so the list stays
 * honest; pull-to-refresh covers the impatient path.
 *
 * `pollMs` lets a count-only caller ask for the slower badge cadence without
 * slowing the list down for the operator reading it. See the constants above.
 */
export function usePendingApprovals(
  enabled = true,
  pollMs: number = APPROVALS_LIST_POLL_MS,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["approvals", gate.tenantId, "pending"],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchApprovals("pending"),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
}

/**
 * useAllApprovals — full unfiltered approval list for the workspace.
 * Used by the Approvals screen's "All" filter chip so the operator
 * can scroll back through approved/rejected/expired history.
 */
export function useAllApprovals(enabled = true) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["approvals", gate.tenantId, "all"],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    queryFn: () => fetchApprovals(),
  });
}

/**
 * useApproval — a single approval, refetched on open.
 *
 * The list is a poll up to 60s old, so the row an approver taps can already
 * have been decided by a teammate. `staleTime: 0` means opening the detail
 * always re-asks the server, which is the whole reason a detail view exists
 * before an irreversible decision.
 */
export function useApproval(id: string | null | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["approvals", gate.tenantId, "detail", id],
    enabled: gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 0,
    queryFn: async (): Promise<Approval | null> => {
      const { client } = getClient();
      const res = await client.request<Approval | null>(
        "GET",
        `/api/v1/approvals/${encodeURIComponent(id!)}`,
      );
      return res ?? null;
    },
  });
}

/**
 * Mirrors approvals.EscalationPolicy (Go). `escalateAfterHours` absent/null
 * means the EscalationSweeper is not re-routing anything for this tenant.
 */
export type ApprovalEscalationPolicy = {
  escalateAfterHours?: number | null;
  notifyOwners?: boolean;
};

/**
 * useApprovalEscalationPolicy — read-only, so the countdown on a row can be
 * explained ("unattended requests escalate after 24h") instead of being an
 * unexplained number. Authoring stays on desktop. Tolerates the admin-only
 * 403 by returning null rather than erroring a whole screen over a hint.
 */
export function useApprovalEscalationPolicy() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["approvals", gate.tenantId, "escalation-policy"],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ApprovalEscalationPolicy | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<ApprovalEscalationPolicy | null>(
          "GET",
          "/api/v1/approvals/escalation-policy",
        );
        return res ?? null;
      } catch (err) {
        if (isOptionalResourceError(err) || optionalResourceStatus(err) === 403) {
          return null;
        }
        throw err;
      }
    },
  });
}

/** The escalation hint rendered under the count summary, or null. */
export function escalationHint(
  policy: ApprovalEscalationPolicy | null | undefined,
): string | null {
  const hours = policy?.escalateAfterHours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    return null;
  }
  const rounded = Math.round(hours);
  const window = rounded % 24 === 0 && rounded >= 24
    ? `${rounded / 24} day${rounded === 24 ? "" : "s"}`
    : `${rounded} hour${rounded === 1 ? "" : "s"}`;
  return policy?.notifyOwners
    ? `Unattended requests escalate to workspace owners after ${window}.`
    : `Unattended requests escalate after ${window}.`;
}

/**
 * Mirrors agent_routines.Run (Go, snake_case JSON) for the fields an
 * approver needs before signing off on an AI-proposed action.
 */
export type ApprovalAgentRun = {
  id: string;
  routine_id?: string;
  status?: string;
  reasoning?: string;
  prompt_used?: string;
  context_used?: string;
  output_kind?: string;
  started_at?: string;
  finished_at?: string | null;
  error?: string;
};

/**
 * useApprovalAgentRun — the agent's reasoning behind an AI-initiated
 * request. GET /api/v1/agent-routines/runs/by-approval/{id} 404s for a
 * human-initiated approval, which is a normal answer ("no agent run"), not
 * a failure — hence the isOptionalResourceError guard.
 *
 * Approving an AI-proposed send to a real audience without being able to
 * read why the agent wanted it is the weakest link in the governance story,
 * and the phone approver is the one most likely to be deciding fast.
 */
export function useApprovalAgentRun(
  approval: Pick<Approval, "id" | "requestedByActorType"> | null | undefined,
) {
  const gate = useOnlineQueryGate();
  const isAgent = approval?.requestedByActorType === "agent";
  const id = approval?.id ?? null;
  return useQuery({
    queryKey: ["approval-agent-run", gate.tenantId, id],
    enabled: gate.enabled && Boolean(isAgent && id && gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<ApprovalAgentRun | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<ApprovalAgentRun | null>(
          "GET",
          `/api/v1/agent-routines/runs/by-approval/${encodeURIComponent(id!)}`,
        );
        return res ?? null;
      } catch (err) {
        if (!isOptionalResourceError(err)) throw err;
        return null;
      }
    },
  });
}

// The pure decision policy lives in lib/approvalPolicy (testable without the
// query layer); re-exported so every existing import of this hook module keeps
// working unchanged.

export {
  approvalDecisionSuccessMessage,
  deriveApprovalCampaignContext,
  type ApprovalResourceContext,
  buildApprovalDecisionRequest,
  decisionErrorMessage,
  isStaleDecisionError,
  type ApprovalDecision,
  type ApprovalDecisionInput,
  type ApprovalDecisionResponse,
} from "@/lib/approvalPolicy";

export function useApprovalDecision() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["approvals", tenantId] });
  return useMutation({
    mutationFn: async (input: ApprovalDecisionInput) => {
      const { client } = getClient();
      const request = buildApprovalDecisionRequest(input);
      return client.request<ApprovalDecisionResponse>(
        request.method,
        request.path,
        {
          body: request.body,
        },
      );
    },
    // Decided rows must move out of the pending list — success AND
    // already-decided/expired conflicts both mean our cached copy is
    // stale, so refetch either way.
    onSuccess: () => {
      void invalidate();
    },
    onError: (err: unknown) => {
      if (isStaleDecisionError(err)) void invalidate();
    },
  });
}

/**
 * Re-exported so every existing `from "@/hooks/useApprovals"` import keeps
 * working. The implementation moved to its own module: it queries a different
 * resource against different cache keys, and this file is the approvals CRUD
 * surface.
 */
export { useApprovalResourceContext } from "@/hooks/useApprovalResourceContext";

/**
 * usePendingApprovalsCount — badge-friendly view of the pending query.
 * Shares the cache entry with usePendingApprovals so mounting it in
 * the tab layout costs no extra request. Returns 0 while loading or
 * logged out (no badge).
 *
 * `enabled` exists because GET /api/v1/approvals is owner/admin-only
 * (requireAdmin in approvals/handlers.go 403s editor and viewer). The badge
 * mounts unconditionally in the tab layout, so without a gate a non-admin
 * fires a guaranteed 403 on every poll for the whole session. Pass
 * `canAccessMinimumRole("admin", effectiveRole, mode)`.
 */
export function usePendingApprovalsCount(enabled = true): number {
  const { data } = usePendingApprovals(enabled, APPROVALS_BADGE_POLL_MS);
  return data?.length ?? 0;
}

/**
 * usePendingApprovalsPublishable — the same count, but able to say "I don't
 * know" instead of "zero".
 *
 * `usePendingApprovalsCount` collapses not-loaded into 0, which is exactly
 * what a tab BADGE wants (no answer → no badge) and exactly wrong for
 * anything that ASSERTS the number. The home-screen widget renders
 * "To approve: 0", so a device with cached stats and an unresolved approvals
 * query was publishing a confident all-clear about a governance queue it had
 * never actually read.
 *
 * `permitted` is the caller's role answer — GET /api/v1/approvals is
 * owner/admin-only, so for everyone else zero is the truth rather than a
 * guess. See `pendingApprovalsWidgetValue` for why that is three states.
 */
export function usePendingApprovalsPublishable(permitted: boolean): number | null {
  const { data, isSuccess } = usePendingApprovals(permitted, APPROVALS_BADGE_POLL_MS);
  return pendingApprovalsWidgetValue({
    permitted,
    loaded: isSuccess && Array.isArray(data),
    count: data?.length ?? 0,
  });
}
