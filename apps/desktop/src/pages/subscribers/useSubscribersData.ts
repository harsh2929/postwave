import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import type { QueryClient } from "@tanstack/react-query";

import {
  clearRecentSubscriberSearches,
  pushRecentSubscriberSearch,
} from "../../components/subscribers/recent-searches";
import type { Subscriber } from "../../lib/api-client";
import { useOutbox } from "../../lib/outbox";
import type { Role } from "../../lib/store";
import { pagerView } from "../subscribers-paging";
import {
  fetchSubscriberDirectoryPage,
  type SubscriberDirectoryFetchParams,
} from "./fetch-subscriber-directory-page";
import { queuedSubscriberPatches } from "./subscriber-live-reconciliation";
import type { SubscribersPageState } from "./useSubscribersPageState";
import { SUBSCRIBERS_PER_PAGE } from "./subscribers-page-utils";
import { useSubscriberDashboardStats } from "./useSubscriberDashboardStats";
import { useSubscriberMutationLedger } from "./useSubscriberMutationLedger";

interface UseSubscribersDataOptions {
  state: SubscribersPageState;
  tenantId: string | null;
  recentSearchScope: string | null;
  role: Role | null;
  queryClient: QueryClient;
}

export function useSubscribersData({
  state,
  tenantId,
  recentSearchScope,
  role,
  queryClient,
}: UseSubscribersDataOptions) {
  const [rows, setRowsState] = useState<Subscriber[] | null>(null);
  const [matchTotal, setMatchTotal] = useState<number | null>(null);
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastConfirmedAt, setLastConfirmedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const outbox = useOutbox();
  const abortRef = useRef<AbortController | null>(null);
  const requestTokenRef = useRef(0);
  const backgroundReloadRef = useRef(false);
  const lastLoadedQueryRef = useRef("");
  const loadedScopeRef = useRef<string | null>(null);
  const rowsRef = useRef<Subscriber[] | null>(null);
  const loadedIdentityRef = useRef<string | null>(null);
  const searchBootRef = useRef(true);
  const recentSearchScopeRef = useRef(recentSearchScope);
  const queryRef = useRef(state.query);
  queryRef.current = state.query;

  const queuedPatches = useMemo(
    () => queuedSubscriberPatches(outbox.all),
    [outbox.all],
  );
  const queuedPatchesRef = useRef(queuedPatches);
  queuedPatchesRef.current = queuedPatches;

  const setRows = useCallback(
    (update: SetStateAction<Subscriber[] | null>): void => {
      setRowsState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        rowsRef.current = next;
        return next;
      });
    },
    [],
  );
  const reload = useCallback(
    (): void => setReloadNonce((nonce) => nonce + 1),
    [],
  );
  const mutationLedger = useSubscriberMutationLedger(reload);
  const dashboardStats = useSubscriberDashboardStats(recentSearchScope);

  const runFetch = (params: SubscriberDirectoryFetchParams): Promise<void> =>
    fetchSubscriberDirectoryPage({
      params,
      ownership: {
        abort: abortRef,
        requestToken: requestTokenRef,
        backgroundReload: backgroundReloadRef,
        loadedScope: loadedScopeRef,
        rows: rowsRef,
        loadedIdentity: loadedIdentityRef,
        lastLoadedQuery: lastLoadedQueryRef,
        mutationRevision: mutationLedger.revisionRef,
        activeMutationTokens: mutationLedger.activeTokensRef,
        localMutationMarkers: mutationLedger.localMarkersRef,
        reconcileAfterMutations: mutationLedger.reconcileAfterMutationsRef,
        queuedPatches: queuedPatchesRef,
      },
      set: {
        rows: setRows,
        matchTotal: setMatchTotal,
        serverTotal: setServerTotal,
        loading: setLoading,
        refreshing: setRefreshing,
        stale: setStale,
        lastConfirmedAt: setLastConfirmedAt,
        error: setError,
      },
      tenantId,
      role,
      queryClient,
      reload,
    });

  useEffect(() => {
    if (searchBootRef.current) {
      searchBootRef.current = false;
      state.setDebouncedQuery(state.query);
      return;
    }
    // Route restoration updates the visible and applied query together. Do
    // not schedule the ordinary typing debounce in that already-synchronized
    // state: its delayed page reset would otherwise erase Back/Forward's page.
    if (state.query === state.debouncedQuery) return;
    const pendingQuery = state.query;
    const priorAppliedQuery = state.debouncedQuery;
    const timer = window.setTimeout(() => {
      void state
        .requestViewChange((current) => ({
          ...current,
          query: pendingQuery,
          page: 1,
          savedSegmentId: null,
        }))
        .then((result) => {
          if (result !== "proceeded" && queryRef.current === pendingQuery) {
            state.setQuery(priorAppliedQuery);
          }
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    state.debouncedQuery,
    state.query,
    state.requestViewChange,
    state.setQuery,
  ]);

  const replaySignature = useMemo(
    () =>
      outbox.recent
        .filter((entry) => entry.resource === "subscribers")
        .map((entry) => `${entry.id}:${entry.status}:${entry.resolvedAt}`)
        .join("|"),
    [outbox.recent],
  );
  const replayOwnerRef = useRef({
    identity: recentSearchScope,
    signature: replaySignature,
  });
  useEffect(() => {
    if (replayOwnerRef.current.identity !== recentSearchScope) {
      replayOwnerRef.current = {
        identity: recentSearchScope,
        signature: replaySignature,
      };
      return;
    }
    if (replayOwnerRef.current.signature === replaySignature) return;
    replayOwnerRef.current.signature = replaySignature;
    backgroundReloadRef.current = true;
    reload();
  }, [recentSearchScope, reload, replaySignature]);

  useEffect(() => {
    if (recentSearchScopeRef.current !== recentSearchScope) {
      recentSearchScopeRef.current = recentSearchScope;
      mutationLedger.reset();
      setServerTotal(null);
      setLastConfirmedAt(null);
      setError(null);
      setStale(false);
      clearRecentSubscriberSearches();
      // A mounted Subscribers page can survive a workspace switch. Do not
      // copy the previous workspace's live query into the next identity.
      state.setQuery("");
      state.setDebouncedQuery("");
      state.setPage(1);
      state.setSelectedKeys(new Set());
      return;
    }
    pushRecentSubscriberSearch(recentSearchScope, state.debouncedQuery);
  }, [
    recentSearchScope,
    state.debouncedQuery,
    state.setDebouncedQuery,
    state.setPage,
    state.setQuery,
    state.setSelectedKeys,
  ]);

  useEffect(() => {
    void runFetch({
      identityScope: recentSearchScope,
      query: state.debouncedQuery,
      status: state.filter,
      sortColumn: state.sortColumn,
      sortOrder: state.sortOrder,
      page: state.page,
      includeArchived: state.showArchived,
    });
    return () => abortRef.current?.abort();
    // runFetch reads only its arguments plus stable refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.debouncedQuery,
    state.filter,
    state.sortColumn,
    state.sortOrder,
    state.page,
    reloadNonce,
    state.showArchived,
    recentSearchScope,
  ]);

  const identityMatches = loadedIdentityRef.current === recentSearchScope;
  const safeRows = identityMatches ? rows : null;
  const safeMatchTotal = identityMatches ? matchTotal : null;
  const safeServerTotal = identityMatches ? serverTotal : null;
  const pageRows = useMemo(
    () => (Array.isArray(safeRows) ? safeRows : []),
    [safeRows],
  );
  const pager = useMemo(
    () =>
      pagerView(
        state.page,
        safeMatchTotal,
        SUBSCRIBERS_PER_PAGE,
        pageRows.length,
      ),
    [state.page, safeMatchTotal, pageRows.length],
  );
  useEffect(() => {
    if (!pager.hasTotal || state.page === pager.page) return;
    void state.requestViewChange((current) => ({
      ...current,
      page: pager.page,
    }));
  }, [pager.hasTotal, pager.page, state.page, state.requestViewChange]);

  return {
    rows: safeRows,
    setRows,
    matchTotal: safeMatchTotal,
    serverTotal: safeServerTotal,
    loading: identityMatches ? loading : true,
    refreshing: identityMatches ? refreshing : false,
    stale: identityMatches ? stale : false,
    lastConfirmedAt: identityMatches ? lastConfirmedAt : null,
    error: identityMatches ? error : null,
    dashboardStats,
    pageRows,
    pager,
    reload,
    backgroundReloadRef,
    lastLoadedQueryRef,
    beginOptimisticRowMutation: mutationLedger.begin,
    finishOptimisticRowMutation: mutationLedger.finish,
    markLocalRowMutation: mutationLedger.mark,
  };
}

export type SubscribersData = ReturnType<typeof useSubscribersData>;
