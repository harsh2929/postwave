/**
 * hooks/useFlowAbTests.ts — the in-flow A/B catalogue and one test's counters.
 *
 * TWO QUERIES, TWO DIFFERENT STALENESS ANSWERS, AND THE DIFFERENCE IS THE
 * POINT. The CONFIG (which splits exist, their variants, their stored verdict)
 * only changes when somebody edits it on a desktop, so it is cached for two
 * minutes like the flows catalogue next door. The COUNTERS are incremented by
 * the automation runtime every time a subscriber is bucketed
 * (services/automation/internal/runtime/postgres_store.go:466) — that is the
 * number somebody opened this screen to watch, so it is always considered
 * stale and refetched on focus.
 *
 * NO MUTATION LIVES HERE, and that is a decision rather than an omission. The
 * only write that reads like a monitor action is `POST /{id}/evaluate`, and it
 * ENDS the test (`setWinner` writes `status='completed'`, `ended_at=now()`,
 * flowabtests.go:205). See api/flowAbTests for the rest of the reasoning.
 *
 * Both queries carry the offline gate (house rule 2): with the gate closed
 * they do not fire, and the screen falls back to whatever the persister
 * restored rather than to a spinner that never resolves.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchFlowAbResults,
  fetchFlowAbTest,
  fetchFlowAbTests,
} from "@/api/flowAbTests";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  MobileFlowAbResult,
  MobileFlowAbTest,
} from "@/lib/flowAbTests";

const FLOW_AB_TESTS_KEY = "flow-ab-tests";
const FLOW_AB_TEST_KEY = "flow-ab-test";
const FLOW_AB_RESULTS_KEY = "flow-ab-results";

/** Standing configuration authored elsewhere; nothing changes it on its own. */
const CONFIG_STALE_MS = 120_000;

export function flowAbTestsQueryKey(
  tenantId: string | null | undefined,
  automationId: string | null,
): readonly unknown[] {
  return [FLOW_AB_TESTS_KEY, tenantId ?? null, automationId];
}

export function flowAbTestQueryKey(
  tenantId: string | null | undefined,
  testId: string | null,
): readonly unknown[] {
  return [FLOW_AB_TEST_KEY, tenantId ?? null, testId];
}

export function flowAbResultsQueryKey(
  tenantId: string | null | undefined,
  testId: string | null,
): readonly unknown[] {
  return [FLOW_AB_RESULTS_KEY, tenantId ?? null, testId];
}

export function useFlowAbTests(automationId: string | null = null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowAbTestsQueryKey(gate.tenantId, automationId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CONFIG_STALE_MS,
    queryFn: (): Promise<readonly MobileFlowAbTest[]> =>
      fetchFlowAbTests({ automationId }),
  });
}

/**
 * One test, refreshed. `staleTime: 0` because the sheet is opened precisely to
 * read the stored verdict, and the list behind it may be two minutes old.
 */
export function useFlowAbTest(testId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowAbTestQueryKey(gate.tenantId, testId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(testId),
    staleTime: 0,
    queryFn: (): Promise<MobileFlowAbTest | null> => fetchFlowAbTest(testId!),
  });
}

/** The live counters. Always stale — this is the moving number. */
export function useFlowAbResults(testId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: flowAbResultsQueryKey(gate.tenantId, testId),
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(testId),
    staleTime: 0,
    queryFn: (): Promise<readonly MobileFlowAbResult[]> =>
      fetchFlowAbResults(testId!),
  });
}
