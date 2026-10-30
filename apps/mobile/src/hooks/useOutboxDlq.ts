/**
 * hooks/useOutboxDlq.ts — the transactional outbox DLQ and its replay.
 *
 * Both routes are admin (reviewed), so the query is role-gated rather than left to
 * collect a 403 and render as "the queue is empty" — which on this screen would be
 * the most misleading empty state in the app.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { parseOutboxDlq, type OutboxDlqEntry } from "@/lib/outboxDlq";
import { newOfflineOperationId } from "@/lib/offlineMutations";

const KEY = "outbox-dlq";

export function useOutboxDlq() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [KEY, gate.tenantId],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      canAccessMinimumRole("admin", gate.effectiveRole),
    staleTime: 30_000,
    queryFn: async (): Promise<OutboxDlqEntry[]> => {
      const res = await rawRequest<unknown>("GET", "/api/v1/dlq");
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
      return parseOutboxDlq(res.data);
    },
  });
}

export function useReplayOutboxEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const entryId = id.trim();
      if (!entryId) throw new Error("dlq entry id is required");
      const res = await rawRequest<unknown>(
        "POST",
        `/api/v1/dlq/${encodeURIComponent(entryId)}/replay`,
        {},
        // A replay re-runs a side effect. If the response is lost and the client
        // retries, the key is what stops the effect happening twice.
        { idempotencyKey: newOfflineOperationId() },
      );
      if (res.error) throw Object.assign(new Error(res.error.message), res.error);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [KEY] }),
  });
}
