/**
 * Resource hooks — thin wrappers around @postwave/sdk that plug into
 * TanStack Query so the UI gets caching + dedup + retries for free.
 *
 * The query keys are intentionally compound (tenant + resource + page)
 * so a workspace switch invalidates everything correctly without us
 * having to call queryClient.clear() manually.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { getClient, type PostwaveContext } from "@/api/client";
import { updateSubscriberConditionally } from "@/api/subscriberConditionalWrite";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { SubscriberWriteStatus } from "@/hooks/useSubscriberSuppressionWrites";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  loadOfflineCapableSnapshot,
  OfflineSnapshotUnavailableError,
} from "../lib/offlineSnapshots";
import {
  isSnapshotableView,
  SUBSCRIBER_LIST_OFFLINE_MESSAGE,
} from "@/lib/subscriberListSnapshot";
import {
  readSubscriberListSnapshot,
  writeSubscriberListSnapshot,
} from "@/lib/subscriberListVault";
import {
  subscriberWriteKey,
  subscriberWriteQueue,
} from "@/lib/serialQueue";
import {
  invalidateKeys,
  rollbackPatchedQueries,
  subscriberRowPatch,
  type OptimisticPatchContext,
} from "@/lib/subscriberQueryCache";
import {
  subscriberListKey,
  subscriberMutationInvalidationKeys,
} from "@/lib/subscriberQueryKeys";
import {
  subscriberSortToken,
  type SubscriberSortOrder,
} from "@/lib/subscriberSort";
import {
  vaultGetJSON,
  vaultScopeForClient,
  vaultSetJSON,
} from "@/lib/secureVault";

const PER_PAGE = 25;

type SubscriberDetail = Awaited<
  ReturnType<PostwaveContext["client"]["subscribers"]["get"]>
>;

// Query keys live in src/lib/subscriberQueryKeys.ts (dependency-free, so the
// membership hooks can share them without a hooks→hooks cycle) and are
// re-exported here for the screens that already import them from this module.
export {
  subscriberDetailKey,
  subscriberListKey,
  subscriberMutationInvalidationKeys,
  subscriberTimelineKey,
  SUBSCRIBER_TIMELINE_KEY_ROOT,
} from "@/lib/subscriberQueryKeys";

/**
 * Query params for one page of the list.
 *
 * `sort`/`order` are read by the Go handler (ListOptions → normalizeSort)
 * and are now DECLARED on the SDK's ListSubscribersParams — they used to
 * reach the wire only because `subscribers.list()` casts its params to a
 * plain record, which meant a typo in either was silently ignored rather
 * than caught. `order` is narrowed to the server's two values for the same
 * reason.
 */
export function subscriberListParams(
  query: string | undefined,
  status: string | undefined,
  page: number,
  sort?: { sort: string; order: SubscriberSortOrder } | undefined,
  /**
   * AUDIENCE#56 — `?include_archived=true` (handlers.go:246). Sent ONLY when
   * true: the handler reads it through `isTruthy`, and emitting
   * `include_archived=false` on every request would put a soft-delete concept
   * on the wire for the default view that does not need it.
   */
  includeArchived?: boolean,
) {
  const q = (query ?? "").trim();
  return {
    page,
    per_page: PER_PAGE,
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
    ...(sort ? { sort: sort.sort, order: sort.order } : {}),
    ...(includeArchived ? { include_archived: true } : {}),
  };
}

/**
 * The subscribers list, now offline-capable for ONE view.
 *
 * The detail query has been offline-capable through the secure vault for a
 * while; the list that leads to it was not, so the snapshots were unreachable
 * without a connection. Page 1 of the unfiltered, default-ordered list is now
 * projected into the same identity-scoped vault (minimised by
 * lib/subscriberListSnapshot — the raw page does not fit the vault's 24KB key
 * ceiling and carries far more about a person than a row renders).
 *
 * Every OTHER view stays online-only and says so, because a snapshot keyed by
 * "the last thing you looked at" would answer a different question than the
 * one the search box and chips currently claim is active.
 */
export function useSubscribers(
  query?: string,
  status?: string,
  sort?: { sort: string; order: SubscriberSortOrder } | undefined,
  /**
   * AUDIENCE#56. `include_archived=true` widens the result set to include
   * soft-deleted rows ALONGSIDE the active ones — it is not an "archived only"
   * view, and the screen labels it accordingly. It is deliberately excluded
   * from the offline snapshot (see `isSnapshotableView` below): the vault holds
   * exactly one page for exactly one view, and answering "show me archived
   * too" from an active-only projection would be a wrong answer rather than a
   * stale one.
   */
  includeArchived?: boolean,
) {
  const gate = useOnlineQueryGate();
  const vaultScope =
    gate.baseUrl && gate.tenantId && gate.userId && gate.effectiveRole
      ? vaultScopeForClient({
          baseUrl: gate.baseUrl,
          tenantId: gate.tenantId,
          userId: gate.userId,
          role: gate.effectiveRole,
        })
      : null;
  const sortToken = subscriberSortToken(sort);
  return useInfiniteQuery({
    queryKey: subscriberListKey(
      gate.tenantId,
      query,
      status,
      sortToken,
      includeArchived,
    ),
    // Runs while offline so the vault projection can answer. Writes are
    // separately gated by the screen's cachedSessionNotice, so a cold-offline
    // read never enables a mutation.
    enabled: gate.canReadOfflineSnapshots && Boolean(gate.tenantId),
    networkMode: "always",
    queryFn: async ({ pageParam = 1 }) => {
      const loadNetwork = async () => {
        const { client } = getClient();
        // GET /subscribers accepts q + status + sort + paging together, so
        // this path avoids both the old one-page search cap and client-side
        // status scans over the whole tenant table.
        return client.subscribers.list(
          subscriberListParams(query, status, pageParam, sort, includeArchived),
        );
      };
      const snapshotable =
        vaultScope !== null &&
        // The snapshot is the DEFAULT view only; "show archived" is not it.
        !includeArchived &&
        isSnapshotableView({
          query,
          status,
          sortToken,
          defaultSortToken: subscriberSortToken(undefined),
          page: pageParam,
        });
      if (!snapshotable) {
        if (!gate.enabled) {
          throw new OfflineSnapshotUnavailableError(
            SUBSCRIBER_LIST_OFFLINE_MESSAGE,
          );
        }
        return loadNetwork();
      }
      return loadOfflineCapableSnapshot({
        canUseNetwork: gate.enabled,
        loadNetwork,
        readSnapshot: () =>
          readSubscriberListSnapshot(vaultScope!) as Promise<never>,
        writeSnapshot: (page) =>
          writeSubscriberListSnapshot(vaultScope!, page),
        networkAvailable: isProbablyOnline,
        unavailableMessage: SUBSCRIBER_LIST_OFFLINE_MESSAGE,
      });
    },
    initialPageParam: 1,
    getNextPageParam: (last, all) => {
      // Offline there is exactly one saved page; offering "load more" would
      // spin against a network that is not there.
      if (!gate.enabled) return undefined;
      if (!last || !("page" in last)) return undefined;
      // Termination guard: if the most recent page came back empty, stop
      // paginating even when the server's `total` still claims more rows.
      // Without this, a stale/over-counted total (deletions between page
      // fetches) keeps `seen` frozen below `total`, looping requests for
      // the next (always-empty) page on every scroll-to-end.
      if (!last.items?.length) return undefined;
      const seen = all.reduce((n, p) => n + (p.items?.length ?? 0), 0);
      const total = last.total ?? 0;
      return seen < total ? all.length + 1 : undefined;
    },
  });
}

export function useSubscriber(id: string | undefined) {
  const gate = useOnlineQueryGate();
  const vaultScope =
    gate.baseUrl && gate.tenantId && gate.userId && gate.effectiveRole
      ? vaultScopeForClient({
          baseUrl: gate.baseUrl,
          tenantId: gate.tenantId,
          userId: gate.userId,
          role: gate.effectiveRole,
        })
      : null;
  return useQuery({
    queryKey: [
      // Key ORDER is load-bearing: `id` must stay in position 2 (right after
      // tenantId) so the `["sub", tenantId, id]` prefix returned by
      // subscriberMutationInvalidationKeys partial-matches this query.
      // TanStack invalidation does a position-by-position prefix compare, so
      // userId/effectiveRole/mode must come AFTER id — otherwise a subscriber
      // mutation never invalidates this detail query and the next tag edit
      // computes its full-array-replace PATCH from a stale base (lost tags).
      "sub",
      gate.tenantId,
      id,
      gate.userId,
      gate.effectiveRole,
      gate.enabled ? "network" : "snapshot",
    ],
    enabled:
      gate.canReadOfflineSnapshots &&
      Boolean(gate.tenantId && id && vaultScope),
    networkMode: "always",
    queryFn: (): Promise<SubscriberDetail> =>
      loadOfflineCapableSnapshot({
        canUseNetwork: gate.enabled,
        loadNetwork: async () => {
          const { client } = getClient();
          return client.subscribers.get(id!);
        },
        readSnapshot: () =>
          vaultGetJSON<SubscriberDetail>(
            "subscriber",
            id!,
            vaultScope ? { scope: vaultScope } : {},
          ),
        writeSnapshot: (subscriber) =>
          vaultSetJSON("subscriber", id!, subscriber, {
            ...(vaultScope ? { scope: vaultScope } : {}),
          }),
        networkAvailable: isProbablyOnline,
        unavailableMessage:
          "No saved subscriber snapshot is available offline.",
      }),
  });
}

// The suppression PAIR (suppress + its undo) moved to
// hooks/useSubscriberSuppressionWrites.ts when this file passed its size
// budget. Re-exported so every existing call site keeps one import.
export {
  useSuppressSubscriber,
  useUnsuppressSubscriber,
} from "@/hooks/useSubscriberSuppressionWrites";

/* ============================================================
 * Subscriber field actions — tag/untag, add-to-list,
 * unsubscribe/resubscribe, edit.
 *
 * Wire contract (apps/api/internal/subscribers):
 *
 *   PATCH /api/v1/subscribers/{id}      tags[] (full replace) + status
 *   POST  /api/v1/subscribers/bulk/add-to-list   { subscriber_ids, list_id }
 *
 * Tag/untag and unsubscribe/resubscribe both go through the typed
 * `subscribers.update` PATCH (write_subscribers scope) — the API treats
 * `tags` as a full-array replace, so the hooks below compute the next
 * set client-side from the current subscriber. Status mapping mirrors the
 * web admin: unsubscribe → "disabled", resubscribe → "enabled". (The
 * harsher "blocklisted" transition stays behind the dedicated Suppress
 * action / useSuppressSubscriber above.)
 *
 * Add-to-list has no PATCH path; it reuses the bulk endpoint scoped to a
 * single subscriber id (ON CONFLICT DO NOTHING is idempotent server-side).
 * ============================================================ */

/** Subscriber `status` values the API's PATCH accepts. */
export type { SubscriberWriteStatus };

// The pure tag-set algebra now lives beside the tag validation rules in
// src/lib/tagInput.ts; re-exported here so existing call sites and the
// mutation below keep one import.
export { nextTagsAfterAdd, nextTagsAfterRemove } from "@/lib/tagInput";

/**
 * useUpdateSubscriberTags — replace the subscriber's full tag set.
 * Lower-level than the add/untag helpers; the screen calls this with the
 * array produced by nextTagsAfter{Add,Remove}.
 *
 * TWO defects are fixed here, and both are needed:
 *
 * 1. STALE BASE. The caller derives the next array from `sub.data.tags`.
 *    The old onSuccess fired `void invalidateQueries(...)` — not awaited —
 *    so `isPending` flipped false while the detail refetch was still in
 *    flight. Adding "a" then "b" inside that window computed b's PATCH
 *    from the pre-"a" array and silently wiped "a". The optimistic
 *    onMutate below writes the projected array into the detail cache
 *    immediately, so the next add always reads a correct base.
 *
 * 2. REORDERING. `tags` is a FULL-ARRAY REPLACE, so two overlapping
 *    PATCHes are a lost-update race however the client renders: whichever
 *    the server commits last wins. `subscriberWriteQueue` serialises
 *    writes per subscriber id so the last write is the last one the user
 *    asked for.
 */
export function useUpdateSubscriberTags() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (input: { id: string; tags: string[] }) =>
      subscriberWriteQueue(subscriberWriteKey(input.id), () =>
        // Reads the ETag and echoes it as If-Match. The server REQUIRES it and
        // 428s otherwise (handlers.go:590-594), so a bare update cannot succeed.
        updateSubscriberConditionally(input.id, { tags: input.tags }),
      ),
    onMutate: (input) =>
      optimisticSubscriberPatch(queryClient, tenantId, input.id, {
        tags: input.tags,
      }),
    onError: (_err, _input, context) =>
      rollbackPatchedQueries(queryClient, context),
    onSettled: (_data, _err, input) =>
      invalidateSubscriber(queryClient, tenantId, input.id),
  });
}

/**
 * useSetSubscriberStatus — flip the subscriber's status.
 *
 * Callers must pass an ENGINE status. Use `uiStatusToEngine` from
 * src/lib/subscriberStatus.ts rather than hand-writing one: unsubscribe is
 * `blocklisted` (matching desktop and web), NOT `disabled`. `disabled` is
 * the separate "Inactive" state.
 */
export function useSetSubscriberStatus() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: (input: { id: string; status: SubscriberWriteStatus }) =>
      subscriberWriteQueue(subscriberWriteKey(input.id), () =>
        updateSubscriberConditionally(input.id, { status: input.status }),
      ),
    onMutate: (input) =>
      optimisticSubscriberPatch(queryClient, tenantId, input.id, {
        status: input.status,
      }),
    onError: (_err, _input, context) =>
      rollbackPatchedQueries(queryClient, context),
    onSettled: (_data, _err, input) =>
      invalidateSubscriber(queryClient, tenantId, input.id),
  });
}

/* ---- optimistic-update plumbing shared by the row mutations ---- */

/**
 * Project a field change onto every mounted variant of the detail query —
 * and, for a status change, onto the TIMELINE cache as well, because that is
 * where the screen's status pill actually comes from. The projection and its
 * rollback live in lib/subscriberQueryCache.ts so both are unit-tested.
 */
function optimisticSubscriberPatch(
  queryClient: QueryClient,
  tenantId: string | null,
  id: string,
  patch: Partial<Pick<SubscriberDetail, "tags" | "status">>,
): Promise<OptimisticPatchContext> {
  return subscriberRowPatch<SubscriberDetail>(queryClient, tenantId, id, patch);
}

function invalidateSubscriber(
  queryClient: QueryClient,
  tenantId: string | null,
  id: string,
): void {
  if (!tenantId) return;
  invalidateKeys(queryClient, subscriberMutationInvalidationKeys(tenantId, id));
}

// The membership ADD moved to hooks/useSubscriberLists.ts, beside the
// membership query and the removal it mirrors: both directions now project
// the SAME `["sub-lists", …]` cache entry, and keeping them in two modules is
// how they came to disagree (removal was instant, adding — including the UNDO
// of a removal — waited on a round trip). Re-exported so existing call sites
// and tests keep one import.
export {
  addSubscriberToList,
  useAddSubscriberToList,
} from "@/hooks/useSubscriberLists";

// useLists / normalizeLists / ListOption moved to hooks/useListOptions.ts
// (this file was at its size budget, and the catalogue is now keyed under
// the "lists" query root so a membership write refreshes the picker too).
//
// useCampaigns was removed here for the same reason useDashboardStats was:
// it was dead code with zero importers, shadowed by hooks/useCampaigns.ts
// (useCampaignsList / useCampaignsPaginated), which the campaigns and
// dashboard screens actually consume. Two divergent campaign shapes in the
// cache is a drift hazard, not a convenience.
//
// useDashboardStats was removed: it was dead code shadowed by
// useDashboardStatsQuery (hooks/useDashboard.ts), which the dashboard screen
// (app/(tabs)/dashboard.tsx) actually consumes. Keeping two divergent
// dashboard-stat shapes risked drift. (The `"dashboard"` query root is kept
// in lib/queryClient.ts — it's a live cache domain used independently by
// api/event-cache-invalidation.ts, not exclusive to this removed hook.)
