import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type AuditRow, api } from "../../lib/api-client";
import type { AuditFilterArgs } from "./audit-page-types";
import {
  auditRowMatchesFilters,
  decodeAuditSsePayload,
  mergeUniqueAuditRows,
} from "./audit-page-utils";

interface UseAuditLiveTailOptions {
  liveTail: boolean;
  filterArgs: AuditFilterArgs;
  rows: AuditRow[] | null;
  setRows: Dispatch<SetStateAction<AuditRow[] | null>>;
  setLiveTailCount: Dispatch<SetStateAction<number>>;
}

export type AuditLiveConnectionState =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed";

const MAX_LIVE_BUFFER_ROWS = 200;
const MAX_LIVE_RENDERED_ROWS = 1_000;

function capLiveRows(rows: AuditRow[]): {
  rows: AuditRow[];
  dropped: number;
} {
  if (rows.length <= MAX_LIVE_RENDERED_ROWS) return { rows, dropped: 0 };
  return {
    rows: rows.slice(0, MAX_LIVE_RENDERED_ROWS),
    dropped: rows.length - MAX_LIVE_RENDERED_ROWS,
  };
}

export function useAuditLiveTail({
  liveTail,
  filterArgs,
  rows,
  setRows,
  setLiveTailCount,
}: UseAuditLiveTailOptions) {
  const [bufferedRows, setBufferedRows] = useState<AuditRow[]>([]);
  const [isScrolled, setIsScrolled] = useState(false);
  const [connectionState, setConnectionState] =
    useState<AuditLiveConnectionState>("off");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [invalidFrameCount, setInvalidFrameCount] = useState(0);
  const [droppedRowCount, setDroppedRowCount] = useState(0);
  const isScrolledRef = useRef(false);
  const listScrollRef = useRef<HTMLDivElement | null>(null);

  const mergeIntoRows = useCallback(
    (incoming: AuditRow[]): void => {
      if (incoming.length === 0) return;
      setRows((previous) => {
        const merged = mergeUniqueAuditRows(incoming, previous);
        const capped = capLiveRows(merged.rows);
        if (capped.dropped > 0) {
          setDroppedRowCount((count) => count + capped.dropped);
        }
        if (merged.added > 0) {
          setLiveTailCount((count) => count + merged.added);
        }
        return capped.rows;
      });
    },
    [setLiveTailCount, setRows],
  );

  useEffect(() => {
    if (!liveTail) {
      setConnectionState("off");
      setConnectionError(null);
      setBufferedRows([]);
      setInvalidFrameCount(0);
      setDroppedRowCount(0);
      return;
    }

    let eventSource: EventSource | null = null;
    let cancelled = false;
    setConnectionState("connecting");
    setConnectionError(null);
    setBufferedRows([]);
    setInvalidFrameCount(0);
    setDroppedRowCount(0);

    void (async () => {
      try {
        const url = await api.auditStreamUrlAuthed(filterArgs);
        if (cancelled) return;
        if (!url || typeof EventSource === "undefined") {
          throw new Error(
            "Live audit streaming is unavailable in this runtime.",
          );
        }
        eventSource = new EventSource(url, { withCredentials: true });
        eventSource.onopen = () => {
          if (cancelled) return;
          setConnectionState("live");
          setConnectionError(null);
        };
        eventSource.onerror = () => {
          if (cancelled) return;
          const closed = eventSource?.readyState === EventSource.CLOSED;
          setConnectionState(closed ? "failed" : "reconnecting");
          setConnectionError(
            closed
              ? "The live connection closed. Turn Live off and on to retry."
              : "Live events are reconnecting; the loaded snapshot remains available.",
          );
        };
        eventSource.addEventListener("audit", (event: MessageEvent) => {
          if (cancelled) return;
          const row = decodeAuditSsePayload(event.data);
          if (!row) {
            setInvalidFrameCount((count) => count + 1);
            return;
          }
          if (!auditRowMatchesFilters(row, filterArgs)) return;
          if (isScrolledRef.current) {
            setBufferedRows((previous) => {
              if (previous.some((item) => String(item.id) === String(row.id))) {
                return previous;
              }
              const next = [row, ...previous];
              if (next.length <= MAX_LIVE_BUFFER_ROWS) return next;
              setDroppedRowCount(
                (count) => count + next.length - MAX_LIVE_BUFFER_ROWS,
              );
              return next.slice(0, MAX_LIVE_BUFFER_ROWS);
            });
            return;
          }
          mergeIntoRows([row]);
        });
      } catch (reason) {
        if (cancelled) return;
        setConnectionState("failed");
        setConnectionError(
          reason instanceof Error
            ? reason.message
            : "The live audit connection could not be opened.",
        );
      }
    })();
    return () => {
      cancelled = true;
      eventSource?.close();
      setBufferedRows([]);
    };
  }, [filterArgs, liveTail, mergeIntoRows]);

  useEffect(() => {
    const element = listScrollRef.current;
    if (!element) return;
    isScrolledRef.current = (element.scrollTop ?? 0) > 0;
    setIsScrolled(isScrolledRef.current);
    const onScroll = (): void => {
      const scrolled = (element.scrollTop ?? 0) > 0;
      isScrolledRef.current = scrolled;
      setIsScrolled(scrolled);
      if (!scrolled) {
        setBufferedRows((buffer) => {
          mergeIntoRows(buffer);
          return [];
        });
      }
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [mergeIntoRows, rows]);

  useEffect(() => {
    if (!liveTail) return;
    setLiveTailCount(0);
  }, [filterArgs, liveTail, setLiveTailCount]);

  const flushBufferedRows = useCallback((): void => {
    setBufferedRows((buffer) => {
      mergeIntoRows(buffer);
      const reduceMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      listScrollRef.current?.scrollTo({
        top: 0,
        behavior: reduceMotion ? "auto" : "smooth",
      });
      return [];
    });
  }, [mergeIntoRows]);

  return {
    bufferedRows,
    isScrolled,
    listScrollRef,
    flushBufferedRows,
    connectionState,
    connectionError,
    invalidFrameCount,
    droppedRowCount,
  };
}

export type AuditLiveTailState = ReturnType<typeof useAuditLiveTail>;
