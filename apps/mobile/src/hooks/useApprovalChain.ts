/**
 * hooks/useApprovalChain.ts — multi-stage approval progress for one request.
 *
 * Two reads, because one is not enough (see lib/approvalChain fact 1: the
 * per-approval progress rows do not exist until somebody decides, so an
 * untouched chain and a resource with no chain at all are indistinguishable
 * on the progress endpoint alone):
 *
 *   GET /api/v1/approvals/chain?resource_type=…   the plan
 *   GET /api/v1/approvals/{id}/chain              what has happened
 *
 * Both are mounted with `apikeys.RequireScope(apikeys.ScopeReadCampaigns)`
 * (approvals/chain.go:88-94). `read:campaigns` is in `readOnlyScopes`, and
 * `RequireScope`'s session branch admits any authenticated dashboard user for
 * a read-only scope — so this is strictly WEAKER than the owner/admin gate on
 * the approvals list itself. Anyone who reached this screen can read it.
 *
 * NEITHER ROUTE IS IN openapi.json. They are mounted in main.go and verified
 * in the Go source; do not "fix" this hook against the spec file.
 *
 * READ-ONLY ON PURPOSE. `POST /api/v1/approvals/{id}/chain/decide` exists, but
 * it is a DIFFERENT decision from the single-gate approve/reject this screen
 * already offers, it needs `resource_type` in the body on the first call, and
 * two similarly-labelled buttons on a phone is exactly how somebody approves
 * the wrong thing. The finding this answers asks "am I the blocker?" — that
 * is a reading question.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isOptionalResourceError } from "@/lib/approvalPolicy";
import {
  buildApprovalChainView,
  normalizeChainProgress,
  normalizeChainSteps,
  type ApprovalChainProgressResponse,
  type ApprovalChainStep,
  type ApprovalChainView,
} from "@/lib/approvalChain";

export interface ApprovalChainResult {
  view: ApprovalChainView;
  loading: boolean;
}

/**
 * A chain is an ENRICHMENT above a decision screen. Every failure mode here
 * degrades to "no chain shown" rather than erroring the approval the operator
 * came to read — including the 501/404 a deployment without the chain tables
 * would produce.
 */
export function useApprovalChain(
  approvalId: string | null | undefined,
  resourceType: string | null | undefined,
): ApprovalChainResult {
  const gate = useOnlineQueryGate();

  const steps = useQuery({
    queryKey: ["approval-chain-steps", gate.tenantId, resourceType ?? null],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      Boolean(approvalId) &&
      Boolean(resourceType),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ApprovalChainStep[]> => {
      const { client } = getClient();
      try {
        const res = await client.request<unknown>(
          "GET",
          `/api/v1/approvals/chain?resource_type=${encodeURIComponent(
            resourceType!,
          )}`,
        );
        return normalizeChainSteps(res);
      } catch (err) {
        if (isOptionalResourceError(err)) return [];
        throw err;
      }
    },
  });

  const progress = useQuery({
    queryKey: ["approval-chain-progress", gate.tenantId, approvalId ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(approvalId),
    staleTime: 0,
    queryFn: async (): Promise<ApprovalChainProgressResponse | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<unknown>(
          "GET",
          `/api/v1/approvals/${encodeURIComponent(approvalId!)}/chain`,
        );
        return normalizeChainProgress(res);
      } catch (err) {
        if (isOptionalResourceError(err)) return null;
        throw err;
      }
    },
  });

  // A failed read must not be rendered as "no chain configured" — that would
  // tell an approver nobody is ahead of them when the truth is unknown. Both
  // errors collapse to `configured: false`, and `loading` stays true while
  // either is in flight so the screen shows nothing rather than a false all-
  // clear.
  const view = buildApprovalChainView(
    steps.isError ? [] : (steps.data ?? []),
    progress.isError ? null : (progress.data ?? null),
  );

  return {
    view: steps.isError || progress.isError ? { ...view, configured: false } : view,
    loading: steps.isLoading || progress.isLoading,
  };
}
