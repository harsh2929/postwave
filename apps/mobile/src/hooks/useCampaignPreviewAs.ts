/**
 * hooks/useCampaignPreviewAs.ts — the reads behind the "what will they see?"
 * sheet.
 *
 * The region list is a QUERY, enabled only while the sheet is open: it parses
 * the campaign body server-side and no one wants that on every detail-screen
 * paint. The preview itself is a MUTATION even though it writes nothing —
 * it is an explicit, per-address action the operator triggers, and modelling
 * it as a query would key a cache on every half-typed email address.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  getCampaignRegions,
  previewCampaignAsSubscriber,
} from "@/api/campaignPreviewAs";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  campaignPreviewAsProblem,
  type CampaignPreviewAsResponse,
  type CampaignRegionsResponse,
} from "@/lib/campaignPreviewAs";

export interface CampaignRegionsResult {
  regions: CampaignRegionsResponse | null;
  /** Non-null when the region list could not be read. Already user-facing. */
  problem: string | null;
}

export function useCampaignRegions(
  campaignId: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-regions", gate.tenantId, campaignId],
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 60_000,
    queryFn: async (): Promise<CampaignRegionsResult> => {
      const res = await getCampaignRegions(campaignId!);
      if (res.error) {
        return {
          regions: null,
          problem: campaignPreviewAsProblem(
            res.error.status,
            res.error.code,
            res.error.message,
          ),
        };
      }
      return { regions: res.data ?? null, problem: null };
    },
  });
}

export function usePreviewCampaignAs(campaignId: string | undefined) {
  return useMutation({
    mutationFn: async (email: string): Promise<CampaignPreviewAsResponse> => {
      const res = await previewCampaignAsSubscriber(campaignId!, email);
      if (res.error) {
        // The sheet renders `error.message` directly, so the classification
        // has to happen here rather than at the render site — otherwise a
        // `subscriber_not_found` reads as a generic failure.
        throw new Error(
          campaignPreviewAsProblem(
            res.error.status,
            res.error.code,
            res.error.message,
          ),
        );
      }
      return res.data ?? {};
    },
  });
}
