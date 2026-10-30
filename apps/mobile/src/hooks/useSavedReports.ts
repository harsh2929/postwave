/**
 * hooks/useSavedReports.ts — TanStack wiring for the saved-report shortlist.
 *
 * Parsing lives in `lib/savedReports` (pure, unit-tested); this file is only
 * the query layer plus the invalidation a run must trigger.
 *
 * OFFLINE. Both queries go through `useOnlineQueryGate`, so offline they never
 * run — which in TanStack v5 is status "pending" with fetchStatus "idle", i.e.
 * `isLoading` FALSE and `isError` FALSE. A section that fell through that to
 * "no saved reports" would be asserting something about the workspace it does
 * not know; `QueryStates` owns the offline branch.
 *
 * BOTH READS ARE GATED ON `allowed` AS WELL. The three reads are
 * `ScopeReadReports` and clear any session role, but an API-KEY session is
 * modelled as viewer-only by `canAccessMinimumRole`, and a key without
 * `read:reports` would 403. The caller passes the same flag it uses to decide
 * whether to render the section at all, so a denied session makes zero
 * requests rather than one guaranteed 403 per mount.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listSavedReportDefinitions,
  listSavedReportRuns,
  runSavedReport,
} from "@/api/savedReports";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  SavedReportDefinition,
  SavedReportRun,
} from "@/lib/savedReports";

export type {
  SavedReportDefinition,
  SavedReportRun,
} from "@/lib/savedReports";

/**
 * Definitions change when somebody authors a report — days, not seconds. Runs
 * change every time anyone presses Run anywhere, so they get a much shorter
 * window; the two are read together and a stale run under a fresh definition
 * is exactly the mismatch that makes "last run" untrustworthy.
 */
const DEFINITIONS_STALE_MS = 5 * 60_000;
const RUNS_STALE_MS = 30_000;

export function useSavedReportDefinitions(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<SavedReportDefinition[]>({
    queryKey: ["saved-reports", "definitions", gate.tenantId],
    enabled: allowed && gate.enabled && Boolean(gate.tenantId),
    staleTime: DEFINITIONS_STALE_MS,
    queryFn: () => listSavedReportDefinitions(),
  });
}

export function useSavedReportRuns(allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<SavedReportRun[]>({
    queryKey: ["saved-reports", "runs", gate.tenantId],
    enabled: allowed && gate.enabled && Boolean(gate.tenantId),
    staleTime: RUNS_STALE_MS,
    queryFn: () => listSavedReportRuns(),
  });
}

/**
 * Run a saved definition.
 *
 * NOT optimistic. The run is synchronous server-side but its OUTCOME is not
 * knowable in advance: `RunDefinition` can insert a row whose status is not
 * `completed`, and the handler still answers 202. Painting a green "ran" state
 * before the body arrives would be claiming a result the request has not yet
 * reported. The invalidation is what makes the truth arrive.
 */
export function useRunSavedReport() {
  const client = useQueryClient();
  return useMutation<SavedReportRun | null, unknown, string>({
    mutationFn: (definitionId: string) => runSavedReport(definitionId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["saved-reports", "runs"] });
    },
  });
}
