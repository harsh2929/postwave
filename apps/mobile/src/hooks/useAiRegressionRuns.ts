/**
 * hooks/useAiRegressionRuns.ts — history and per-run evidence.
 *
 * All three reads are `read:reports` (viewer), so they are enabled for any
 * signed-in session on the online gate — no admin check.
 *
 * The results query is keyed by run id and only enabled once a run is open, so
 * opening the history list does not fetch N result sets.
 */
import { useQuery } from "@tanstack/react-query";

import {
  getRegressionRun,
  getRegressionRunResults,
  listRegressionRuns,
} from "@/api/aiRegressionRuns";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseRegressionResults,
  parseRegressionRunDetail,
  parseRegressionRuns,
  regressionRunsErrorMessage,
  type RegressionResultWire,
  type RegressionRunDetailWire,
} from "@/lib/aiRegressionRuns";

/** A phone reads recent history, not the archive. */
export const REGRESSION_HISTORY_LIMIT = 25;

export function useRegressionRuns(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["ai-regression-runs", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<RegressionRunDetailWire[]> => {
      const res = await listRegressionRuns(REGRESSION_HISTORY_LIMIT);
      if (res.error) {
        throw new Error(
          regressionRunsErrorMessage(res.error.status, res.error.message),
        );
      }
      return parseRegressionRuns(res.data);
    },
  });
}

export interface RegressionRunEvidence {
  run: RegressionRunDetailWire | null;
  results: RegressionResultWire[];
}

/**
 * The two reads behind one open run.
 *
 * Both need only the run id, which the caller already has, so they go on the
 * wire TOGETHER: awaiting the detail first cost a second round trip (50-300ms
 * on a phone) that bought nothing. The run's error is still inspected FIRST,
 * so an unknown run reports the detail read's message rather than
 * GetRunResults' 404 — the reason the detail was sequenced first originally.
 * The detail also carries by_surface, the summary rendered above the rows.
 *
 * Exported so the round-trip SHAPE is testable without a renderer.
 */
export async function readRegressionRunEvidence(
  id: string,
): Promise<RegressionRunEvidence> {
  const [runRes, resultsRes] = await Promise.all([
    getRegressionRun(id),
    getRegressionRunResults(id),
  ]);
  if (runRes.error) {
    throw new Error(
      regressionRunsErrorMessage(runRes.error.status, runRes.error.message),
    );
  }
  if (resultsRes.error) {
    throw new Error(
      regressionRunsErrorMessage(
        resultsRes.error.status,
        resultsRes.error.message,
      ),
    );
  }
  return {
    run: parseRegressionRunDetail(runRes.data),
    results: parseRegressionResults(resultsRes.data),
  };
}

export function useRegressionRunResults(runId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["ai-regression-run-results", gate.tenantId, runId],
    enabled: Boolean(runId) && gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: (): Promise<RegressionRunEvidence> =>
      readRegressionRunEvidence(runId ?? ""),
  });
}
