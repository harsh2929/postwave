/**
 * hooks/useSmsCampaigns.ts — the SMS campaign list and its state verbs.
 *
 * The list is `viewer` (reviewed) while every verb is `editor`, so a viewer can
 * WATCH a send without being offered controls that 403 — which is right: seeing
 * that an SMS campaign is running is exactly the information a viewer needs in
 * order to go find someone who can stop it.
 *
 * `refetchInterval` is short while anything is actively sending. This is the one
 * screen in the app where the underlying state changes by itself AND costs money
 * per second, so a stale "sending" is materially worse than an extra request.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchSmsCampaigns,
  runSmsCampaignVerb,
  type SmsCampaignRow,
} from "@/api/smsCampaigns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { smsCampaignIsSending, type SmsCampaignVerb } from "@/lib/smsCampaignControls";

const KEY = "sms-campaigns";

export function useSmsCampaigns() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const rows = query.state.data;
      if (!Array.isArray(rows)) return false;
      return rows.some((row) => smsCampaignIsSending(row.status)) ? 5_000 : false;
    },
    queryFn: (): Promise<SmsCampaignRow[]> => fetchSmsCampaigns(),
  });
}

export function useRunSmsCampaignVerb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; verb: SmsCampaignVerb }): Promise<void> =>
      runSmsCampaignVerb(input),
    onSettled: () => {
      // Refetch on failure too: a 409 means the campaign moved on, so the status
      // the operator is looking at is precisely what must not survive the error.
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
  });
}
