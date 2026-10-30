/**
 * useSubscribersPaging — the subscribers list's scroll-to-end and
 * pull-to-refresh behaviour, extracted from the screen so the screen stays a
 * view and so the two non-obvious rules below have somewhere to be stated.
 *
 * 1. PULL-TO-REFRESH MEANS "START OVER FROM THE TOP". TanStack refetches every
 *    loaded page of an infinite query by design, so a user twenty pages deep
 *    would pay twenty round trips for one pull. The cache is truncated to page
 *    1 BEFORE the refetch, which costs one request.
 *
 *    The key is built by `subscriberListKey`, the same helper the query uses.
 *    A hand-copied literal stopped matching the moment the key grew a `sort`
 *    segment — and a `setQueryData` that matches nothing fails silently, so
 *    the bug was invisible.
 *
 * 2. THE SPINNER IS FOR PULLS ONLY. Binding it to `isFetching` flashes it on
 *    the cold-mount load, next to the footer loader, which reads as two
 *    competing loads. An explicit manual-refresh flag keeps it honest.
 */
import { useCallback, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { firstPageOnly } from "@/lib/subscriberQueryCache";
import { subscriberListKey } from "@/lib/subscriberQueryKeys";
import {
  subscriberSortToken,
  type SubscriberSortOption,
} from "@/lib/subscriberSort";

interface Scrollable {
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
}

export function useSubscribersPaging(input: {
  listRef: RefObject<Scrollable | null>;
  tenantId: string | null;
  query: string;
  status: string | undefined;
  sort: SubscriberSortOption;
  /**
   * AUDIENCE#56. Load-bearing: `subscriberListKey` now carries an
   * archived segment, so a truncate that omits it addresses the ACTIVE-ONLY
   * cache entry while the screen is showing the widened one — a
   * `setQueryData` that matches nothing fails silently, which is exactly the
   * class of bug rule 1 above exists to prevent.
   */
  includeArchived?: boolean;
  /** True when the session is cached/stale: no refetch, no paging. */
  gated: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  refetch: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const [manualRefresh, setManualRefresh] = useState(false);

  const {
    fetchNextPage,
    gated,
    hasNextPage,
    includeArchived,
    isFetchingNextPage,
    listRef,
    query,
    refetch,
    sort,
    status,
    tenantId,
  } = input;

  const onEndReached = useCallback(() => {
    if (gated) return;
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, gated, hasNextPage, isFetchingNextPage]);

  const onRefresh = useCallback(() => {
    if (gated) return;
    setManualRefresh(true);
    queryClient.setQueryData(
      subscriberListKey(
        tenantId,
        query,
        status,
        subscriberSortToken(sort),
        includeArchived,
      ),
      firstPageOnly,
    );
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    void refetch().finally(() => setManualRefresh(false));
  }, [
    gated,
    includeArchived,
    listRef,
    query,
    queryClient,
    refetch,
    sort,
    status,
    tenantId,
  ]);

  return { manualRefresh, onEndReached, onRefresh };
}
