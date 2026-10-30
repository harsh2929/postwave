/**
 * hooks/useIdempotencyLedger.ts — "did that request run twice?".
 *
 * Two admin reads with no writes attached. Gated on an admin role rather than
 * discovering the floor through a 403, and never retried: a workspace with an
 * empty ledger or a disabled inspector answers the same way twice.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchIdempotencyStats,
  listPendingIdempotencyKeys,
} from "@/api/idempotencyKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type {
  IdempotencyKeyLike,
  IdempotencyStatsLike,
} from "@/lib/idempotencyKeys";

export function useIdempotencyStats() {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery({
    queryKey: ["idempotency-stats", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 30_000,
    retry: false,
    queryFn: (): Promise<IdempotencyStatsLike | null> => fetchIdempotencyStats(),
  });
}

export function usePendingIdempotencyKeys(enabled: boolean) {
  const gate = useOnlineQueryGate();
  const mayRead = canAccessMinimumRole("admin", gate.effectiveRole);
  return useQuery({
    queryKey: ["idempotency-pending", gate.tenantId],
    // Only fetched when the stats say there IS something mid-flight: the list
    // is the follow-up question, and asking it unprompted spends a request on
    // an answer nobody needed.
    enabled: enabled && gate.enabled && Boolean(gate.tenantId) && mayRead,
    staleTime: 15_000,
    retry: false,
    queryFn: (): Promise<IdempotencyKeyLike[]> => listPendingIdempotencyKeys(),
  });
}
