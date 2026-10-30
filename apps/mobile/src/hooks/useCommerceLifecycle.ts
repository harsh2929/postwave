/**
 * hooks/useCommerceLifecycle.ts — TanStack wiring for the lifecycle report and
 * the eligibility evaluation.
 *
 * NOTHING HERE RUNS ON ITS OWN. The report is a query behind the online gate
 * and an explicit `enabled` flag, so a session without the admin role never
 * fires the request at all. The evaluation is a MUTATION, which TanStack never
 * runs on mount, focus or reconnect — the only thing that can start it is the
 * caller's confirmed press.
 *
 * The invalidation after a successful evaluation covers `recovery` as well as
 * this report: flipping a back-in-stock row to `eligible` is precisely what the
 * recovery queue above it counts as an unkept promise, so leaving that list on
 * its own staleness window would show the operator a queue that contradicts the
 * receipt they were just handed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  evaluateCommerceLifecycle,
  fetchCommerceLifecycleReport,
} from "@/api/commerceLifecycle";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  CommerceLifecycleReport,
  LifecycleEvaluation,
} from "@/lib/commerceLifecycle";

/**
 * Lifecycle demand moves when inventory or prices move — provider webhook
 * territory, not per-second. It shares the store-list window rather than the
 * analytics one because nothing on this card is a running total.
 */
const LIFECYCLE_STALE_MS = 60_000;

export function useCommerceLifecycleReport(
  integrationId: string | null,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<CommerceLifecycleReport | null>({
    queryKey: ["commerce", "lifecycle", gate.tenantId, integrationId],
    enabled:
      enabled &&
      gate.enabled &&
      Boolean(gate.tenantId) &&
      Boolean(integrationId),
    staleTime: LIFECYCLE_STALE_MS,
    queryFn: () => fetchCommerceLifecycleReport(String(integrationId)),
  });
}

export function useEvaluateCommerceLifecycle() {
  const client = useQueryClient();
  return useMutation<LifecycleEvaluation | null, unknown, string>({
    mutationFn: (integrationId: string) =>
      evaluateCommerceLifecycle(integrationId),
    onSuccess: (_data, integrationId) => {
      for (const family of ["lifecycle", "recovery"] as const) {
        void client.invalidateQueries({
          queryKey: ["commerce", family],
          predicate: (query) => query.queryKey.includes(integrationId),
        });
      }
    },
  });
}
