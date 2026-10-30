import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { pushSuppressionsApi } from "../lib/api-client";
import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import {
  PUSH_SUPPRESSION_PAGE_SIZE,
  filterRowsBySource,
  isFailClosedListError,
  pushCriteriaKey,
  sourceOptions,
  validateFingerprintPrefix,
  type PushPlatformFilter,
  type PushReasonFilter,
  type PushSourceFilter,
  type VerifiedPushSuppressionPage,
} from "./push-suppression-model";
import {
  usePushSuppressionMutations,
  type PushSuppressionMutationController,
} from "./usePushSuppressionMutations";

interface LoadRequest {
  criteriaKey: string;
  platform: PushPlatformFilter;
  reason: PushReasonFilter;
  query: string;
  cursor?: string;
  index: number;
  expectedSnapshot?: string | null;
}

interface DirectoryState {
  rows: PushSuppressionRow[] | null;
  visibleRows: PushSuppressionRow[];
  total: number | null;
  nextCursor: string | null;
  snapshotAt: string | null;
  pageIndex: number;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  criteriaVerified: boolean;
  authorityCurrent: boolean;
  platform: PushPlatformFilter;
  reason: PushReasonFilter;
  source: PushSourceFilter;
  sourceChoices: ReturnType<typeof sourceOptions>;
  queryInput: string;
  queryError: string | null;
}

export interface PushSuppressionsController
  extends PushSuppressionMutationController {
  directory: DirectoryState;
  setPlatform: (value: PushPlatformFilter) => void;
  setReason: (value: PushReasonFilter) => void;
  setSource: (value: PushSourceFilter) => void;
  setQueryInput: (value: string) => void;
  refresh: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  nextPage: () => Promise<boolean>;
  previousPage: () => Promise<boolean>;
  clearFilters: () => void;
}

function listFailureCopy(error: { status?: number; code?: string }): string {
  if (error.status === 404 || error.status === 405) {
    return "This server does not expose the authoritative push suppression registry. No registry rows are shown.";
  }
  if (error.code === "identity_changed") {
    return "Your workspace identity changed while this page was loading. No response from the previous identity was shown.";
  }
  if (error.code === "invalid_push_suppression_response") {
    return "The registry response failed its private row and pagination contract. No unverified rows were shown.";
  }
  return "The authoritative push suppression registry could not be loaded.";
}

export function usePushSuppressionsController({
  canAdmin,
}: {
  canAdmin: boolean;
}): PushSuppressionsController {
  const mountedRef = useRef(true);
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadSequenceRef = useRef(0);
  const lastRequestRef = useRef<LoadRequest | null>(null);
  const [rows, setRows] = useState<PushSuppressionRow[] | null>(null);
  const [loadedCriteriaKey, setLoadedCriteriaKey] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCache, setPageCache] = useState<VerifiedPushSuppressionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [platform, setPlatformState] = useState<PushPlatformFilter>("all");
  const [reason, setReasonState] = useState<PushReasonFilter>("all");
  const [source, setSourceState] = useState<PushSourceFilter>("all");
  const [queryInput, setQueryInputState] = useState("");
  const [query, setQuery] = useState("");
  const queryError = validateFingerprintPrefix(queryInput);

  const criteriaKey = useMemo(
    () => pushCriteriaKey(platform, reason, query),
    [platform, query, reason],
  );
  const criteriaVerified =
    rows !== null &&
    loadedCriteriaKey === criteriaKey &&
    queryError === null &&
    queryInput === query;
  const authorityCurrent =
    criteriaVerified && !loading && error === null && !unavailable && canAdmin;

  const load = useCallback(async (request: LoadRequest): Promise<boolean> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    lastRequestRef.current = request;
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await pushSuppressionsApi.list({
        platform: request.platform === "all" ? undefined : request.platform,
        reason: request.reason === "all" ? undefined : request.reason,
        query: request.query || undefined,
        cursor: request.cursor,
        limit: PUSH_SUPPRESSION_PAGE_SIZE,
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        requestId !== loadSequenceRef.current
      ) {
        return false;
      }
      if ("error" in result && result.error) {
        const failClosed = isFailClosedListError(result.error);
        setUnavailable(failClosed);
        setError(listFailureCopy(result.error));
        if (failClosed) {
          setRows(null);
          setLoadedCriteriaKey(null);
          setTotal(null);
          setNextCursor(null);
          setSnapshotAt(null);
          setPageCache([]);
          setPageIndex(0);
        }
        return false;
      }
      if (
        request.expectedSnapshot &&
        result.data.snapshotAt !== request.expectedSnapshot
      ) {
        setNextCursor(null);
        setError(
          "The registry changed between pages. Refresh from the first page before continuing.",
        );
        return false;
      }
      const verified: VerifiedPushSuppressionPage = {
        criteriaKey: request.criteriaKey,
        cursor: request.cursor,
        items: result.data.items,
        total: result.data.total,
        nextCursor: result.data.nextCursor ?? null,
        snapshotAt: result.data.snapshotAt,
      };
      setRows(verified.items);
      setLoadedCriteriaKey(verified.criteriaKey);
      setTotal(verified.total);
      setNextCursor(verified.nextCursor);
      setSnapshotAt(verified.snapshotAt);
      setPageIndex(request.index);
      setUnavailable(false);
      setPageCache((current) => {
        if (request.index === 0) return [verified];
        const next = current.slice(0, request.index + 1);
        next[request.index] = verified;
        return next;
      });
      return true;
    } catch {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        requestId === loadSequenceRef.current
      ) {
        setUnavailable(false);
        setError("The authoritative push suppression registry could not be loaded.");
      }
      return false;
    } finally {
      if (
        mountedRef.current &&
        requestId === loadSequenceRef.current &&
        !controller.signal.aborted
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (queryError) {
      loadAbortRef.current?.abort();
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setQuery(queryInput), 250);
    return () => window.clearTimeout(timer);
  }, [queryError, queryInput]);

  useEffect(() => {
    if (queryError) return;
    setPageCache([]);
    setPageIndex(0);
    setSourceState("all");
    void load({
      criteriaKey,
      platform,
      reason,
      query,
      index: 0,
    });
  }, [criteriaKey, load, platform, query, queryError, reason]);

  const sourceChoices = useMemo(() => sourceOptions(rows ?? []), [rows]);
  useEffect(() => {
    if (!sourceChoices.some((choice) => choice.value === source)) {
      setSourceState("all");
    }
  }, [source, sourceChoices]);
  const visibleRows = useMemo(
    () => (criteriaVerified ? filterRowsBySource(rows ?? [], source) : []),
    [criteriaVerified, rows, source],
  );

  const refresh = useCallback(
    () =>
      load({ criteriaKey, platform, reason, query, index: 0 }),
    [criteriaKey, load, platform, query, reason],
  );
  const retry = useCallback(
    () => (lastRequestRef.current ? load(lastRequestRef.current) : refresh()),
    [load, refresh],
  );
  const nextPage = useCallback(async (): Promise<boolean> => {
    if (!nextCursor || !snapshotAt || loading) return false;
    return load({
      criteriaKey,
      platform,
      reason,
      query,
      cursor: nextCursor,
      index: pageIndex + 1,
      expectedSnapshot: snapshotAt,
    });
  }, [criteriaKey, load, loading, nextCursor, pageIndex, platform, query, reason, snapshotAt]);
  const previousPage = useCallback(async (): Promise<boolean> => {
    if (pageIndex === 0 || loading) return false;
    const prior = pageCache[pageIndex - 1];
    if (!prior || prior.criteriaKey !== criteriaKey) return refresh();
    setRows(prior.items);
    setLoadedCriteriaKey(prior.criteriaKey);
    setTotal(prior.total);
    setNextCursor(prior.nextCursor);
    setSnapshotAt(prior.snapshotAt);
    setPageIndex(pageIndex - 1);
    return load({
      criteriaKey,
      platform,
      reason,
      query,
      cursor: prior.cursor,
      index: pageIndex - 1,
      expectedSnapshot: prior.snapshotAt,
    });
  }, [criteriaKey, load, loading, pageCache, pageIndex, platform, query, reason, refresh]);
  const mutations = usePushSuppressionMutations({
    canAdmin,
    authorityCurrent,
    rows,
    refresh,
  });

  return {
    directory: {
      rows,
      visibleRows,
      total,
      nextCursor,
      snapshotAt,
      pageIndex,
      loading,
      error,
      unavailable,
      criteriaVerified,
      authorityCurrent,
      platform,
      reason,
      source,
      sourceChoices,
      queryInput,
      queryError,
    },
    ...mutations,
    setPlatform: setPlatformState,
    setReason: setReasonState,
    setSource: setSourceState,
    setQueryInput: setQueryInputState,
    refresh,
    retry,
    nextPage,
    previousPage,
    clearFilters: () => {
      setPlatformState("all");
      setReasonState("all");
      setSourceState("all");
      setQueryInputState("");
      setQuery("");
    },
  };
}
