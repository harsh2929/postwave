/**
 * hooks/useCollections.ts — TanStack wiring for the reference-collection
 * catalogue. All parsing lives in `lib/collections`, all policy in
 * `lib/collectionInventory` and `lib/collectionRows`; this file is the query
 * layer and nothing else.
 *
 * OFFLINE. Both queries sit behind `useOnlineQueryGate`, so offline they never
 * run — which in TanStack v5 is status "pending" with fetchStatus "idle", i.e.
 * `isLoading` FALSE and `isError` FALSE. A screen falling through that to an
 * empty list would be claiming the workspace has no reference collections.
 * `QueryStates` owns the offline branch.
 *
 * NOTHING HERE IS PERSISTED TO DISK, and that is deliberate rather than
 * incidental. `shouldPersistQuery` returns false for every query
 * (`lib/queryClient.ts:85-93`), and this is a surface where that matters more
 * than most: the server sets `Cache-Control: no-store` on every collection
 * response (`handlers.go:393-396`) and gates the detail behind a WRITE scope
 * precisely because row bodies "can contain confidential lookup values"
 * (`handlers.go:36-39`). So there is no cold-offline snapshot of this screen,
 * and its offline state is an honest "reconnect to read this" rather than a
 * cached table of coupon codes sitting in the device vault.
 *
 * THE PAGE CURSOR IS FILTER-BOUND. `decodeCollectionCursor` compares the
 * cursor's embedded `q` and `collection_type` against the request and 400s on
 * mismatch (`cursor.go:69-73`). The filters are therefore part of the query
 * KEY, so changing one starts a new infinite query at page one instead of
 * replaying a cursor the server will refuse.
 */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { fetchCollectionDetail, fetchCollections } from "@/api/collections";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { CollectionDetail, CollectionListPage } from "@/lib/collections";
import {
  collectionFilterKey,
  type CollectionTypeFilter,
} from "@/lib/collectionInventory";

export type {
  CollectionDataRow,
  CollectionDetail,
  CollectionListPage,
  CollectionSummary,
} from "@/lib/collections";

/**
 * Reference collections are operator-maintained lookup tables, not a live feed:
 * an overnight import moves them once a day. 60s is long enough that scrolling
 * back does not re-fetch and short enough that a re-import landing while
 * somebody watches is one pull away. There is no `refetchInterval` — a poll
 * would spend cellular data waiting for something that changes daily.
 */
const COLLECTIONS_STALE_MS = 60_000;

/** One page at a time, appended, with the server's own opaque cursor. */
export function useCollectionsList(
  type: CollectionTypeFilter,
  query: string,
) {
  const gate = useOnlineQueryGate();
  const filterKey = collectionFilterKey(type, query);
  return useInfiniteQuery<CollectionListPage>({
    queryKey: ["collections", "list", gate.tenantId, filterKey],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: COLLECTIONS_STALE_MS,
    initialPageParam: null as string | null,
    getNextPageParam: (last: CollectionListPage) => last.nextCursor,
    queryFn: ({ pageParam }) =>
      fetchCollections({
        type,
        query,
        cursor: (pageParam as string | null) ?? null,
      }),
  });
}

/**
 * One collection's rows — fetched only once a row is opened AND the session is
 * allowed to ask.
 *
 * `allowed` is a pre-emptive role check, not a substitute for the server's:
 * `canAccessMinimumRole("editor", …)` in the screen keeps a viewer from firing
 * a request that can only 403, while the screen still renders the server's live
 * 403 if a role turns out to be lower than the client believed. `enabled`
 * carries both, so nothing is requested while the list is merely scrolled.
 */
export function useCollectionDetail(id: string | null, allowed: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery<CollectionDetail>({
    queryKey: ["collections", "detail", gate.tenantId, id],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(id) && allowed,
    staleTime: COLLECTIONS_STALE_MS,
    queryFn: () => fetchCollectionDetail(String(id)),
  });
}
