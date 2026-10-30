/**
 * hooks/useApprovalResourceContext.ts — what is this approval actually about?
 *
 * The approvals API row carries only `resourceType` + `resourceId` (a UUID),
 * not the campaign's name, subject or status. An approver on a phone is being
 * asked to sign off on something irreversible, so an opaque id is not a
 * question anyone should be answering; this resolves the underlying resource
 * so the decision screen can show what is being approved.
 *
 * Split out of `useApprovals.ts` — that module is the approvals CRUD surface
 * (list, poll, decide) and this is a lookup against a DIFFERENT resource, with
 * its own cache keys. `useApprovals` re-exports it, so callers are unchanged.
 *
 * Today only campaign approvals are enriched (the dominant case and the one
 * the audit flagged); sequence/automation approvals fall back to the resource
 * label the screen already renders. The campaign lookup reuses the same cache
 * keys as useCampaign/useCampaignReport, so opening the campaign detail screen
 * afterwards is warm.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  deriveApprovalCampaignContext,
  isOptionalResourceError,
  type ApprovalCampaign,
  type ApprovalCampaignReport,
  type ApprovalResourceContext,
} from "@/lib/approvalPolicy";

/**
 * Only the two fields this lookup reads, declared locally rather than imported
 * from `useApprovals`. That module re-exports this one, so importing its
 * `Approval` type back would close an import cycle for the sake of two string
 * fields — and a narrower parameter is a better signature anyway: it says
 * exactly what the hook looks at.
 */
interface ApprovalResourceRef {
  resourceType?: string | null;
  resourceId?: string | null;
}

export function useApprovalResourceContext(
  approval: ApprovalResourceRef | null | undefined,
): ApprovalResourceContext {
  const gate = useOnlineQueryGate();
  const isCampaign = approval?.resourceType === "campaign";
  const resourceId = approval?.resourceId ?? null;

  const campaignQuery = useQuery({
    queryKey: ["campaign", gate.tenantId, resourceId],
    enabled: gate.enabled && Boolean(isCampaign && resourceId && gate.tenantId),
    queryFn: async (): Promise<ApprovalCampaign | null> => {
      const { client } = getClient();
      try {
        return (await client.campaigns.get(
          resourceId!,
        )) as unknown as ApprovalCampaign;
      } catch (err) {
        if (!isOptionalResourceError(err)) throw err;
        return null;
      }
    },
    staleTime: 30_000,
  });

  const reportQuery = useQuery({
    queryKey: ["campaign-report", gate.tenantId, resourceId],
    enabled: gate.enabled && Boolean(isCampaign && resourceId && gate.tenantId),
    queryFn: async (): Promise<ApprovalCampaignReport | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<ApprovalCampaignReport>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(resourceId!)}/report`,
        );
        return res ?? null;
      } catch (err) {
        if (!isOptionalResourceError(err)) throw err;
        return null;
      }
    },
    staleTime: 30_000,
  });

  if (!isCampaign) {
    return { loading: false };
  }
  const derived = deriveApprovalCampaignContext(
    campaignQuery.data ?? null,
    reportQuery.data ?? null,
  );
  return {
    ...derived,
    loading: campaignQuery.isLoading || reportQuery.isLoading,
  };
}
