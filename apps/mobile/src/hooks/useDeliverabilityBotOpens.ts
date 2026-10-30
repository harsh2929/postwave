/**
 * useDeliverabilityBotOpens — human-vs-machine open stats and the signature
 * list that decides the split.
 *
 * Signature writes are ONLINE-ONLY: a queued pattern change re-classifies
 * every open recorded between queue and replay, silently rewriting engagement
 * history the operator already read.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createBotOpenSignature,
  deleteBotOpenSignature,
  fetchBotOpenSignatures,
  fetchBotOpenStats,
  type BotOpenSignature,
  type BotOpenStats,
} from "@/api/botOpens";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

const STATS_KEY = "bot-open-stats";
const SIGNATURES_KEY = "bot-open-signatures";

/** `armed` keeps this regex-scan read lazy — the card loads it on demand. */
export function useBotOpenStats(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [STATS_KEY, gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: (): Promise<BotOpenStats> => fetchBotOpenStats(),
  });
}

export function useBotOpenSignatures(armed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SIGNATURES_KEY, gate.tenantId],
    enabled: armed && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: (): Promise<BotOpenSignature[]> => fetchBotOpenSignatures(),
  });
}

export function useCreateBotOpenSignature() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, { label: string; pattern: string }>({
    mutationFn: (input) => createBotOpenSignature(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SIGNATURES_KEY, gate.tenantId],
      });
      void queryClient.invalidateQueries({ queryKey: [STATS_KEY, gate.tenantId] });
    },
  });
}

export function useDeleteBotOpenSignature() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteBotOpenSignature(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SIGNATURES_KEY, gate.tenantId],
      });
      void queryClient.invalidateQueries({ queryKey: [STATS_KEY, gate.tenantId] });
    },
  });
}
