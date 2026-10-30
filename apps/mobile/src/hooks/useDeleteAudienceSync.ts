/**
 * hooks/useDeleteAudienceSync.ts — the one destructive verb on the audience
 * syncs surface.
 *
 * A SEPARATE HOOK MODULE from useAudienceSyncs so the query keys it invalidates
 * stay imported from there (one owner for the key grammar) while this file adds
 * nothing to a module whose header argues the opposite verb set.
 *
 * NOT OPTIMISTIC. Removing the row locally before the server answers would show
 * "gone" for the 409 a mid-delivery sync answers with (syncs.go:713) — the one
 * case where the operator most needs to know the sync is still there and still
 * pushing.
 *
 * NOT QUEUED OFFLINE. It is never registered in lib/offlineMutationContract, so
 * the queue in lib/offlineMutations never sees it: a delete released hours later
 * would destroy a run ledger at a moment nobody chose and would race whatever
 * was done at a desk in between.
 *
 * BOTH CACHES ARE INVALIDATED, and the RUN history one is not merely tidy: the
 * runs cascade with the sync (FK), so a stale history left in the cache would
 * outlive the rows it describes. `onSettled` rather than `onSuccess` because a
 * client-side timeout may still have deleted the sync server-side.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { deleteAudienceSync } from "@/api/audienceSyncDelete";
import {
  audienceSyncRunsQueryKey,
  audienceSyncsQueryKey,
} from "@/hooks/useAudienceSyncs";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export interface DeleteSyncInput {
  syncId: string;
}

export function useDeleteAudienceSync() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, DeleteSyncInput>({
    mutationFn: ({ syncId }) => deleteAudienceSync(syncId),
    // No `retry`: a DELETE that timed out client-side may well have succeeded,
    // and a second attempt would answer 404 and read as a failure.
    onSettled: (_result, _error, variables) => {
      void queryClient.invalidateQueries({
        queryKey: audienceSyncsQueryKey(gate.tenantId),
      });
      void queryClient.invalidateQueries({
        queryKey: audienceSyncRunsQueryKey(gate.tenantId, variables.syncId),
      });
    },
  });
}
