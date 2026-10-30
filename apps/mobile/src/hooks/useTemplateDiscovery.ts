/**
 * hooks/useTemplateDiscovery.ts — react-query bindings for the template
 * discovery layer: stats, the recent shelf, saved searches, collections,
 * and side-by-side compare (desktop parity: TemplateDiscoveryHub +
 * TemplateComparePanel).
 *
 * KEY DISCIPLINE. The lifecycle hook (useTemplateLifecycle) invalidates
 * `campaign-template-stats` and `campaign-template-recent` by these exact
 * prefixes when a design is archived or restored — the constants here are the
 * contract, so renaming one silently orphans an invalidation.
 *
 * RECORDING A VIEW IS PRESS-DRIVEN, NEVER A PREFETCH. `POST /{id}/view` MINTS
 * state (a row in the per-user recent shelf), so it fires when the operator
 * OPENS a design and never from a render or a prefetch — a recent shelf built
 * from prefetches would remember things nobody looked at. It is also
 * fire-and-forget: a failed view-record must never surface as an error over a
 * sheet the operator successfully opened.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  clearRecentTemplateViews,
  createTemplateSavedSearch,
  deleteTemplateSavedSearch,
  fetchRecentTemplateViews,
  fetchSavedSearchResults,
  fetchTemplateCollection,
  fetchTemplateCollections,
  fetchTemplateCompare,
  fetchTemplateSavedSearches,
  fetchTemplateStats,
  recordTemplateView,
  type SavedSearchCreateInput,
} from "@/api/templateDiscovery";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  TEMPLATE_COMPARE_MAX,
  TEMPLATE_COMPARE_MIN,
  type CursorTemplatePage,
  type RecentTemplateView,
  type TemplateCollection,
  type TemplateCompareResult,
  type TemplateSavedSearch,
  type TemplateStats,
} from "@/lib/templateDiscovery";

const STATS_KEY = "campaign-template-stats";
const RECENT_KEY = "campaign-template-recent";
const SAVED_KEY = "campaign-template-saved-searches";
const SAVED_RESULTS_KEY = "campaign-template-saved-results";
const COLLECTIONS_KEY = "campaign-template-collections";
const COLLECTION_KEY = "campaign-template-collection";
const COMPARE_KEY = "campaign-template-compare";

/** Discovery state moves on the timescale of the catalogue: five minutes. */
const DISCOVERY_STALE_MS = 5 * 60_000;

export function useTemplateStats() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [STATS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: DISCOVERY_STALE_MS,
    queryFn: (): Promise<TemplateStats | null> => fetchTemplateStats(),
  });
}

/**
 * The per-user recent shelf. `staleTime: 0` — it exists to reflect what was
 * JUST opened, and the record-view mutation invalidates it on every open.
 */
export function useRecentTemplateViews() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [RECENT_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 0,
    queryFn: (): Promise<RecentTemplateView[]> => fetchRecentTemplateViews(),
  });
}

export function useRecordTemplateView() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => recordTemplateView(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [RECENT_KEY, gate.tenantId] });
    },
  });
}

export function useClearRecentTemplateViews() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () => clearRecentTemplateViews(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [RECENT_KEY, gate.tenantId] });
    },
  });
}

export function useTemplateSavedSearches() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [SAVED_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: DISCOVERY_STALE_MS,
    queryFn: (): Promise<TemplateSavedSearch[]> => fetchTemplateSavedSearches(),
  });
}

export function useCreateTemplateSavedSearch() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, SavedSearchCreateInput>({
    mutationFn: (input) => createTemplateSavedSearch(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [SAVED_KEY, gate.tenantId] });
    },
  });
}

export function useDeleteTemplateSavedSearch() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; etag: string }>({
    mutationFn: ({ id, etag }) => deleteTemplateSavedSearch(id, etag),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [SAVED_KEY, gate.tenantId] });
    },
  });
}

/**
 * A saved search's RESULTS — the server re-runs the FULL stored definition,
 * including axes this phone has no control for, which is exactly why applying
 * a saved search opens this feed instead of poking values into the local
 * filter state and silently dropping the rest.
 */
export function useSavedSearchResults(id: string | null) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: [SAVED_RESULTS_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: DISCOVERY_STALE_MS,
    initialPageParam: null as string | null,
    getNextPageParam: (last: CursorTemplatePage) => last.nextCursor,
    queryFn: ({ pageParam }): Promise<CursorTemplatePage> =>
      fetchSavedSearchResults(
        id!,
        typeof pageParam === "string" ? pageParam : null,
      ),
  });
}

export function useTemplateCollections() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [COLLECTIONS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: DISCOVERY_STALE_MS,
    queryFn: (): Promise<TemplateCollection[]> => fetchTemplateCollections(),
  });
}

/** The single read is the only one that carries the collection's `items`. */
export function useTemplateCollection(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [COLLECTION_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: DISCOVERY_STALE_MS,
    queryFn: (): Promise<TemplateCollection | null> =>
      fetchTemplateCollection(id!),
  });
}

/**
 * Side-by-side compare. Enabled only inside the server's own 2..4 bound
 * (normalizeCompareIdentifiers) — below it there is nothing to compare, above
 * it the server 400s. The key is the SORTED id list: {a,b} and {b,a} are the
 * same comparison and must share a cache entry.
 */
export function useTemplateCompare(ids: readonly string[]) {
  const gate = useOnlineQueryGate();
  const sorted = [...ids].sort();
  return useQuery({
    queryKey: [COMPARE_KEY, gate.tenantId, sorted],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      ids.length >= TEMPLATE_COMPARE_MIN &&
      ids.length <= TEMPLATE_COMPARE_MAX,
    staleTime: DISCOVERY_STALE_MS,
    queryFn: (): Promise<TemplateCompareResult> => fetchTemplateCompare(ids),
  });
}
