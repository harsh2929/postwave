/**
 * lib/infiniteQueryRefresh.ts — make pull-to-refresh cost ONE request on a
 * paged list, not one per page the reader has already loaded.
 *
 * ── THE COST ───────────────────────────────────────────────────────────────
 * `refetch()` on a TanStack v5 infinite query re-requests EVERY loaded page,
 * sequentially, because page N+1's cursor is derived from page N. So the price
 * of the gesture is linear in how far the reader has scrolled, and the
 * requests are SERIALISED — on cellular a five-page list is five round trips
 * back-to-back before the spinner retracts.
 *
 * On the campaigns screen the reader does not even have to scroll to get
 * there: `useCampaignListPaging` auto-drains up to CAMPAIGN_AUTO_PAGE_LIMIT
 * (5) pages of CAMPAIGN_PAGE_SIZE (100) rows looking for matches whenever a
 * status chip is active. One pull then costs five requests and re-downloads
 * five hundred rows to show the reader the top of the list.
 *
 * ── THE FIX, AND WHY IT IS HONEST ──────────────────────────────────────────
 * Collapse the cache entry to its first page BEFORE refetching. A
 * pull-to-refresh is only reachable at scroll offset 0 (that is what the
 * gesture is), and it means "start over from the top" — which is exactly what
 * one fresh first page is. The pages below the fold are not lost data the
 * reader is looking at; they are a scroll history that the "Load more" footer
 * offers back, correctly re-derived because TanStack recomputes
 * `hasNextPage` from the truncated `pages`/`pageParams`.
 *
 * `maxPages` would also bound the fan-out, but it drops the OLDEST pages, so
 * rows vanish from ABOVE the viewport mid-scroll and the list jumps.
 *
 * This is `lib/subscriberQueryCache.ts::firstPageOnly` generalised. That
 * helper has shipped on the subscribers list since AUDIENCE#56 and is the
 * proof the semantics are acceptable; every other paged screen in the app was
 * still paying per-page. The difference here is that the collapse is addressed
 * by PREFIX rather than by an exact key: an exact key that has drifted from
 * the one the hook registers fails SILENTLY (a `setQueryData` that matches
 * nothing is indistinguishable from a no-op), and that class of bug is the
 * reason `subscriberListKey` carries a comment about segment order. A prefix
 * cannot drift as long as the root is right, and `collapsed` is returned so a
 * caller — or a test — can assert the collapse actually found something.
 *
 * Import-free (no react-native, no @tanstack/react-query) so it stays
 * unit-testable in the node vitest environment.
 */

/** The shape TanStack stores for an infinite query. */
export interface InfiniteCacheData {
  pages: unknown[];
  pageParams: unknown[];
}

/**
 * True when `value` is TanStack's infinite-query envelope carrying more than
 * one loaded page — i.e. when refetching it would cost more than one request.
 *
 * Deliberately structural rather than "is this an infinite query": an infinite
 * list the reader has not scrolled holds one page and is already as cheap as
 * any other query, and a non-infinite cache entry caught by the same prefix
 * is not written at all (see `rewriteQueriesKeepingFreshness`).
 */
export function isMultiPageInfiniteData(
  value: unknown,
): value is InfiniteCacheData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { pages?: unknown; pageParams?: unknown };
  return (
    Array.isArray(candidate.pages) &&
    Array.isArray(candidate.pageParams) &&
    candidate.pages.length > 1
  );
}

/**
 * Collapse one cache entry to its first page. Returns the input UNCHANGED
 * (same reference) for anything that is not a multi-page infinite envelope.
 *
 * That reference must never be handed back to TanStack as a write: a
 * `setQueryData`/`setQueriesData` updater that returns the same data is still
 * a full manual write (re-stamped `dataUpdatedAt`, error and invalidation
 * cleared). The collapse below skips those entries instead.
 */
export function firstPageOf<T>(data: T): T {
  if (!isMultiPageInfiniteData(data)) return data;
  return {
    ...data,
    pages: data.pages.slice(0, 1),
    pageParams: data.pageParams.slice(0, 1),
  } as T;
}

/**
 * The slice of QueryClient this module needs. Declared structurally so the
 * helper stays free of a @tanstack/react-query import; a real `QueryClient`
 * satisfies it as-is.
 */
export interface CollapsibleQueryClient {
  getQueryCache(): {
    findAll(filters: { queryKey: readonly unknown[] }): readonly {
      queryKey: readonly unknown[];
      state: { data: unknown; dataUpdatedAt: number; isInvalidated: boolean };
      invalidate(): void;
    }[];
  };
  setQueryData(
    queryKey: readonly unknown[],
    data: unknown,
    options?: { updatedAt?: number },
  ): unknown;
}

/**
 * Rewrite the data of every cache entry under `prefix` WITHOUT declaring it
 * fresh. Returns how many entries were written.
 *
 * `rewrite` returns `undefined` for an entry it wants left alone, and that
 * entry is not written at all. This is the difference from `setQueriesData`,
 * whose every write (the same reference included) re-stamps `dataUpdatedAt` to
 * now and clears the error and the invalidation. Under a prefix that means a
 * sibling nobody meant to touch: an errored list loses its banner, a list a
 * mutation invalidated stops refetching, and an old one reads as fresh to the
 * next screen that mounts it — each with no request. A rewritten entry keeps
 * its own age, and its invalidation is put back (the write clears it), so it
 * refetches when it is next shown exactly as it would have.
 */
export function rewriteQueriesKeepingFreshness(
  client: CollapsibleQueryClient,
  prefix: readonly unknown[],
  rewrite: (data: unknown) => unknown,
): number {
  let written = 0;
  for (const query of client.getQueryCache().findAll({ queryKey: prefix })) {
    const { data, dataUpdatedAt, isInvalidated } = query.state;
    const next = rewrite(data);
    if (next === undefined) continue;
    client.setQueryData(query.queryKey, next, { updatedAt: dataUpdatedAt });
    if (isInvalidated) query.invalidate();
    written += 1;
  }
  return written;
}

/**
 * Collapse every infinite cache entry under `prefix` to its first page.
 *
 * Returns how many entries were actually collapsed, so a caller can log it and
 * a test can fail if the prefix stops matching the query the screen mounts.
 * Zero is a legitimate answer (nothing paged yet) — it is a SILENT zero,
 * forever, that this return value exists to make visible. Every other entry
 * under the prefix is left exactly as it is, and a collapsed one keeps its age
 * and invalidation; the caller refetches the list it is refreshing right
 * after, so that is the only entry that comes back fresh.
 */
export function collapseInfiniteQueriesToFirstPage(
  client: CollapsibleQueryClient,
  prefix: readonly unknown[],
): number {
  return rewriteQueriesKeepingFreshness(client, prefix, (data) =>
    isMultiPageInfiniteData(data) ? firstPageOf(data) : undefined,
  );
}

/**
 * Wrap a TanStack `refetch` so the gesture collapses first and then refetches.
 *
 * Written as a factory rather than left at each call site because the ORDER is
 * the whole point: refetch-then-collapse pays for every page and then throws
 * the answers away, which is strictly worse than doing nothing.
 *
 * `collapse: false` opts a screen out for the case that makes truncation
 * WRONG rather than merely cheap: a list whose visible rows are filtered on the
 * CLIENT over every loaded page. On the campaigns list a status chip or a
 * folder is applied that way (the list endpoint has no status parameter), and
 * on the suppressions list so are the reason chip, the date window and a
 * 1-2 character search. There the pages below the fold are load-bearing for
 * what is on screen — collapsing could empty a view whose only matches were on
 * page four — so those screens pay the full price deliberately and say so.
 */
export function refreshFirstPageOnly(
  client: CollapsibleQueryClient,
  prefix: readonly unknown[],
  refetch: () => Promise<unknown>,
  options: { collapse?: boolean } = {},
): () => Promise<unknown> {
  const collapse = options.collapse ?? true;
  return () => {
    if (collapse) collapseInfiniteQueriesToFirstPage(client, prefix);
    return refetch();
  };
}
