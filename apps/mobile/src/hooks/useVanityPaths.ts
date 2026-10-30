/**
 * hooks/useVanityPaths.ts — a campaign's short addresses (F04).
 *
 * GET is `viewer` + reviewed. Creating one is `editor` and stays off mobile: a
 * short address is a permanent public URL printed in an email, and choosing its
 * slug is authoring rather than an on-call act.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseCampaignDirectAttributionPage,
  parseVanityPaths,
  type CampaignDirectAttributionPage,
  type VanityPath,
} from "@/lib/vanityPaths";

export function useVanityPaths(campaignId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["vanity-paths", gate.tenantId, campaignId],
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<VanityPath[]> => {
      const res = await rawRequest<unknown>(
        "GET",
        `/api/v1/campaigns/${encodeURIComponent(campaignId!)}/vanity-paths`,
      );
      if (res.error)
        throw Object.assign(new Error(res.error.message), res.error);
      return parseVanityPaths(res.data);
    },
  });
}

export function useCampaignDirectAttributionEvidence(
  campaignId: string | undefined,
) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: ["direct-attribution-evidence", gate.tenantId, campaignId],
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 5 * 60_000,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<CampaignDirectAttributionPage> => {
      const offset = Number(pageParam);
      const res = await rawRequest<unknown>(
        "GET",
        "/api/v1/campaigns/" +
          encodeURIComponent(campaignId!) +
          "/direct-attribution-evidence?limit=25&offset=" +
          offset,
      );
      if (res.error)
        throw Object.assign(new Error(res.error.message), res.error);
      const parsed = parseCampaignDirectAttributionPage(res.data, campaignId!);
      if (!parsed) {
        throw new Error(
          "The campaign attribution evidence response was invalid; it was not treated as an empty register.",
        );
      }
      return parsed;
    },
    getNextPageParam: (lastPage) => lastPage.nextOffset,
  });
}
