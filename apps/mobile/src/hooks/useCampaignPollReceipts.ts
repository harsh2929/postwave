import { useQuery } from "@tanstack/react-query";

import { listCampaignPollReceipts } from "@/api/campaignPolls";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useCampaignPollReceipts(campaignId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-poll-receipts", gate.tenantId, campaignId],
    enabled: gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 30_000,
    retry: false,
    queryFn: () => listCampaignPollReceipts(campaignId!),
  });
}
