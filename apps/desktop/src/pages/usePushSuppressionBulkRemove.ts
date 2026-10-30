import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { toast } from "../components/Toast";
import { pushSuppressionsApi } from "../lib/api-client";
import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import { isConflictError, rowCanBeRemoved } from "./push-suppression-model";

export interface PushSuppressionBulkRemoveState {
  selectedIds: ReadonlySet<string>;
  selectedRows: PushSuppressionRow[];
  reviewedRows: PushSuppressionRow[];
  open: boolean;
  busy: boolean;
  error: string | null;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export interface PushSuppressionBulkRemoveController {
  state: PushSuppressionBulkRemoveState;
  toggle: (row: PushSuppressionRow) => void;
  toggleAll: () => void;
  clear: () => void;
  request: (trigger?: HTMLButtonElement | null) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

function exactReviewedRows(
  rows: readonly PushSuppressionRow[],
  selectedIds: ReadonlySet<string>,
): PushSuppressionRow[] {
  return rows.filter((row) => selectedIds.has(row.id) && rowCanBeRemoved(row));
}

export function usePushSuppressionBulkRemove({
  canAdmin,
  authorityCurrent,
  rows,
  refresh,
}: {
  canAdmin: boolean;
  authorityCurrent: boolean;
  rows: readonly PushSuppressionRow[];
  refresh: () => Promise<boolean>;
}): PushSuppressionBulkRemoveController {
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reviewedRows, setReviewedRows] = useState<PushSuppressionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRows = useMemo(
    () => exactReviewedRows(rows, selectedIds),
    [rows, selectedIds],
  );

  useEffect(() => {
    setSelectedIds(new Set());
    if (!submittingRef.current) {
      setReviewedRows([]);
      setError(null);
    }
  }, [rows]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const toggle = useCallback(
    (row: PushSuppressionRow): void => {
      if (!authorityCurrent || !rowCanBeRemoved(row)) return;
      const current = rows.find((candidate) => candidate.id === row.id);
      if (!current || current.version !== row.version) return;
      setSelectedIds((selected) => {
        const next = new Set(selected);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    },
    [authorityCurrent, rows],
  );

  const clear = useCallback((): void => {
    if (submittingRef.current) return;
    setSelectedIds(new Set());
  }, []);

  const toggleAll = useCallback((): void => {
    if (!authorityCurrent) return;
    const eligible = rows.filter(rowCanBeRemoved);
    setSelectedIds((selected) => {
      const allSelected =
        eligible.length > 0 && eligible.every((row) => selected.has(row.id));
      return allSelected ? new Set() : new Set(eligible.map((row) => row.id));
    });
  }, [authorityCurrent, rows]);

  const request = useCallback(
    (trigger?: HTMLButtonElement | null): void => {
      if (!authorityCurrent) return;
      const exact = exactReviewedRows(rows, selectedIds);
      if (exact.length === 0 || exact.length !== selectedIds.size) return;
      returnFocusRef.current = trigger ?? null;
      setReviewedRows(exact);
      setError(null);
    },
    [authorityCurrent, rows, selectedIds],
  );

  const close = useCallback((): void => {
    if (submittingRef.current) return;
    setReviewedRows([]);
    setError(null);
  }, []);

  const confirm = useCallback(async (): Promise<void> => {
    if (
      !canAdmin ||
      !authorityCurrent ||
      reviewedRows.length === 0 ||
      submittingRef.current
    ) {
      return;
    }
    const currentRows = reviewedRows.map((reviewed) =>
      rows.find(
        (row) =>
          row.id === reviewed.id &&
          row.version === reviewed.version &&
          rowCanBeRemoved(row),
      ),
    );
    if (currentRows.some((row) => !row)) {
      setError(
        "One or more rows changed after review. Close and refresh before selecting them again.",
      );
      return;
    }
    const exactRows = currentRows as PushSuppressionRow[];
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await pushSuppressionsApi.bulkRemove(
        exactRows.map((row) => ({
          id: row.id,
          expected_version: row.version,
        })),
        { signal: controller.signal },
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      if ("error" in result && result.error) {
        if (isConflictError(result.error)) {
          setReviewedRows([]);
          setSelectedIds(new Set());
          toast.info(
            "At least one row changed before bulk removal. The registry is being refreshed.",
          );
          await refresh();
        } else {
          setError(
            "The registry did not confirm whether bulk removal completed. Close and refresh before selecting rows again.",
          );
        }
        return;
      }
      setReviewedRows([]);
      setSelectedIds(new Set());
      toast.success(
        result.data.stillSuppressed > 0
          ? `${result.data.removed.toLocaleString()} manual authorities removed; ${result.data.stillSuppressed.toLocaleString()} tokens remain suppressed by another authority.`
          : `${result.data.removed.toLocaleString()} manual push suppression authorities removed.`,
      );
      await refresh();
    } catch {
      if (mountedRef.current && !controller.signal.aborted) {
        setError(
          "The registry did not confirm whether bulk removal completed. Close and refresh before selecting rows again.",
        );
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [authorityCurrent, canAdmin, refresh, reviewedRows, rows]);

  return {
    state: {
      selectedIds,
      selectedRows,
      reviewedRows,
      open: reviewedRows.length > 0,
      busy,
      error,
      returnFocusRef,
    },
    toggle,
    toggleAll,
    clear,
    request,
    close,
    confirm,
  };
}
