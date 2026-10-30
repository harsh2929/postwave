/**
 * hooks/useAgentRoutines.ts — the routine catalogue, one routine's run
 * history, and the single verb this surface exposes.
 *
 * WHY THE RUN HISTORY IS A SEPARATE, LAZY QUERY. `Repo.ListRoutines` selects
 * `routineColumns`, which carries `last_run_at` and NOTHING about the outcome
 * of that run; only `GET /{id}/runs` knows whether it failed. There is no
 * cross-routine run feed anywhere in the API, so answering "did any of these
 * fail?" for a whole list would be one request per row. The surface is
 * therefore shaped honestly: the list says WHEN each routine last ran, and the
 * outcome appears when you open one. A list row that guessed a status would be
 * the exact "absence rendered as a value" failure this codebase keeps hitting.
 *
 * WHY THE RUN HISTORY POLLS, AND ONLY SOMETIMES. `POST /{id}/run` answers 202
 * and does the drafting work in a DETACHED goroutine — so the result of the
 * button you just pressed arrives seconds to minutes later, with no push and
 * no stream. Without a poll the operator would have to pull-to-refresh at a
 * blank screen to find out whether their run worked. The callback form of
 * `refetchInterval` re-decides after every response, so the poll stops dead the
 * instant the last live run reaches a terminal status rather than burning a
 * request every five seconds for the rest of the session.
 *
 * WHY NOTHING IS OPTIMISTIC AND NOTHING IS QUEUED OFFLINE. A run spends LLM
 * quota and cannot be cancelled by any endpoint in the package, so a queued
 * "Run now" released from an offline queue hours later would spend that quota
 * at a moment nobody chose — and would silently reset the routine's schedule
 * clock (`InsertRun` stamps `last_run_at = now()`). The mutation is online-only
 * by construction: it is never registered in lib/offlineMutationContract, so
 * the queue in lib/offlineMutations never sees it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchAgentRoutines,
  fetchAgentRoutineRuns,
  runAgentRoutineNow,
  setAgentRoutineEnabled,
} from "@/api/agentRoutines";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  hasLiveRun,
  type AgentRoutine,
  type AgentRoutineRun,
  type RunNowAck,
} from "@/lib/agentRoutines";

const ROUTINES_KEY = "agent-routines";
const RUNS_KEY = "agent-routine-runs";

/**
 * Routines are standing configuration edited on a desktop, not a live feed —
 * but `last_run_at` moves every time the scheduler fires, and that is the
 * column this screen's whole "next run" derivation hangs off.
 */
const ROUTINES_STALE_MS = 60_000;

/** One scheduler tick is a minute; five seconds is responsive without spam. */
const LIVE_RUN_POLL_MS = 5_000;

export function agentRoutinesQueryKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return [ROUTINES_KEY, tenantId ?? null];
}

export function agentRoutineRunsQueryKey(
  tenantId: string | null | undefined,
  routineId: string | null,
): readonly unknown[] {
  return [RUNS_KEY, tenantId ?? null, routineId];
}

export function useAgentRoutines() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: agentRoutinesQueryKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: ROUTINES_STALE_MS,
    queryFn: (): Promise<AgentRoutine[]> => fetchAgentRoutines(),
  });
}

/**
 * One routine's runs. `staleTime: 0` because the detail is opened precisely to
 * find out what happened, and the list behind it may be a minute old.
 */
export function useAgentRoutineRuns(routineId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: agentRoutineRunsQueryKey(gate.tenantId, routineId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(routineId),
    staleTime: 0,
    queryFn: (): Promise<AgentRoutineRun[]> =>
      fetchAgentRoutineRuns(routineId!),
    refetchInterval: (query) => {
      const runs = query.state.data as AgentRoutineRun[] | undefined;
      if (!runs || runs.length === 0) return false;
      // `Date.now()` here rather than a ticker: this decision is remade after
      // every response, and it only has to decide whether a run is still
      // inside its three-minute execution bound.
      return hasLiveRun(runs, Date.now()) ? LIVE_RUN_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}

export interface RunNowInput {
  routineId: string;
}

export interface SetRoutineEnabledInput {
  routineId: string;
  enabled: boolean;
}

/**
 * Pause or resume a standing routine.
 *
 * ONLINE-ONLY AND NEVER QUEUED, like every other "stop it" verb in this app: a
 * queued pause means the operator believes a routine is stopped while its
 * schedule keeps firing and spending AI credit.
 *
 * Invalidates the ROUTINE LIST only. Unlike run-now this touches no run
 * history — nothing already in flight is cancelled — so refreshing the runs
 * cache would be a request that can only return what it already has.
 */
export function useSetAgentRoutineEnabled() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<void, Error, SetRoutineEnabledInput>({
    mutationFn: ({ routineId, enabled }) =>
      setAgentRoutineEnabled(routineId, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: agentRoutinesQueryKey(gate.tenantId),
      });
    },
  });
}

export function useRunAgentRoutineNow() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  return useMutation<RunNowAck | null, Error, RunNowInput>({
    mutationFn: ({ routineId }) => runAgentRoutineNow(routineId),
    onSuccess: (_ack, variables) => {
      // BOTH caches are now wrong, for different reasons: the runs list is
      // missing the row that was just opened, and the routine's `last_run_at`
      // was moved forward by `InsertRun` in the same transaction — so the
      // "next run" every list row derives from it has changed too. Refreshing
      // only the run history would leave the list quietly lying about the
      // schedule.
      void queryClient.invalidateQueries({
        queryKey: agentRoutineRunsQueryKey(gate.tenantId, variables.routineId),
      });
      void queryClient.invalidateQueries({
        queryKey: agentRoutinesQueryKey(gate.tenantId),
      });
    },
  });
}
