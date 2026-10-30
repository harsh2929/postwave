/**
 * useSuppressionOps — the suppression READS: server-side search, the paged
 * archive, the growth trend, the per-address audit trail, and the SMS opt-out
 * table.
 *
 * The list query used to hardcode `?page=1&size=50` and filter client-side,
 * with a comment claiming "the gateway's suppression endpoint doesn't accept
 * filters yet". It has accepted `email=` and `q=` since the A20 change
 * (apps/api/internal/suppressions/handlers.go List), and `total` reflects the
 * FILTERED count — so for a tenant with 400k suppressions, searching for an
 * address returned "Nothing matches" for ~99.99% of them.
 *
 * Snapshot caveat: only the UNFILTERED first page is written to the vault. A
 * filtered page cached as "the" snapshot would show an offline operator a
 * subset and call it the whole list.
 *
 * WHAT LIVES WHERE, AND WHY.
 *  - The WRITES are in hooks/useSuppressionWrites.ts. They share a rule the
 *    reads do not — online-only, never queued from a stale phone — and they
 *    are re-exported below, so no call site had to change.
 *  - The PURE decisions (cache keys, the server-filterable predicate, the
 *    refusal copy, the SMS phone rule) are in lib/suppressionOpsContracts.ts,
 *    which imports nothing and is therefore testable in the node environment.
 *  - This file is the React half: TanStack Query, the SDK client, the vault.
 *
 * Endpoints:
 *   GET    /api/v1/deliverability/suppressions?page=&size=&email=&q=
 *   GET    /api/v1/deliverability/suppressions/{email}/audit
 *   GET    /api/v1/suppressions/trend?days=30
 *   GET    /api/v1/sms/suppressions
 */
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { getClient } from "@/api/sdkClient";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  assertCurrentSmsIdentity,
  type SmsInboxAccess,
} from "@/hooks/useSmsInbox";
import {
  loadSnapshotBacked,
  snapshotScope,
  type SnapshotBacked,
} from "@/lib/deliverabilitySnapshots";
import {
  mergeSuppressionPages,
  nextSuppressionPageParam,
  normalizeSuppressionPage,
  SUPPRESSION_MAX_PAGES,
  SUPPRESSION_PAGE_SIZE,
  type SuppressionPage,
  type SuppressionPageBacking,
  type SuppressionRow,
} from "@/lib/suppressionPage";
import {
  classifySearchQuery,
  searchQueryParams,
  type ClassifiedQuery,
} from "@/lib/suppressionSearch";
import {
  isServerFilteredQuery,
  SMS_SUPPRESSIONS_KEY_ROOT,
  smsSuppressionPhoneAccepted,
  smsSuppressionsKey,
  SUPPRESSION_SNAPSHOT_UNAVAILABLE,
  suppressionListQueryKey,
} from "@/lib/suppressionOpsContracts";
import {
  parseSmsSuppressions,
  parseSuppressionAudit,
  parseSuppressionTrend,
  type SmsSuppressionsPage,
  type SuppressionAuditPage,
  type SuppressionTrend,
} from "@/lib/suppressionContracts";

export type { SuppressionPage, SuppressionRow };

// Re-exported so call sites keep one import; the values and the paging rule
// itself live in lib/suppressionPage.ts, which imports nothing and is
// therefore testable in the node environment.
export { SUPPRESSION_MAX_PAGES, SUPPRESSION_PAGE_SIZE };

// Same reason: the online-only write refusals are plain classes, so they live
// in the pure contracts module and are re-exported from their original home.
export {
  OfflineWriteRefusedError,
  SuppressionExportOfflineError,
} from "@/lib/suppressionOpsContracts";

// The writes moved to their own file (see the header); every call site that
// imported them from here still can.
export {
  addSmsSuppressionWithAdminReauth,
  removeSmsSuppressionWithAdminReauth,
  useAddSmsSuppression,
  useAddSuppression,
  useExportSuppressions,
  useMirrorSuppressions,
  useRemoveSmsSuppression,
  useRemoveSuppression,
} from "@/hooks/useSuppressionWrites";

async function fetchSuppressionPage(
  classified: ClassifiedQuery,
  page: number,
): Promise<SuppressionPage> {
  const { client } = getClient();
  const path =
    `/api/v1/deliverability/suppressions?page=${page}&size=${SUPPRESSION_PAGE_SIZE}` +
    searchQueryParams(classified);
  return normalizeSuppressionPage(await client.request<unknown>("GET", path));
}

/**
 * The FIRST suppression page, filtered server-side when the query is long
 * enough to be worth a round trip (see `classifySearchQuery`).
 *
 * Deliberately single-page: its remaining caller is the detail screen, which
 * uses the exact-match arm to resolve one address. Browsing lives in
 * `useSuppressionList` below — this used to take a `page` argument that no
 * caller ever passed, so only the newest 50 rows were reachable at all.
 */
export function useSuppressions(rawQuery = "") {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  const classified: ClassifiedQuery = classifySearchQuery(rawQuery);

  return useQuery({
    queryKey: suppressionListQueryKey(gate, classified, 1),
    enabled: gate.canReadOfflineSnapshots && Boolean(scope),
    networkMode: "always",
    queryFn: (): Promise<SnapshotBacked<SuppressionPage>> =>
      loadSnapshotBacked({
        resource: "suppression-page",
        scope,
        canUseNetwork: gate.enabled,
        // Only the canonical first, unfiltered page is persisted — a cached
        // filtered subset presented as the whole list is worse than no cache.
        persist: !isServerFilteredQuery(classified),
        loadNetwork: () => fetchSuppressionPage(classified, 1),
        unavailableMessage: SUPPRESSION_SNAPSHOT_UNAVAILABLE,
      }),
  });
}

/**
 * The browsable suppression list: page 1 exactly as above, plus every page the
 * operator asks for.
 *
 * TWO RULES THIS ENCODES.
 *
 *  - A LATER PAGE IS A LIVE READ, NEVER A SNAPSHOT. The vault holds one
 *    projection, of page 1. Routing page 2 through `loadSnapshotBacked` while
 *    offline would hand that same projection back as "the next page" and the
 *    merge would either duplicate every row or silently show them twice.
 *  - A SNAPSHOT NEVER OFFERS "LOAD MORE". `getNextPageParam` returns undefined
 *    for a cached page, so an offline operator is not given a control whose
 *    only possible outcome is a failed request.
 *
 * The result is shaped like the single-page hook — one `SnapshotBacked`
 * envelope — because the screen renders a single flat list; `hasNextPage` /
 * `fetchNextPage` ride alongside it.
 */
export function useSuppressionList(rawQuery = "") {
  const gate = useOnlineQueryGate();
  const scope = snapshotScope(gate);
  const classified: ClassifiedQuery = classifySearchQuery(rawQuery);

  const query = useInfiniteQuery({
    queryKey: suppressionListQueryKey(gate, classified, "paged"),
    enabled: gate.canReadOfflineSnapshots && Boolean(scope),
    networkMode: "always",
    initialPageParam: 1,
    queryFn: async ({ pageParam }): Promise<SuppressionPageBacking> => {
      if (pageParam > 1) {
        return {
          value: await fetchSuppressionPage(classified, pageParam),
          fromSnapshot: false,
          capturedAt: Date.now(),
        };
      }
      return loadSnapshotBacked({
        resource: "suppression-page",
        scope,
        canUseNetwork: gate.enabled,
        persist: !isServerFilteredQuery(classified),
        loadNetwork: () => fetchSuppressionPage(classified, 1),
        unavailableMessage: SUPPRESSION_SNAPSHOT_UNAVAILABLE,
      });
    },
    getNextPageParam: (lastPage, allPages) =>
      nextSuppressionPageParam(lastPage, allPages),
  });

  const data = useMemo(
    () => mergeSuppressionPages(query.data?.pages),
    [query.data],
  );

  return {
    data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}

/** 30-day suppression growth, zero-filled UTC days oldest-first. */
export function useSuppressionTrend(days = 30) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["suppression-trend", gate.tenantId, days],
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SuppressionTrend> => {
      const { client } = getClient();
      return parseSuppressionTrend(
        await client.request<unknown>(
          "GET",
          `/api/v1/suppressions/trend?days=${days}`,
        ),
      );
    },
  });
}

/**
 * The audit trail for one address. Keyed by email server-side, so it survives
 * the row's deletion — which is exactly why it is worth showing after an
 * un-suppress.
 */
export function useSuppressionAudit(email: string) {
  const gate = useOnlineQueryGate();
  const address = email.trim().toLowerCase();
  return useQuery({
    queryKey: ["suppression-audit", gate.tenantId, address],
    enabled: gate.enabled && Boolean(gate.tenantId) && address.length > 0,
    queryFn: async (): Promise<SuppressionAuditPage> => {
      const { client } = getClient();
      return parseSuppressionAudit(
        await client.request<unknown>(
          "GET",
          `/api/v1/deliverability/suppressions/${encodeURIComponent(address)}/audit`,
        ),
      );
    },
  });
}

/**
 * SMS suppression authority. A separate table with its own routes — GET,
 * exact-phone query POST, manual-add POST, and DELETE all require the exact
 * effective owner/admin boundary.
 */
export function useSmsSuppressions(access: SmsInboxAccess, phoneE164?: string) {
  const queryClient = useQueryClient();
  const phone = phoneE164 ?? "";
  const validPhone = smsSuppressionPhoneAccepted(phone);
  const key = useMemo(
    () => smsSuppressionsKey(access.identity?.fingerprint ?? null, phone),
    [access.identity?.fingerprint, phone],
  );
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: access.canRequest && validPhone,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<SmsSuppressionsPage> => {
      if (!access.canRequest || !access.identity) {
        throw new Error("SMS suppression identity is unavailable.");
      }
      if (!validPhone) {
        throw new Error(
          "SMS suppression search requires an exact US/Canada number.",
        );
      }
      const identity = access.identity;
      assertCurrentSmsIdentity(identity);
      const { client } = getClient();
      const continuation = {
        limit: 100,
        ...(pageParam ? { cursor: pageParam } : {}),
      };
      const page = parseSmsSuppressions(
        await client.request<unknown>(
          phone ? "POST" : "GET",
          phone ? "/api/v1/sms/suppressions/query" : "/api/v1/sms/suppressions",
          phone
            ? { body: { phone }, idempotencyKey: null, signal }
            : { query: continuation, signal },
        ),
        identity.tenantId,
        phone ? 1 : 100,
        phone || undefined,
      );
      assertCurrentSmsIdentity(identity);
      return page;
    },
    getNextPageParam: (page) => page.nextCursor,
  });
  useEffect(() => {
    if (!access.roleAllowed || !access.identity) {
      void queryClient.cancelQueries({ queryKey: [SMS_SUPPRESSIONS_KEY_ROOT] });
      queryClient.removeQueries({ queryKey: [SMS_SUPPRESSIONS_KEY_ROOT] });
    } else if (!access.canRequest) {
      void queryClient.cancelQueries({ queryKey: key, exact: true });
    }
    return () => {
      void queryClient.cancelQueries({ queryKey: key, exact: true });
      queryClient.removeQueries({ queryKey: key, exact: true });
    };
  }, [
    access.canRequest,
    access.identity,
    access.roleAllowed,
    key,
    queryClient,
  ]);
  const refreshFirstPage = useCallback(
    () => queryClient.resetQueries({ queryKey: key, exact: true }),
    [key, queryClient],
  );
  return { ...query, refreshFirstPage };
}
