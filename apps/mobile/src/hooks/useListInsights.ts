/**
 * useListInsights — queries behind the per-list insight cards (engagement
 * breakdown, activity feed, cross-references) plus the press-driven per-row
 * engagement check.
 *
 * Reads gate on `useOnlineQueryGate` and key under `listDetailKey` (whose
 * prefix is the tenant-scoped "lists" root), like every other per-list read.
 * Callers pass `undefined` while their section is off-screen so opening a
 * list does not fan out into six requests.
 *
 * Per-row engagement is a MUTATION on purpose: its input is whatever member
 * rows happen to be materialised, so an automatic query would re-fire on
 * every page append and grade a moving target. The person presses the
 * button — the same shape as useEmailHealthBatch, for the same reason.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  fetchListActivity,
  fetchListAutomations,
  fetchListEngagement,
  fetchListForms,
  fetchListSuppressedTotal,
  fetchPerRowEngagement,
} from "@/api/listsInsights";
import { listDetailKey } from "@/hooks/useListDetail";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";

export function useListEngagement(listId: string | undefined, windowDays = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [
      ...listDetailKey(gate.tenantId, listId),
      "engagement",
      windowDays,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: () => fetchListEngagement(listId!, windowDays),
  });
}

export function useListActivity(listId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "activity"],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: () => fetchListActivity(listId!),
  });
}

/**
 * The three cross-reference counts on the Overview card. Fetched together
 * (one query) because they render together; a failure of any leg fails the
 * card into its error state rather than showing two live counts and one
 * silent zero.
 */
export function useListCrossRefs(listId: string | undefined) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [...listDetailKey(gate.tenantId, listId), "cross-refs"],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(listId),
    queryFn: async () => {
      const [suppressedTotal, forms, automations] = await Promise.all([
        fetchListSuppressedTotal(listId!),
        fetchListForms(listId!),
        fetchListAutomations(listId!),
      ]);
      return { suppressedTotal, forms, automations };
    },
  });
}

export function usePerRowEngagementCheck(listId: string | undefined) {
  return useMutation({
    mutationFn: (subscriberIds: readonly (string | null | undefined)[]) =>
      fetchPerRowEngagement(listId!, subscriberIds),
  });
}
