/**
 * hooks/useCampaignSendTimeDefault.ts — the workspace default for send-time
 * optimization on NEW campaigns.
 *
 * GET/PUT /api/v1/settings/send-time-optimization — BOTH admin in the
 * routeauth manifest (family:admin), the same floor the send-time screen
 * already enforces on its analysis read, which is why the toggle lives on
 * that screen and is never offered below admin.
 *
 * ONLINE-ONLY: it is a workspace-wide policy bit; queueing a stale copy for
 * replay could flip a default someone else set in the meantime.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getSendTimeOptimizationSetting,
  putSendTimeOptimizationSetting,
} from "@/api/campaignSendTimeSetting";
import { checkedApiResult } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { readSendTimeSetting } from "@/lib/sendTimeWorkspaceSetting";

const KEY = "send-time-default";

export function useSendTimeDefault(options: { enabled: boolean }) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled: options.enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<boolean | null> => {
      const res = await checkedApiResult(getSendTimeOptimizationSetting());
      return readSendTimeSetting(res.data);
    },
  });
}

export function useSendTimeDefaultWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean): Promise<void> => {
      await checkedApiResult(putSendTimeOptimizationSetting(enabled));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [KEY] });
    },
  });
}
