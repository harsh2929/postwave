/**
 * hooks/useReplyClassification.ts — the addressable reply list, and classify.
 *
 * Reads GET /api/v1/campaigns/{id}/replies (viewer + reviewed) rather than the
 * analytics rollup mobile already consumes: only this route returns a reply `id`,
 * which is what makes the verb possible at all. Classify is write:campaigns.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseCampaignReplies,
  type CampaignReply,
  type ReplyIntent,
} from "@/lib/replyClassification";

const KEY = "campaign-replies-addressable";

function base(campaignId: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/replies`;
}

export function useAddressableReplies(campaignId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId, campaignId],
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 60_000,
    queryFn: async (): Promise<CampaignReply[]> => {
      const res = await rawRequest<unknown>("GET", `${base(campaignId!)}?limit=25`);
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseCampaignReplies(res.data);
    },
  });
}

export function useClassifyReply(campaignId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      replyId: string;
      intent: ReplyIntent;
    }): Promise<void> => {
      if (!campaignId) throw new Error("no campaign");
      const replyId = input.replyId.trim();
      if (!replyId) throw new Error("reply id is required");
      const res = await rawRequest<unknown>(
        "POST",
        `${base(campaignId)}/${encodeURIComponent(replyId)}/classify`,
        { intent: input.intent },
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
