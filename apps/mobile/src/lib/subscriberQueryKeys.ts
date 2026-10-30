/**
 * The subscriber query keys, in one dependency-free module.
 *
 * They live here rather than in hooks/useSubscribers.ts so the membership
 * hooks can reuse them without a hooks→hooks import cycle, and so the key
 * SHAPES can be unit-tested without pulling in the SDK client.
 */

/**
 * Query-key root for the per-subscriber activity timeline. The detail screen
 * keys its `useInfiniteQuery` on `[SUBSCRIBER_TIMELINE_KEY_ROOT, tenantId,
 * id]`; exporting the root keeps that screen and the invalidation below from
 * drifting.
 */
export const SUBSCRIBER_TIMELINE_KEY_ROOT = "sub-timeline";

/** The timeline query key for one subscriber. */
export function subscriberTimelineKey(
  tenantId: string | null | undefined,
  id: string | null | undefined,
): readonly unknown[] {
  return [SUBSCRIBER_TIMELINE_KEY_ROOT, tenantId ?? null, id ?? null];
}

/**
 * The EXACT key of one subscribers-list query.
 *
 * It lives here, and both the hook and pull-to-refresh call it, because the
 * screen has to address this entry precisely (to truncate the infinite cache
 * to page 1 before refetching — otherwise TanStack re-requests every loaded
 * page). A hand-copied literal in the screen silently stopped matching the
 * moment the hook grew a `sort` segment, and a setQueryData that matches
 * nothing fails silently.
 */
export function subscriberListKey(
  tenantId: string | null | undefined,
  query: string | undefined,
  status: string | undefined,
  sortToken: string | undefined,
  /**
   * AUDIENCE#56: `?include_archived=true` returns a STRICTLY LARGER set, so it
   * must key separately — sharing a cache entry with the active-only view would
   * let a "show archived" toggle paint soft-deleted rows into the default list
   * (and vice versa) with no request in between. Appended LAST so the
   * `["subs", tenantId]` invalidation prefix still partial-matches.
   */
  includeArchived?: boolean,
): readonly unknown[] {
  return [
    "subs",
    tenantId ?? null,
    query ?? "",
    status ?? "all",
    sortToken || "default",
    includeArchived ? "with-archived" : "active-only",
  ];
}

/**
 * The PREFIX that partial-matches EVERY subscribers-list query — every
 * search term, status filter, sort order and page.
 *
 * A bulk verb rewrites rows across an unbounded selection and the server's
 * `{affected}` receipt does not say which ones, so there is nothing honest to
 * project optimistically. Invalidating this root is the correct blunt
 * instrument, and it lives beside `subscriberListKey` so the two can never
 * drift into addressing different caches.
 */
export function subscriberQueryRootKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["subs", tenantId ?? null];
}

/**
 * The PREFIX that partial-matches every variant of the detail query (which
 * additionally keys on userId / effectiveRole / network-vs-snapshot).
 *
 * Key ORDER is load-bearing: TanStack's filters compare POSITIONALLY, so
 * `id` must stay in position 2. Anything appended before it stops matching
 * the mounted query — which is exactly the bug that let a tag edit compute
 * its full-array-replace PATCH from a stale base and drop tags.
 */
export function subscriberDetailKey(
  tenantId: string | null | undefined,
  id: string | null | undefined,
): readonly unknown[] {
  return ["sub", tenantId ?? null, id ?? null];
}

/**
 * The lists one subscriber belongs to.
 *
 * Lives here rather than beside its hook because the optimistic ADD and the
 * optimistic REMOVE both patch it, and a projection addressing a key the
 * query does not use fails silently.
 */
export function subscriberListsKey(
  tenantId: string | null | undefined,
  id: string | null | undefined,
): readonly unknown[] {
  return ["sub-lists", tenantId ?? null, id ?? null];
}

/**
 * subscriberMutationInvalidationKeys — the full set of query-key prefixes a
 * subscriber-mutating action (unsubscribe/resubscribe, tag add/remove,
 * add-to-list, edit, suppress) must invalidate.
 *
 * Critically this includes the TIMELINE key — the detail screen derives the
 * header status pill, the engagement gauge and the lifetime-stats grid from
 * the `/timeline` payload's `stats.current_status`, NOT from the `["sub", …]`
 * detail query. Omitting the timeline key (the pre-fix bug) left the status
 * pill + activity stale after a successful mutation.
 *
 * Keys are intentionally PREFIXES: `["subs", tenantId]` catches every
 * search/page variant of the list, and the timeline key catches every cursor
 * page. Pure + exported so it can be unit-tested without a QueryClient.
 */
export function subscriberMutationInvalidationKeys(
  tenantId: string,
  id: string,
): readonly (readonly unknown[])[] {
  return [
    ["subs", tenantId], // list (all search/page variants)
    subscriberDetailKey(tenantId, id), // detail
    subscriberTimelineKey(tenantId, id), // timeline → status pill + stats + gauge
  ];
}
