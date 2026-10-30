/**
 * hooks/useCampaignAiSummary.ts — the read + regenerate pair behind the
 * post-send summary card.
 *
 * Lazily enabled by its card's expanded state, like every other insight: the
 * read is cheap but it is one more request on a screen open, and this card is
 * one of ten.
 *
 * THE 404 IS THE INTERESTING PART. Both "no summary computed yet" and "this
 * gateway has no summary endpoint" answer `404 {code:"not_found"}` — the
 * handler at campaign_summary.go and the router catch-all at main.go:1502 use
 * the same envelope on purpose. So the read resolves a 404 to `absent: true`
 * WITHOUT claiming which, and the regenerate POST is what settles it: if the
 * write also 404/405/501s, the capability genuinely is not installed and the
 * card says so. Every other failure propagates so the card can offer a retry.
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getCampaignSummary,
  regenerateCampaignSummary,
} from "@/api/campaignSummary";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  readCampaignSummary,
  type CampaignSummaryReading,
} from "@/lib/campaignAiSummary";
import type { AIApiError } from "@/api/request";

function isAbsentStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export interface CampaignAiSummaryState {
  reading: CampaignSummaryReading | null;
  loading: boolean;
  /** The read 404'd: either nothing generated yet, or no endpoint. */
  absent: boolean;
  /** Proven by a failed WRITE: this deployment has no summary capability. */
  unsupported: boolean;
  error: unknown;
  regenerate: () => void;
  regenerating: boolean;
  refetch: () => void;
}

export function useCampaignAiSummary(
  campaignId: string | undefined,
  options: { enabled: boolean },
): CampaignAiSummaryState {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const [unsupported, setUnsupported] = useState(false);

  const queryKey = ["campaign-ai-summary", gate.tenantId, campaignId];

  const q = useQuery({
    queryKey,
    enabled:
      options.enabled && gate.enabled && Boolean(gate.tenantId && campaignId),
    staleTime: 60_000,
    queryFn: async () => {
      const res = await getCampaignSummary(campaignId ?? "");
      if (res.error) {
        if (isAbsentStatus(res.error.status)) return null;
        throw res.error;
      }
      return readCampaignSummary(res.data);
    },
  });

  const regen = useMutation({
    mutationFn: async () => {
      const res = await regenerateCampaignSummary(campaignId ?? "");
      if (res.error) throw res.error;
      return readCampaignSummary(res.data);
    },
    onSuccess: (reading) => {
      // Seed the cache directly: the POST returns the freshly-written row, so
      // re-reading it would be a second round trip for bytes we already hold.
      queryClient.setQueryData(queryKey, reading);
      setUnsupported(false);
    },
    onError: (err: unknown) => {
      const status = (err as AIApiError | undefined)?.status ?? 0;
      // The write is the disambiguator the read could not be.
      if (isAbsentStatus(status)) setUnsupported(true);
    },
  });

  const regenerate = useCallback(() => regen.mutate(), [regen]);
  const refetchQuery = q.refetch;
  const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

  const reading = q.data ?? null;
  return {
    reading: reading?.hasBody ? reading : null,
    loading: q.isLoading,
    absent: !q.isLoading && !q.isError && !reading?.hasBody,
    unsupported,
    // A regenerate failure is the one the user just asked for, so it wins the
    // slot; the read error is the fallback.
    error: regen.error ?? q.error,
    regenerate,
    regenerating: regen.isPending,
    refetch,
  };
}
