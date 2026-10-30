/**
 * hooks/useSpendControls.ts — the billing meter and the switch that stops it.
 *
 * ONLINE-ONLY, NEVER QUEUED. An overage change that sits in an offline queue is
 * the same failure as a queued revoke: the operator believes spend is capped
 * while sends keep billing. If the device cannot reach the server, the honest
 * answer is "this hasn't happened yet".
 *
 * The SMS balance is a SEPARATE query rather than part of the same one, because
 * a workspace with no SMS program returns an error there while its billing
 * state is perfectly fine — folding them together would let a 404 on credits
 * blank out the spend cap the operator came to set.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchSendingAddon,
  fetchSmsCreditBalance,
  setOverage,
} from "@/api/spendControls";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  SendingAddonLike,
  SmsCreditBalanceLike,
} from "@/lib/spendControls";

const ADDON_KEY = "billing-sending-addon";
const SMS_CREDITS_KEY = "sms-credit-balance";

export function useSendingAddon() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [ADDON_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 30_000,
    queryFn: (): Promise<SendingAddonLike | null> => fetchSendingAddon(),
  });
}

export function useSmsCreditBalance() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SMS_CREDITS_KEY, gate.tenantId],
    // The server contract is a stable source hold. Keep this legacy hook
    // non-requesting so any remaining consumer cannot generate recurring 503
    // noise or mistake an old balance for current entitlement.
    enabled: false,
    staleTime: 30_000,
    // A workspace with no SMS program answers 4xx here. That is not worth
    // retrying — the answer will not change — and a retry storm on a money
    // endpoint is worse than an empty section.
    retry: false,
    queryFn: (): Promise<SmsCreditBalanceLike | null> =>
      fetchSmsCreditBalance(),
  });
}

export function useSetOverage() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<
    SendingAddonLike | null,
    Error,
    { enabled: boolean; cap: number | undefined }
  >({
    mutationFn: ({ enabled, cap }) => setOverage(enabled, cap),
    onSuccess: (fresh) => {
      // The PUT returns the refreshed state, so seed the cache with the
      // server's answer rather than the value that was typed: if the server
      // clamped or ignored anything, the screen must show what is actually
      // stored, not what was asked for.
      if (fresh !== undefined) {
        qc.setQueryData([ADDON_KEY, gate.tenantId], fresh);
      }
      void qc.invalidateQueries({ queryKey: [ADDON_KEY, gate.tenantId] });
    },
  });
}
