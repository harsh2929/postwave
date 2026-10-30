/**
 * hooks/useCampaignHealth.ts — the two per-campaign warning reads.
 *
 * Both are lazily enabled by their card's expanded state, like every other
 * insight: /health runs a 30-day aggregate and /anomalies runs an hourly
 * z-score pass, and neither should be paid for on a screen open.
 *
 * A deployment that doesn't expose either answers 404/405/501, which resolves
 * to `null` — the card then says the capability is absent instead of showing a
 * red error for something that simply isn't installed. Everything else
 * propagates so the card can offer a retry.
 */
import { useQuery } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  CampaignAnomaliesResponse,
  CampaignHealthResponse,
} from "@/lib/campaignHealth";
import { campaignErrorStatus } from "@/lib/campaignErrors";

function isAbsentEndpoint(err: unknown): boolean {
  const status = campaignErrorStatus(err);
  return status === 404 || status === 405 || status === 501;
}

function useCampaignSignal<T>(
  key: string,
  path: string,
  id: string | undefined,
  options: { enabled: boolean },
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["campaign-signal", gate.tenantId, id, key],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId && id),
    staleTime: 60_000,
    queryFn: async (): Promise<T | null> => {
      const { client } = getClient();
      try {
        const res = await client.request<T>(
          "GET",
          `/api/v1/campaigns/${encodeURIComponent(id!)}/${path}`,
        );
        return res ?? null;
      } catch (err) {
        if (isAbsentEndpoint(err)) return null;
        throw err;
      }
    },
  });
}

export function useCampaignHealth(
  id: string | undefined,
  options: { enabled: boolean },
) {
  return useCampaignSignal<CampaignHealthResponse>(
    "health",
    "health",
    id,
    options,
  );
}

export function useCampaignAnomalies(
  id: string | undefined,
  options: { enabled: boolean },
) {
  return useCampaignSignal<CampaignAnomaliesResponse>(
    "anomalies",
    "anomalies",
    id,
    options,
  );
}
