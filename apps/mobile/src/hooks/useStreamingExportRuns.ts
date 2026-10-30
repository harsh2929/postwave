/**
 * hooks/useStreamingExportRuns.ts — TanStack wiring for the streaming-export
 * dock on the warehouse-runs screen.
 *
 * One query for every streaming connection (see `api/streamingExportRuns`),
 * keyed by the SORTED id list so the roster's order cannot churn the cache.
 * Gated the same two ways as the batch reads in `useWarehouseRuns`: the
 * online/auth gate, and the caller's role decision — a request that can only
 * ever answer 403 is not worth a cellular round trip. With no streaming
 * connection in the roster the query is simply disabled: there is nothing to
 * read and nothing to say.
 */
import { useQuery } from "@tanstack/react-query";

import {
  loadStreamingExportHistories,
  type StreamingExportHistoryRead,
} from "@/api/streamingExportRuns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export type { StreamingExportHistoryRead } from "@/api/streamingExportRuns";

/** Windows are the live thing on this dock; same window as the batch runs. */
const HISTORY_STALE_MS = 20_000;

export function useStreamingExportHistories(
  connectionIds: readonly string[],
  allowed: boolean,
) {
  const gate = useOnlineQueryGate();
  const key = [...connectionIds].sort().join(",");
  return useQuery<StreamingExportHistoryRead[]>({
    queryKey: ["warehouse", "streaming-runs", gate.tenantId, key],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      allowed &&
      connectionIds.length > 0,
    staleTime: HISTORY_STALE_MS,
    queryFn: () => loadStreamingExportHistories(connectionIds),
  });
}
