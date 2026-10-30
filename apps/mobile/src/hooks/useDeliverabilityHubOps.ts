/**
 * useDeliverabilityHubOps — the hub's operator verb and its recovery evidence.
 *
 * The repair-override mutation is ONLINE-ONLY AND NEVER QUEUED: releasing a
 * throttle re-opens live sending capacity, and a queued release landing later
 * acts at a moment nobody chose. On ANY settle — success, 404 "no override",
 * 409 "cap drifted" — the hub is refetched, because every one of those answers
 * means our copy of the throttle state is stale.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  clearRepairOverride,
  fetchWebhookErrors,
  type RepairOverrideOutcome,
  type WebhookErrorsReport,
} from "@/api/deliverabilityHubOps";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useClearRepairOverride() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const mutation = useMutation<RepairOverrideOutcome, Error, void>({
    mutationFn: () => clearRepairOverride(),
    // Never automatic: the first attempt may have cleared the override while
    // the response was lost, and a retry would then 404 and read as failure.
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["deliverability-hub", gate.tenantId],
      });
    },
  });
  return {
    ...mutation,
    /**
     * A separate, user-directed recovery read. The mutation's automatic
     * invalidation keeps the screen current, but an outcome-unknown response
     * remains held until the operator explicitly verifies current state; this
     * method is that boundary and never dispatches the POST again.
     */
    reconcile: async () => {
      await queryClient.refetchQueries(
        {
          queryKey: ["deliverability-hub", gate.tenantId],
          type: "active",
        },
        { throwOnError: true },
      );
    },
  };
}

/** Failed webhook deliveries + failed DNS verifications, last 7 days. */
export function useWebhookErrors() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["deliverability-webhook-errors", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: (): Promise<WebhookErrorsReport> => fetchWebhookErrors(),
  });
}
