/**
 * hooks/useCampaignReplies.ts — the inbound-reply feed for one campaign.
 *
 * Separate from `useCampaignInsight` because the route is NOT under
 * `/campaigns/{id}/…` — it is `/api/v1/replies/by-campaign/{id}`
 * (apps/api/internal/reply_analytics/reply_analytics.go:54), mounted by the
 * platform-insights group rather than the campaigns group. Folding it into the
 * per-campaign path map would have meant a path token that lies about where
 * the resource lives.
 *
 * Lazily enabled by its card's expanded state like every other insight: the
 * handler runs three aggregates plus a 50-row scan, which is not something a
 * screen open should pay for.
 *
 * 404/405/501 resolves to `null` — a deployment without the reply subsystem is
 * not a failure, and the card says the capability is absent rather than showing
 * a red error for something that was never installed.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { campaignErrorStatus } from "@/lib/campaignErrors";
import type { CampaignRepliesWire } from "@/lib/campaignReplies";

export function useCampaignReplies(
  id: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-replies", gate.tenantId, id],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 60_000,
    queryFn: async (): Promise<CampaignRepliesWire | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<CampaignRepliesWire>(
          "GET",
          `/api/v1/replies/by-campaign/${encodeURIComponent(id ?? "")}`,
        );
        return res ?? null;
      } catch (err) {
        const status = campaignErrorStatus(err);
        if (status === 404 || status === 405 || status === 501) return null;
        throw err;
      }
    },
  });
}
