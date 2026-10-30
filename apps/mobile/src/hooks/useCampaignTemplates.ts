/**
 * hooks/useCampaignTemplates.ts — the catalogue read, the goal rollup, the
 * single-template read, and the two verbs.
 *
 * WHY THE CATALOGUE IS AN INFINITE QUERY AND THE GOALS ARE NOT. `Repo.Search`
 * pages at 24 rows and reports `next_cursor` as the next page number, so the
 * list is genuinely paged and a phone should keep appending. `GoalCounts` is
 * one grouped read over the whole visible catalogue — it does not page, and
 * (importantly) it is NOT narrowed by the active filters, so the filter rail
 * stays stable while you filter. Keeping it as its own query is what lets the
 * rail survive a search that returns nothing: you can still back out of the
 * filter that emptied the list.
 *
 * WHY NEITHER VERB IS OPTIMISTIC OR QUEUED OFFLINE. Both create a real row
 * server-side — a duplicated template, or a draft campaign — and neither has an
 * undo endpoint reachable from this app. An optimistic row would claim a draft
 * exists before the server agrees, and an offline replay would create it hours
 * later, unattended, from a phone that has since been handed to someone else.
 * They are online-only by construction: neither is registered in
 * lib/offlineMutationContract, so lib/offlineMutations never sees them.
 *
 * WHAT THE INVALIDATIONS ARE FOR. `CreateCampaignFromTemplate` calls
 * `RecordUse` on success (workflows.go:582), which bumps `usage_count` and
 * `last_used_at` — and the catalogue is ordered by
 * `is_featured, quality_score, usage_count, created_at`. So starting a campaign
 * genuinely reorders this list, and the campaigns list has gained a draft that
 * is not in its cache. Both are refetched rather than patched.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  cloneTemplate,
  createCampaignFromTemplate,
  fetchTemplate,
  fetchTemplateCatalog,
  fetchTemplateGoals,
  setTemplateFavorite,
  type CreatedCampaign,
} from "@/api/campaignTemplates";
import { templateCatalogQueryRootKey } from "@/lib/detailSeedKeys";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type {
  MobileTemplate,
  TemplateCatalogPage,
  TemplateGoalCount,
} from "@/lib/templateCatalog";
import {
  shelfQuery,
  sortQueryValue,
  type TemplateShelf,
  type TemplateSort,
} from "@/lib/templateDiscovery";
import { patchTemplateFavorite } from "@/lib/templateFavorites";

const CATALOG_KEY = "campaign-templates";
const GOALS_KEY = "campaign-template-goals";
const DETAIL_KEY = "campaign-template";

/**
 * A design library changes on the timescale of a person editing it on a laptop,
 * not on the timescale of a send. Five minutes keeps a tab-switch instant
 * without ever showing yesterday's library.
 */
const CATALOG_STALE_MS = 5 * 60_000;

export function templateCatalogQueryKey(
  tenantId: string | null | undefined,
  query: string,
  goal: string | null,
  shelf: TemplateShelf,
  sort: TemplateSort,
): readonly unknown[] {
  return [
    ...templateCatalogQueryRootKey(tenantId),
    query,
    goal ?? "all",
    shelf,
    sort,
  ];
}

/**
 * `shelf` and `sort` are the catalog controls (desktop Templates.tsx:696-701):
 * the shelf expands to `source` / `favorited` / `archived` via
 * lib/templateDiscovery.shelfQuery — `archived=active` is ALWAYS sent outside
 * the archived shelf, because the server's empty default mixes retired rows
 * into the browse shelf — and the default sort is omitted from the URL.
 */
export function useTemplateCatalog(
  query: string,
  goal: string | null,
  shelf: TemplateShelf = "all",
  sort: TemplateSort = "recommended",
) {
  const gate = useOnlineQueryGate();
  const trimmed = query.trim();
  return useInfiniteQuery({
    queryKey: templateCatalogQueryKey(gate.tenantId, trimmed, goal, shelf, sort),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CATALOG_STALE_MS,
    initialPageParam: 1,
    getNextPageParam: (last: TemplateCatalogPage) => last.nextPage,
    queryFn: ({ pageParam }): Promise<TemplateCatalogPage> => {
      const axes = shelfQuery(shelf);
      return fetchTemplateCatalog({
        query: trimmed,
        goal,
        source: axes.source,
        favorited: axes.favorited,
        archived: axes.archived,
        sort: sortQueryValue(sort),
        page: typeof pageParam === "number" ? pageParam : 1,
      });
    },
  });
}

/**
 * The goal rollup. Not gated on the active filter on purpose — see the module
 * header. `staleTime` matches the catalogue so the two never disagree about
 * how many templates exist.
 */
export function useTemplateGoals() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [GOALS_KEY, gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: CATALOG_STALE_MS,
    queryFn: (): Promise<TemplateGoalCount[]> => fetchTemplateGoals(),
  });
}

/**
 * The single-template read, used by the detail sheet. `staleTime: 0` because
 * the sheet is opened immediately before creating something from what it
 * shows, and because it is the only read that carries the body at all.
 */
export function useTemplateDetail(id: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [DETAIL_KEY, gate.tenantId, id ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id),
    staleTime: 0,
    queryFn: (): Promise<MobileTemplate | null> => fetchTemplate(id!),
  });
}

export function useCloneTemplate() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<MobileTemplate | null, Error, string>({
    mutationFn: (id) => cloneTemplate(id),
    onSuccess: () => {
      // A clone is a new tenant-owned row: it belongs in the catalogue, and it
      // shifts the per-goal counts the filter rail is built from.
      void qc.invalidateQueries({ queryKey: [CATALOG_KEY, gate.tenantId] });
      void qc.invalidateQueries({ queryKey: [GOALS_KEY, gate.tenantId] });
    },
  });
}

/**
 * Favourite / unfavourite one design.
 *
 * OPTIMISTIC, and it has to be: a star that waits for a round trip before it
 * fills is the single most common "did that work?" moment in a library UI. The
 * catalogue pages are patched in place and rolled back on failure, so the row
 * never disagrees with the server for longer than the request takes.
 *
 * The `is_favorited` flag is a per-USER left join (catalog.go:186-196), so the
 * cache key it lives under is already user-scoped by the online gate.
 */
export function useSetTemplateFavorite() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { id: string; favorited: boolean },
    { previous: [readonly unknown[], unknown][] }
  >({
    mutationFn: ({ id, favorited }) => setTemplateFavorite(id, favorited),
    onMutate: async ({ id, favorited }) => {
      const filter = { queryKey: [CATALOG_KEY, gate.tenantId] };
      await qc.cancelQueries(filter);
      const previous = qc.getQueriesData(filter);
      qc.setQueriesData(filter, (data: unknown) =>
        patchTemplateFavorite(data, id, favorited),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) {
        qc.setQueryData(key, data);
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [CATALOG_KEY, gate.tenantId] });
    },
  });
}

export function useStartCampaignFromTemplate() {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  return useMutation<CreatedCampaign | null, Error, string>({
    mutationFn: (id) => createCampaignFromTemplate(id),
    onSuccess: () => {
      // The draft is not in the campaigns cache, and RecordUse has reordered
      // the catalogue underneath us.
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
      void qc.invalidateQueries({ queryKey: [CATALOG_KEY, gate.tenantId] });
    },
  });
}
