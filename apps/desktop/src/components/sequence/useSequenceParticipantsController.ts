import { useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  isSequenceParticipantsUnavailable,
  type SequenceParticipantSort,
  type SequenceParticipantStatus,
  type SequenceParticipantsResponse,
} from "../../lib/api-client";

export const SEQUENCE_PARTICIPANTS_PAGE_SIZE = 50;

export type SequenceParticipantsView = "participants" | "stuck";
export type SequenceParticipantsStatusFilter =
  | SequenceParticipantStatus
  | "all";

interface ScopedState<T> {
  sequenceKey: string;
  value: T;
}

export function useSequenceParticipantsController(options: {
  open: boolean;
  sequenceId: string | number;
  activeRunsHint?: number;
  stuckAfterDays?: number;
}) {
  const { open, sequenceId, activeRunsHint, stuckAfterDays } = options;
  const sequenceKey = String(sequenceId);
  const [view, setView] =
    useState<SequenceParticipantsView>("participants");
  const [dataState, setDataState] = useState<
    ScopedState<SequenceParticipantsResponse> | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<
    ScopedState<{ message: string; unavailable: boolean }> | null
  >(null);
  const [statusFilter, setStatusFilter] =
    useState<SequenceParticipantsStatusFilter>("all");
  const [sort, setSort] =
    useState<SequenceParticipantSort>("entered_at_desc");
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);
  const data =
    dataState?.sequenceKey === sequenceKey ? dataState.value : null;
  const err =
    errorState?.sequenceKey === sequenceKey ? errorState.value : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const token = ++requestRef.current;
    setLoading(true);
    setErrorState(null);
    void (async () => {
      const response = await api.listSequenceParticipants(sequenceId, {
        status: statusFilter,
        sort,
        page,
        perPage: SEQUENCE_PARTICIPANTS_PAGE_SIZE,
      });
      if (!mountedRef.current || token !== requestRef.current) return;
      if (response.error) {
        setErrorState({
          sequenceKey,
          value: {
            message: response.error.message,
            unavailable: isSequenceParticipantsUnavailable(response.error),
          },
        });
        setDataState(null);
      } else {
        setDataState({ sequenceKey, value: response.data });
      }
      setLoading(false);
    })();
    return () => {
      if (requestRef.current === token) requestRef.current += 1;
    };
  }, [open, sequenceId, sequenceKey, statusFilter, sort, page, reloadTick]);

  const participants = data?.items ?? [];
  const total = data?.total ?? activeRunsHint ?? 0;
  const totalPages = Math.max(
    1,
    Math.ceil(total / SEQUENCE_PARTICIPANTS_PAGE_SIZE),
  );
  const subtitle = useMemo(() => {
    if (view === "stuck") {
      return (stuckAfterDays ?? 0) >= 1
        ? `Stuck report · idle ${stuckAfterDays} day${stuckAfterDays === 1 ? "" : "s"} or more`
        : "Stuck report · no threshold configured";
    }
    if (loading && !data) return "Loading…";
    if (err?.unavailable) return "Not available on this server";
    if (err) return "Couldn't load participants";
    if (total === 0) return "No one currently enrolled";
    return `${total.toLocaleString()} subscriber${total === 1 ? "" : "s"}`;
  }, [view, stuckAfterDays, loading, data, err, total]);

  const changeStatusFilter = (
    next: SequenceParticipantsStatusFilter,
  ): void => {
    if (next === statusFilter) return;
    setStatusFilter(next);
    setPage(1);
  };
  const changeSort = (next: SequenceParticipantSort): void => {
    if (next === sort) return;
    setSort(next);
    setPage(1);
  };

  return {
    view,
    setView,
    data,
    loading,
    err,
    statusFilter,
    changeStatusFilter,
    sort,
    changeSort,
    page,
    participants,
    total,
    totalPages,
    subtitle,
    retry: () => setReloadTick((tick) => tick + 1),
    previousPage: () => setPage((current) => Math.max(1, current - 1)),
    nextPage: () =>
      setPage((current) => Math.min(totalPages, current + 1)),
  };
}

export type SequenceParticipantsController = ReturnType<
  typeof useSequenceParticipantsController
>;
