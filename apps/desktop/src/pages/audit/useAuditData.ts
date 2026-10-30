import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DayRange } from "../../components/audit/AuditFilters";
import {
  type AuditRow,
  type AuditStatsResponse,
  api,
} from "../../lib/api-client";
import { serializeAuditQuery } from "../../lib/api/audit-operations";
import type { AuditFilterArgs } from "./audit-page-types";
import {
  formatAuditRefreshAge,
  pickAuditRows,
  sinceISO,
} from "./audit-page-utils";

interface UseAuditDataOptions {
  filterArgs: AuditFilterArgs;
  filterReqIdRef: RefObject<number>;
  rollingDays?: DayRange;
}

type AuditResourcePhase =
  | "initial-loading"
  | "ready"
  | "refreshing"
  | "stale-error"
  | "hard-error";

function requestFailureMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.name !== "AbortError"
    ? reason.message
    : fallback;
}

export function useAuditData({
  filterArgs,
  filterReqIdRef,
  rollingDays,
}: UseAuditDataOptions) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  const utcDayKey = new Date(nowTick).toISOString().slice(0, 10);
  const effectiveFilterArgs = useMemo<AuditFilterArgs>(() => {
    if (rollingDays === undefined) return filterArgs;
    const utcDayStart = Date.parse(`${utcDayKey}T00:00:00.000Z`);
    return {
      ...filterArgs,
      since: sinceISO(rollingDays, utcDayStart),
    };
  }, [filterArgs, rollingDays, utcDayKey]);
  const queryFingerprint = useMemo(
    () => serializeAuditQuery(effectiveFilterArgs),
    [effectiveFilterArgs],
  );
  const queryFingerprintRef = useRef(queryFingerprint);
  queryFingerprintRef.current = queryFingerprint;

  const [rowsState, setRowsState] = useState<AuditRow[] | null>(null);
  const rowsRef = useRef<AuditRow[] | null>(null);
  const setRows = useCallback<Dispatch<SetStateAction<AuditRow[] | null>>>(
    (update) => {
      setRowsState((previous) => {
        const next = typeof update === "function" ? update(previous) : update;
        rowsRef.current = next;
        return next;
      });
    },
    [],
  );

  const [nextCursor, setNextCursor] = useState<string>();
  const [stats, setStats] = useState<AuditStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [totalConfidence, setTotalConfidence] = useState<
    "exact" | "approximate"
  >("exact");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [resourceFingerprint, setResourceFingerprint] =
    useState(queryFingerprint);

  const committedFingerprintRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const paginationGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const paginationBusyRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // Never present rows from query A as if they belonged to query B during the
  // debounce window. Same-query refreshes preserve their last good snapshot.
  useEffect(() => {
    const committed = committedFingerprintRef.current;
    if (committed === null || committed === queryFingerprint) return;
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    paginationGenerationRef.current += 1;
    paginationAbortRef.current?.abort();
    paginationBusyRef.current = false;
    setResourceFingerprint(queryFingerprint);
    setRows(null);
    setNextCursor(undefined);
    setStats(null);
    setTotalCount(null);
    setError(null);
    setStatsError(null);
    setPaginationError(null);
    setStale(false);
    setLoading(true);
    setRefreshing(false);
    setLoadingStats(true);
    setLastRefreshedAt(null);
    committedFingerprintRef.current = null;
  }, [queryFingerprint, setRows]);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    // A full snapshot supersedes every cursor page derived from the previous
    // snapshot, even when the filter fingerprint is unchanged.
    paginationGenerationRef.current += 1;
    paginationAbortRef.current?.abort();
    paginationBusyRef.current = false;
    setLoadingMore(false);
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const hasSameQuerySnapshot =
      committedFingerprintRef.current === queryFingerprint &&
      rowsRef.current !== null;

    setResourceFingerprint(queryFingerprint);
    setLoading(!hasSameQuerySnapshot);
    setRefreshing(hasSameQuerySnapshot);
    setLoadingStats(true);
    setError(null);
    setStatsError(null);
    setPaginationError(null);
    setStale(false);
    // Companion reads are not an atomic snapshot with the event page. Clear
    // them on every refresh, then publish only after this generation's list
    // has committed so old totals can never be labelled as current evidence.
    setStats(null);
    setTotalCount(null);
    setTotalConfidence("exact");
    if (!hasSameQuerySnapshot) {
      setRows(null);
      setNextCursor(undefined);
    }

    let listCommitted = false;
    let pendingStats: AuditStatsResponse | null | undefined;
    let pendingStatsError: string | null | undefined;
    let pendingCount:
      | { totalEstimate: number; confidence: "exact" | "approximate" }
      | null
      | undefined;

    const listPromise = Promise.resolve().then(() =>
      api.listAudit(effectiveFilterArgs, { signal: controller.signal }),
    );
    const statsPromise = Promise.resolve().then(() =>
      api.getAuditStats(effectiveFilterArgs, { signal: controller.signal }),
    );
    const countPromise = Promise.resolve().then(() =>
      api.getAuditCount(effectiveFilterArgs, { signal: controller.signal }),
    );

    // Attach optional-resource handlers immediately. If statistics or count
    // reject while the list is still pending, the rejection is contained and
    // cannot become an unhandled promise.
    void statsPromise
      .then((statsResponse) => {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          queryFingerprintRef.current !== queryFingerprint
        ) {
          return;
        }
        if (statsResponse.error) {
          pendingStats = null;
          pendingStatsError = statsResponse.error.message;
          if (listCommitted) {
            setStats(null);
            setStatsError(pendingStatsError);
          }
          return;
        }
        pendingStats = statsResponse.data;
        pendingStatsError = null;
        if (listCommitted) {
          setStats(pendingStats);
          setStatsError(null);
        }
      })
      .catch((reason: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          queryFingerprintRef.current !== queryFingerprint
        ) {
          return;
        }
        pendingStats = null;
        pendingStatsError = requestFailureMessage(
          reason,
          "Audit statistics could not be loaded.",
        );
        if (listCommitted) {
          setStats(null);
          setStatsError(pendingStatsError);
        }
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          generation === loadGenerationRef.current &&
          queryFingerprintRef.current === queryFingerprint
        ) {
          setLoadingStats(false);
        }
      });

    void countPromise
      .then((countResponse) => {
        if (
          controller.signal.aborted ||
          generation !== loadGenerationRef.current ||
          queryFingerprintRef.current !== queryFingerprint
        ) {
          return;
        }
        if (countResponse.error) {
          pendingCount = null;
          if (listCommitted) setTotalCount(null);
          return;
        }
        pendingCount = countResponse.data;
        if (listCommitted) {
          setTotalCount(pendingCount.totalEstimate);
          setTotalConfidence(pendingCount.confidence);
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          generation === loadGenerationRef.current &&
          queryFingerprintRef.current === queryFingerprint
        ) {
          pendingCount = null;
          setTotalCount(null);
        }
      });

    try {
      const listResponse = await listPromise;
      if (
        controller.signal.aborted ||
        generation !== loadGenerationRef.current ||
        queryFingerprintRef.current !== queryFingerprint
      ) {
        return;
      }
      if (listResponse.error) {
        setError(listResponse.error.message);
        setStale(hasSameQuerySnapshot);
        if (!hasSameQuerySnapshot) {
          setRows(null);
          setNextCursor(undefined);
          committedFingerprintRef.current = null;
        }
      } else {
        const page = pickAuditRows(listResponse.data);
        listCommitted = true;
        committedFingerprintRef.current = queryFingerprint;
        setRows(page.rows);
        setNextCursor(page.nextCursor);
        setError(null);
        setStale(false);
        setLastRefreshedAt(Date.now());
        if (pendingStats !== undefined) {
          setStats(pendingStats);
          setStatsError(pendingStatsError ?? null);
        }
        if (pendingCount !== undefined) {
          if (pendingCount) {
            setTotalCount(pendingCount.totalEstimate);
            setTotalConfidence(pendingCount.confidence);
          } else {
            setTotalCount(null);
          }
        }
      }
    } catch (reason) {
      if (
        controller.signal.aborted ||
        generation !== loadGenerationRef.current ||
        queryFingerprintRef.current !== queryFingerprint
      ) {
        return;
      }
      setError(
        requestFailureMessage(reason, "Audit evidence could not be loaded."),
      );
      setStale(hasSameQuerySnapshot);
      if (!hasSameQuerySnapshot) {
        setRows(null);
        setNextCursor(undefined);
        committedFingerprintRef.current = null;
      }
    } finally {
      if (
        !controller.signal.aborted &&
        generation === loadGenerationRef.current &&
        queryFingerprintRef.current === queryFingerprint
      ) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [effectiveFilterArgs, queryFingerprint, setRows]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 220);
    return () => {
      window.clearTimeout(timer);
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      paginationGenerationRef.current += 1;
      paginationAbortRef.current?.abort();
      paginationBusyRef.current = false;
      setLoadingMore(false);
    };
  }, [load]);

  useEffect(
    () => () => {
      loadGenerationRef.current += 1;
      paginationGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      paginationAbortRef.current?.abort();
    },
    [],
  );

  const resourceIsCurrent = resourceFingerprint === queryFingerprint;
  const rows = resourceIsCurrent ? rowsState : null;
  const visibleRows = rows;

  const onLoadMore = useCallback(async (): Promise<void> => {
    if (!nextCursor || paginationBusyRef.current) return;
    paginationBusyRef.current = true;
    setLoadingMore(true);
    setPaginationError(null);
    const generation = ++paginationGenerationRef.current;
    paginationAbortRef.current?.abort();
    const controller = new AbortController();
    paginationAbortRef.current = controller;
    const requestId = filterReqIdRef.current;
    const requestFingerprint = queryFingerprint;
    try {
      const response = await api.listAudit(
        { ...effectiveFilterArgs, cursor: nextCursor },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        generation !== paginationGenerationRef.current ||
        requestId !== filterReqIdRef.current ||
        requestFingerprint !== queryFingerprintRef.current
      ) {
        return;
      }
      if (response.error) {
        setPaginationError(response.error.message);
        return;
      }
      const page = pickAuditRows(response.data);
      setRows((previous) => {
        const existing = new Set((previous ?? []).map((row) => String(row.id)));
        return [
          ...(previous ?? []),
          ...page.rows.filter((row) => !existing.has(String(row.id))),
        ];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setPaginationError(
          requestFailureMessage(
            reason,
            "More audit events could not be loaded.",
          ),
        );
      }
    } finally {
      if (generation === paginationGenerationRef.current) {
        paginationBusyRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [
    effectiveFilterArgs,
    filterReqIdRef,
    nextCursor,
    queryFingerprint,
    setRows,
  ]);

  const publicLoading = loading || !resourceIsCurrent;
  const publicRefreshing = resourceIsCurrent && refreshing;
  const publicError = resourceIsCurrent ? error : null;
  const publicStats = resourceIsCurrent ? stats : null;
  const publicStatsError = resourceIsCurrent ? statsError : null;
  const publicTotalCount = resourceIsCurrent ? totalCount : null;
  const publicLastRefreshedAt = resourceIsCurrent ? lastRefreshedAt : null;
  const phase: AuditResourcePhase = publicLoading
    ? "initial-loading"
    : publicRefreshing
      ? "refreshing"
      : publicError && rows !== null
        ? "stale-error"
        : publicError
          ? "hard-error"
          : "ready";
  const refreshAgeLabel = publicLastRefreshedAt
    ? formatAuditRefreshAge(nowTick - publicLastRefreshedAt)
    : "not yet";

  return {
    rows,
    nextCursor,
    stats: publicStats,
    loading: publicLoading,
    refreshing: publicRefreshing,
    loadingStats,
    loadingMore,
    error: publicError,
    statsError: publicStatsError,
    paginationError,
    stale: resourceIsCurrent && stale,
    phase,
    queryFingerprint,
    totalCount: publicTotalCount,
    totalConfidence,
    visibleRows,
    refreshAgeLabel,
    lastRefreshedAt: publicLastRefreshedAt,
    load,
    onLoadMore,
  };
}

export type AuditDataState = ReturnType<typeof useAuditData>;
