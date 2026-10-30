/**
 * hooks/useAudienceSyncs.ts — the sync catalogue, one sync's run history, and
 * the single verb this surface exposes.
 *
 * WHY THE LIST IS ENOUGH TO TRIAGE, AND THE HISTORY IS STILL LAZY.
 * `syncSelectColumns` (syncs.go:308) carries `last_run_at` AND `last_run_status`
 * — the terminal status is denormalised onto the sync row inside the same
 * transaction that closes the run (operation_safety.go:340). So unlike agent
 * routines, the list can honestly say "the nightly sync failed" with one
 * request. What the list CANNOT say is WHY: the error text, the rows delivered,
 * and how many members the consent firewall withheld live only on the run row.
 * That is the seam — the list triages, the sheet explains — and it is why the
 * history is one lazy request per opened sync rather than N on mount.
 *
 * WHY THE RUN HISTORY POLLS, AND ONLY SOMETIMES. A run started by the SCHEDULER
 * (sync_scheduler.go, a minute tick) or from another device lands in this
 * history with no push and no stream. The callback form of `refetchInterval`
 * re-decides after every response, so the poll stops dead the instant the last
 * live run reaches a terminal status rather than burning a request every five
 * seconds for the rest of the session.
 *
 * WHY RUN-NOW IS NOT OPTIMISTIC AND NOT QUEUED OFFLINE. It is not optimistic
 * because the response IS the outcome — `RunSync` executes inline and returns
 * the closed row (sync_handlers.go:176-193), so there is nothing to guess at
 * and a guess would be overwritten a second later by the truth. It is not
 * queued because a run delivers real subscriber records to a third party;
 * releasing one from an offline queue hours later would push an audience at a
 * destination at a moment nobody chose, AND would restart the schedule clock.
 * The mutation is online-only by construction: it is never registered in
 * lib/offlineMutationContract, so the queue in lib/offlineMutations never sees
 * it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAudienceSyncRuns,
  fetchAudienceSyncs,
  runAudienceSyncNow,
} from "@/api/audienceSyncs";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { hasLiveRun, type AudienceSync, type AudienceSyncRun } from "@/lib/audienceSyncs";

const SYNCS_KEY = "audience-syncs";
const RUNS_KEY = "audience-sync-runs";

/**
 * The scheduler ticks once a minute, so `last_run_status` can change without
 * anyone touching the phone. Thirty seconds keeps a foregrounded screen close
 * to the truth without polling the list.
 */
const SYNCS_STALE_MS = 30_000;

/** One scheduler tick is a minute; five seconds is responsive without spam. */
const LIVE_RUN_POLL_MS = 5_000;

export function audienceSyncsQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [SYNCS_KEY, tenantId ?? null];
}

export function audienceSyncRunsQueryKey(
  tenantId: string | null | undefined,
  syncId: string | null,
): readonly unknown[] {
  return [RUNS_KEY, tenantId ?? null, syncId];
}

export function useAudienceSyncs() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: audienceSyncsQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: SYNCS_STALE_MS,
    queryFn: (): Promise<AudienceSync[]> => fetchAudienceSyncs(),
  });
}

/**
 * One sync's runs. `staleTime: 0` because the sheet is opened precisely to find
 * out what broke, and the list behind it may be half a minute old.
 */
export function useAudienceSyncRuns(syncId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: audienceSyncRunsQueryKey(gate.tenantId, syncId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(syncId),
    staleTime: 0,
    queryFn: (): Promise<AudienceSyncRun[]> => fetchAudienceSyncRuns(syncId!),
    refetchInterval: (query) => {
      const runs = query.state.data as AudienceSyncRun[] | undefined;
      if (!runs || runs.length === 0) return false;
      // `Date.now()` here rather than a ticker: this decision is remade after
      // every response, and it only has to decide whether a run is still
      // inside its execution bound.
      return hasLiveRun(runs, Date.now()) ? LIVE_RUN_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}

export interface RunSyncNowInput {
  syncId: string;
  /** Minted per press by `newRunOperationKey`; see api/audienceSyncs. */
  idempotencyKey: string;
}

export function useRunAudienceSyncNow() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<AudienceSyncRun | null, Error, RunSyncNowInput>({
    mutationFn: ({ syncId, idempotencyKey }) =>
      runAudienceSyncNow(syncId, idempotencyKey),
    // No `retry`. TanStack's default for mutations is already 0, and stating it
    // would be the wrong instinct anyway: the SDK retries the TRANSPORT under
    // one idempotency key, whereas a mutation-level retry would re-enter
    // `mutationFn` and mint a second key — that is a second delivery.
    onSettled: (_run, _error, variables) => {
      // BOTH caches are now wrong, whichever way the run went: the history is
      // missing the row that just closed, and `last_run_at`/`last_run_status`
      // on the sync row were rewritten by `finishSyncOperationTx` — so the
      // health state and the overdue arithmetic every list row derives from
      // them have changed too. Refreshing only the history would leave the list
      // quietly claiming the sync still failed, or still succeeded.
      //
      // `onSettled` rather than `onSuccess`: a client-side TIMEOUT leaves a run
      // genuinely in flight server-side, so the failure path needs the refresh
      // at least as much as the success path does.
      void queryClient.invalidateQueries({
        queryKey: audienceSyncRunsQueryKey(gate.tenantId, variables.syncId),
      });
      void queryClient.invalidateQueries({
        queryKey: audienceSyncsQueryKey(gate.tenantId),
      });
    },
  });
}
