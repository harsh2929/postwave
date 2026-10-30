/**
 * hooks/useCampaignAuthoring.ts — the online-only authoring writes on the
 * campaign detail screen.
 *
 * Rides api/campaignAuthoring (PATCH /campaigns/{id} + POST …/audience/freeze,
 * both editor in the routeauth manifest). These writes are DELIBERATELY not on
 * the offline outbox — the PATCH bodies here are built from the freshest
 * server state the client holds (the delivery_settings FULL REPLACE, the
 * audience_mode flip, the goal fields), and the freeze mints a snapshot of the
 * membership NOW. Replaying either from a queue hours later would either
 * overwrite someone else's interim changes or snapshot a different membership
 * than the operator looked at. See api/campaignAuthoring.ts for the full
 * account.
 *
 * Invalidation: a true prefix of everything these writes can change —
 * the campaign record itself (["campaign"]), the list rows (["campaigns"]),
 * the send preview (audience mode / freeze change who receives it) and the
 * insight drilldowns (the goal fields change what goal-results measures).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  freezeCampaignAudience,
  patchCampaignAuthoring,
} from "@/api/campaignAuthoring";
import { checkedApiResult } from "@/api/request";
import { readFreezeResult } from "@/lib/campaignAudienceMode";

/** PATCH /api/v1/campaigns/{id} with an authoring body (mode, goal, sender). */
export function useCampaignAuthoringPatch(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: Record<string, unknown>): Promise<void> => {
      await checkedApiResult(patchCampaignAuthoring(campaignId, body));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-send-preview"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-insight"] });
    },
  });
}

/** POST /api/v1/campaigns/{id}/audience/freeze → how many members froze. */
export function useCampaignAudienceFreeze(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ frozenMembers: number }> => {
      const res = await checkedApiResult(freezeCampaignAudience(campaignId));
      return readFreezeResult(res.data);
    },
    onSuccess: () => {
      // The freeze stamps audience_mode='static' server-side and pins the
      // membership, so the campaign record AND the send preview are stale.
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: ["campaign-send-preview"] });
    },
  });
}
