/**
 * hooks/useSubscriberDuplicates.ts — TanStack wiring for the duplicate-review
 * queue. Every judgement lives in `lib/duplicateScan` and
 * `lib/duplicateMergePlan` (pure, node-tested); this file is only the query
 * layer plus the cache invalidation a merge must trigger.
 *
 * TWO GATES ON EVERY QUERY.
 *  - `useOnlineQueryGate` is the usual offline/auth gate. Offline a query never
 *    runs, which in TanStack v5 is status "pending" with fetchStatus "idle" —
 *    `isLoading` FALSE and `isError` FALSE — so a screen falling through to
 *    "no duplicates" would be inventing a fact about the workspace.
 *    `QueryStates` owns that branch.
 *  - `canMerge` carries the ROLE decision for the plan/apply pair. Both are
 *    `POST /api/v1/merge/apply`, which routeauth gates at `admin` (see the
 *    header of `api/subscriberDuplicates.ts`), so for any lower role those
 *    requests can only ever answer 403.
 *
 * THE SCAN QUERY DOES NOT RETRY, AND THAT IS THE POINT. `GET /api/v1/
 * subscribers/duplicates` materializes a complete manifest under a per-tenant
 * advisory lock (scan.go:221-293). A retry after a 409
 * `duplicate_scan_in_progress` can only fail again, and a retry after a
 * timeout races a scan that may still be committing. One attempt, then the
 * screen says what happened.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  applyDuplicateMerge,
  DUPLICATE_PAIRS_PAGE_SIZE,
  listDuplicatePairs,
  previewDuplicateMerge,
  startDuplicateScan,
  type DuplicateMergeRequest,
} from "@/api/subscriberDuplicates";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { DuplicateMergePlan } from "@/lib/duplicateMergePlan";
import type { DuplicateScanPage } from "@/lib/duplicateScan";

export type {
  DuplicateEvidence,
  DuplicatePair,
  DuplicateScan,
  DuplicateScanPage,
} from "@/lib/duplicateScan";
export type { DuplicateMergePlan } from "@/lib/duplicateMergePlan";

/**
 * A frozen manifest is valid for 24 hours (`expires_at`, scan.go:278) and
 * re-reading it costs a full workspace scan, so the window here is long: this
 * is the one query in the app where a background refetch would be a real
 * server-side cost rather than a few bytes.
 */
const SCAN_STALE_MS = 10 * 60_000;
/** Pages of an ALREADY-frozen manifest are immutable. Only `stale` re-derives. */
const PAIRS_STALE_MS = 5 * 60_000;
/**
 * A plan is computed against live rows, so it goes out of date the moment
 * either record is edited — and the server will refuse a merge that replays a
 * stale fingerprint anyway. Short window, and never served from a long-lived
 * cache.
 */
const PLAN_STALE_MS = 30_000;

export function useDuplicateScan() {
  const gate = useOnlineQueryGate();
  return useQuery<DuplicateScanPage>({
    queryKey: ["subscriber-duplicates", "scan", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: SCAN_STALE_MS,
    retry: 0,
    queryFn: () => startDuplicateScan(DUPLICATE_PAIRS_PAGE_SIZE),
  });
}

/**
 * Pages TWO onwards of the manifest the scan query already opened.
 *
 * `initialCursor` is the first page's `next_cursor`, so this query does not
 * exist until there is somewhere to go — which is also why an empty cursor
 * disables it rather than re-reading page one.
 *
 * `active` IS NOT OPTIONAL SUGAR. A mounted `useInfiniteQuery` fetches its
 * first page eagerly, so leaving this enabled the moment a cursor exists would
 * pull fifty rows onto a screen whose whole argument is that a phone should
 * read twenty-five. The screen flips it on when the reader asks for more, and
 * every page after that is an explicit `fetchNextPage`.
 */
export function useDuplicatePairPages(
  scanId: string,
  initialCursor: string,
  active: boolean,
) {
  const gate = useOnlineQueryGate();
  return useInfiniteQuery({
    queryKey: [
      "subscriber-duplicates",
      "pairs",
      gate.tenantId,
      scanId,
      initialCursor,
    ],
    enabled:
      gate.enabled &&
      Boolean(gate.tenantId) &&
      Boolean(scanId) &&
      Boolean(initialCursor) &&
      active,
    staleTime: PAIRS_STALE_MS,
    initialPageParam: initialCursor,
    getNextPageParam: (last: DuplicateScanPage) =>
      last.nextCursor === "" ? undefined : last.nextCursor,
    queryFn: ({ pageParam }) =>
      listDuplicatePairs(scanId, String(pageParam), DUPLICATE_PAIRS_PAGE_SIZE),
  });
}

/**
 * The server's exact plan for ONE pair.
 *
 * Modelled as a query rather than a mutation because it is a pure computation
 * — `dry_run: true` returns before any statement runs (apply.go:339-342) — and
 * because the five-state ladder is exactly what the review card needs: the
 * plan can be loading, offline, refused, or absent, and each of those is a
 * different sentence.
 */
export function useDuplicateMergePlan(
  request: DuplicateMergeRequest | null,
  canMerge: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<DuplicateMergePlan | null>({
    queryKey: [
      "subscriber-duplicates",
      "plan",
      gate.tenantId,
      request?.scanId ?? null,
      request ? `${request.survivorId}:${request.loserId}` : null,
    ],
    enabled:
      gate.enabled && Boolean(gate.tenantId) && canMerge && Boolean(request),
    staleTime: PLAN_STALE_MS,
    retry: 0,
    queryFn: () => previewDuplicateMerge(request as DuplicateMergeRequest),
  });
}

/**
 * Run the reviewed merge.
 *
 * NEVER OPTIMISTIC and never queued offline: this consolidates two people's
 * consent records and re-points their history, and `isQueueableMutation`
 * refuses `/api/v1/merge/apply` for exactly that reason
 * (lib/offlineQueueSafety). The row's merged state comes from the server's
 * response, not from the client assuming success.
 *
 * INVALIDATION, CHOSEN NARROWLY. The plan for this pair is dead the moment it
 * is applied, and every cached subscriber read is now wrong — the survivor was
 * rewritten and the loser was disabled. The SCAN is deliberately left alone:
 * re-fetching it would materialize a whole new manifest over every subscriber
 * in the workspace, which is a heavy server operation to trigger from a row
 * tap. The screen marks the row merged locally and offers a rescan instead.
 */
export function useApplyDuplicateMerge() {
  const client = useQueryClient();
  return useMutation<
    DuplicateMergePlan | null,
    unknown,
    DuplicateMergeRequest & { planFingerprint: string }
  >({
    mutationFn: (input) => applyDuplicateMerge(input),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: ["subscriber-duplicates", "plan"],
      });
      void client.invalidateQueries({ queryKey: ["subscribers"] });
      void client.invalidateQueries({ queryKey: ["sub"] });
    },
  });
}
