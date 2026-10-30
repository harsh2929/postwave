/**
 * subscriberQueryCache — the TanStack cache surgery the subscriber
 * mutations need, kept out of hooks/useSubscribers.ts (size budget) and
 * free of any react-native import so it stays unit-testable.
 *
 * Two concerns live here:
 *
 *   - `firstPageOnly`, which makes pull-to-refresh cost one request
 *     instead of one per loaded page;
 *   - the optimistic patch / rollback / invalidate triad shared by the
 *     tag and status mutations.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  mergeSnapshots,
  optimisticUpdateQueries,
  rollbackQueries,
  type OptimisticSnapshot,
} from "./optimisticQueries";
import {
  subscriberDetailKey,
  subscriberTimelineKey,
} from "./subscriberQueryKeys";

/**
 * Collapse an infinite-query cache entry back to its first page.
 *
 * `refetch()` on a TanStack v5 infinite query re-requests EVERY loaded
 * page, sequentially, by design. A user twenty pages into a large tenant
 * who pulls to refresh therefore fires twenty requests over cellular.
 * Truncating the cache to page 1 first turns pull-to-refresh into what the
 * gesture actually means — "start over from the top" — at a cost of
 * exactly one request.
 *
 * `maxPages` would also bound the fan-out, but it silently drops the
 * OLDEST pages, so rows vanish from above the viewport mid-scroll and the
 * list jumps. Returns the SAME object when there is nothing to trim, so
 * setQueryData can skip a needless notification.
 */
export function firstPageOnly<TPage>(
  data: { pages: TPage[]; pageParams: unknown[] } | undefined,
): { pages: TPage[]; pageParams: unknown[] } | undefined {
  if (!data || data.pages.length <= 1) return data;
  return {
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  };
}

/**
 * Snapshot of every cache entry an optimistic patch touched.
 *
 * Structurally the shared `OptimisticSnapshot` — the alias is kept so the
 * subscriber hooks and their tests keep one name for the mutation context.
 */
export type OptimisticPatchContext = OptimisticSnapshot;

/**
 * Cancel in-flight fetches under `queryKey` (so a slower in-flight
 * response cannot clobber the projection), snapshot every matching entry,
 * then shallow-merge `patch` into each.
 *
 * `queryKey` is a PREFIX: the subscriber detail query additionally keys on
 * userId / effectiveRole / network-vs-snapshot, and TanStack's filters do a
 * positional prefix match, so this patches whichever variant is mounted.
 */
export function optimisticPatchQueries<TData extends object>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  patch: Partial<TData>,
): Promise<OptimisticPatchContext> {
  return optimisticUpdateQueries<TData>(queryClient, queryKey, (current) =>
    current ? { ...current, ...patch } : current,
  );
}

/** Restore every entry captured by optimisticPatchQueries. */
export const rollbackPatchedQueries = rollbackQueries;

/**
 * The shape of one page of the subscriber TIMELINE infinite query, reduced
 * to the field the header actually reads.
 */
export interface TimelinePageLike {
  page?: { stats?: { current_status?: string } } | null;
}

export interface InfiniteLike<TPage> {
  pages: TPage[];
  pageParams: unknown[];
}

/**
 * Project a status change onto the timeline cache.
 *
 * Load-bearing, and easy to miss: the subscriber detail screen derives its
 * status pill from `pages[0].page.stats.current_status` and falls back to the
 * detail query only when the timeline has no stats
 * (app/(tabs)/subscribers/[id].tsx). An optimistic status write that patched
 * only the `["sub", …]` detail cache therefore changed NOTHING on screen —
 * the pill kept the old status until the refetch landed.
 *
 * Returns the same object when there is nothing to change, and `undefined`
 * for an unpopulated entry: never fabricate a timeline.
 */
export function projectTimelineStatus<TPage extends TimelinePageLike>(
  data: InfiniteLike<TPage> | undefined,
  status: string,
): InfiniteLike<TPage> | undefined {
  const first = data?.pages[0];
  const stats = first?.page?.stats;
  if (!data || !first || !stats) return data;
  if (stats.current_status === status) return data;
  const pages = data.pages.slice();
  pages[0] = {
    ...first,
    page: { ...first.page, stats: { ...stats, current_status: status } },
  } as TPage;
  return { pages, pageParams: data.pageParams };
}

/**
 * The whole optimistic projection for one subscriber-row write: the detail
 * query, plus the timeline whenever the patch moves `status`.
 *
 * Returned context restores BOTH caches, so a failed write cannot leave the
 * pill saying one thing and the row another.
 */
export async function subscriberRowPatch<TDetail extends object>(
  queryClient: QueryClient,
  tenantId: string | null | undefined,
  id: string,
  patch: Partial<TDetail>,
): Promise<OptimisticPatchContext> {
  if (!tenantId) return { previous: [] };
  const detail = await optimisticPatchQueries<TDetail>(
    queryClient,
    subscriberDetailKey(tenantId, id) as QueryKey,
    patch,
  );
  const status = (patch as { status?: unknown }).status;
  if (status == null) return detail;
  const next = String(status);
  const timeline = await optimisticUpdateQueries<InfiniteLike<TimelinePageLike>>(
    queryClient,
    subscriberTimelineKey(tenantId, id) as QueryKey,
    (data) => projectTimelineStatus(data, next),
  );
  return mergeSnapshots(detail, timeline);
}

/** Invalidate a set of key prefixes, ignoring the returned promises. */
export function invalidateKeys(
  queryClient: QueryClient,
  keys: readonly (readonly unknown[])[],
): void {
  for (const queryKey of keys) {
    void queryClient.invalidateQueries({ queryKey: queryKey as QueryKey });
  }
}

/**
 * Flatten an infinite-query result into the rows the list renders plus the
 * server's total for the CURRENT query.
 *
 * `total` deliberately takes the LAST page that carried one rather than the
 * first: the value is per-query, and a later page reflects any rows added or
 * removed while the user was scrolling. When no page carried one it stays
 * `undefined` — absence is not zero, and `subscriberCountLine` renders a
 * "N loaded" line rather than inventing a workspace size.
 *
 * BOTH LEVELS ARE `Array.isArray`-GUARDED, NOT `?? []`. This is the only
 * boundary between the persisted query cache and the subscribers list, and the
 * cache is rehydrated from disk (lib/secureQueryPersister), so an entry written
 * by an older build's response shape lands here after an app update. `?? []` is
 * a NULLISH guard: a truthy `{}` reaches the for-of and throws "object is not
 * iterable" inside the screen's render, which the route error boundary turns
 * into a blank Subscribers tab. Returning no rows is recoverable by a refetch;
 * a thrown render is not.
 */
export function flattenSubscriberPages<TRow>(
  data: { pages?: readonly unknown[] } | undefined,
): { rows: TRow[]; serverTotal: number | undefined } {
  const rows: TRow[] = [];
  let serverTotal: number | undefined;
  const pages = Array.isArray(data?.pages) ? data.pages : [];
  for (const page of pages) {
    const p = page as { items?: TRow[]; total?: number } | undefined;
    if (typeof p?.total === "number") serverTotal = p.total;
    if (!Array.isArray(p?.items)) continue;
    for (const row of p.items) rows.push(row);
  }
  return { rows, serverTotal };
}
