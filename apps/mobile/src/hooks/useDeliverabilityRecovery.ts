/**
 * useDeliverabilityRecovery — containment policies and recovery queues.
 *
 * Reads are rollups (5-minute staleTime). Writes are ONLINE-ONLY and never
 * queued: an auto-suppress flip is a live containment policy, and moving a
 * held recipient acts on a queue a worker is also draining.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAutoSuppress,
  fetchRetryEvents,
  fetchSoftBounceStats,
  fetchSpamTrapHits,
  fetchSpamTrapStats,
  runSoftBounceRecovery,
  setAutoSuppress,
  setRetryEventStatus,
  type AutoSuppressState,
  type RetryEvent,
  type RetryEventAction,
  type SoftBounceStats,
  type SpamTrapHit,
  type SpamTrapStats,
} from "@/api/deliverabilityRecovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isExactTenantAdminRole } from "@/lib/campaignAccess";

const ROLLUP_STALE_MS = 5 * 60_000;
const AUTO_SUPPRESS_KEY = "blocklist-auto-suppress";
const RETRY_EVENTS_KEY = "intelligent-retry-events";

export function useAutoSuppress() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [AUTO_SUPPRESS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: (): Promise<AutoSuppressState> => fetchAutoSuppress(),
  });
}

export function useSetAutoSuppress() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<AutoSuppressState, Error, boolean>({
    mutationFn: (enabled) => setAutoSuppress(enabled),
    onSuccess: (state) => {
      // PATCH answers the fresh state as a receipt — seed the cache with the
      // SERVER's copy, then invalidate for the counters.
      queryClient.setQueryData([AUTO_SUPPRESS_KEY, gate.tenantId], state);
      void queryClient.invalidateQueries({
        queryKey: [AUTO_SUPPRESS_KEY, gate.tenantId],
      });
    },
  });
}

export function useSpamTrapStats() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["spam-trap-stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: (): Promise<SpamTrapStats> => fetchSpamTrapStats(),
  });
}

export function useSpamTrapHits(days = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["spam-trap-hits", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: (): Promise<SpamTrapHit[]> => fetchSpamTrapHits(days),
  });
}

export function useSoftBounceStats() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["soft-bounce-stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROLLUP_STALE_MS,
    queryFn: (): Promise<SoftBounceStats> => fetchSoftBounceStats(),
  });
}

export function useRunSoftBounceRecovery() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<{ expiredSuppressions: number }, Error, void>({
    mutationFn: () => runSoftBounceRecovery(),
    // A retry starts a SECOND pass while the first may still be running.
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["soft-bounce-stats", gate.tenantId],
      });
    },
  });
}

export function useRetryEvents() {
  const gate = useOnlineQueryGate();
  const admin = isExactTenantAdminRole(gate.effectiveRole);
  return useQuery({
    // Retry evidence includes subscriber addresses. Bind the cache to the
    // exact principal/role so an admin result cannot bleed through a role or
    // account switch, and never dispatch the private request below admin.
    queryKey: [
      RETRY_EVENTS_KEY,
      gate.tenantId,
      gate.userId,
      gate.effectiveRole,
    ],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && Boolean(gate.userId) && admin,
    staleTime: 60_000,
    queryFn: (): Promise<RetryEvent[]> => fetchRetryEvents(gate.tenantId!),
  });
}

export function useSetRetryEventStatus() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<
    RetryEvent,
    Error,
    { id: string; action: RetryEventAction; expectedUpdatedAt: string }
  >({
    mutationFn: async ({ id, action, expectedUpdatedAt }) => {
      if (!isExactTenantAdminRole(gate.effectiveRole)) {
        throw new Error(
          "Workspace owner or admin access is required to change held retries.",
        );
      }
      if (!gate.tenantId) {
        throw new Error("The active workspace could not be verified.");
      }
      return setRetryEventStatus(id, action, expectedUpdatedAt, gate.tenantId);
    },
    // The response can be lost after the CAS commits. Replaying blindly would
    // act against a revision the operator has not re-read.
    retry: false,
    onSettled: () => {
      // Settled, not success: a 404 means a worker already promoted the row,
      // so our copy of the queue is stale either way.
      void queryClient.invalidateQueries({
        queryKey: [RETRY_EVENTS_KEY, gate.tenantId],
      });
    },
  });
}
