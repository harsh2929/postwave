import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AuditRow } from "../../lib/api-client";
import { useAuditScopes } from "../../lib/auditScopes";
import { useAuditData } from "./useAuditData";
import { useAuditFilterState } from "./useAuditFilterState";

interface SelectedAuditSnapshot {
  fingerprint: string;
  row: AuditRow;
}

export function useAuditPageController() {
  const scopes = useAuditScopes();
  const filters = useAuditFilterState();
  const [selectedSnapshot, setSelectedSnapshot] =
    useState<SelectedAuditSnapshot | null>(null);
  const eventReturnFocusRef = useRef<HTMLElement | null>(null);
  const filterFocusRef = useRef<HTMLHeadingElement | null>(null);
  const filterFocusTimerRef = useRef<number | null>(null);

  const data = useAuditData({
    filterArgs: filters.filterArgs,
    filterReqIdRef: filters.filterReqIdRef,
    rollingDays: filters.days,
  });

  // A drawer belongs to the exact query snapshot that opened it. Filter
  // transitions and refreshes that remove the event close it synchronously;
  // stale evidence is never relabelled as part of the new result window.
  const selected = useMemo(() => {
    if (
      !selectedSnapshot ||
      selectedSnapshot.fingerprint !== data.queryFingerprint ||
      !data.rows?.some(
        (row) => String(row.id) === String(selectedSnapshot.row.id),
      )
    ) {
      return null;
    }
    return (
      data.rows.find(
        (row) => String(row.id) === String(selectedSnapshot.row.id),
      ) ?? null
    );
  }, [data.queryFingerprint, data.rows, selectedSnapshot]);
  const setSelected = useCallback(
    (row: AuditRow | null, opener?: HTMLElement | null): void => {
      if (row && opener) eventReturnFocusRef.current = opener;
      setSelectedSnapshot(
        row ? { fingerprint: data.queryFingerprint, row } : null,
      );
    },
    [data.queryFingerprint],
  );

  const prepareFilterPivotFocus = useCallback((): void => {
    const target = filterFocusRef.current;
    // A drawer filter removes the row opener from the next query. Replace the
    // shell's return target before it closes; the timer also covers inline row
    // filters, which do not pass through the shell at all.
    eventReturnFocusRef.current = target;
    if (filterFocusTimerRef.current !== null) {
      window.clearTimeout(filterFocusTimerRef.current);
    }
    filterFocusTimerRef.current = window.setTimeout(() => {
      filterFocusTimerRef.current = null;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }, 0);
  }, []);

  useEffect(
    () => () => {
      if (filterFocusTimerRef.current !== null) {
        window.clearTimeout(filterFocusTimerRef.current);
      }
    },
    [],
  );

  const filterToActor = useCallback(
    (label: string): void => {
      prepareFilterPivotFocus();
      filters.setActorFromRow(label);
    },
    [filters, prepareFilterPivotFocus],
  );
  const filterToResource = useCallback(
    (resourceId: string): void => {
      prepareFilterPivotFocus();
      filters.setResourceId(resourceId);
    },
    [filters, prepareFilterPivotFocus],
  );

  const blocked = !scopes.loading && !scopes.hasScope("audit:read");
  const canManageSavedViews =
    scopes.isAdmin && scopes.hasScope("audit:execute_actions");
  const visibleToLabel = scopes.isAdmin
    ? "owners, admins"
    : scopes.scopes.has("audit:read_all_tenants")
      ? "audit operators (cross-tenant)"
      : scopes.scopes.has("audit:read")
        ? "audit viewers"
        : "you (degraded — couldn't load scopes)";

  const retryAccess = (): void => {
    void scopes.refresh();
    void data.load();
  };

  return {
    scopes,
    filters,
    data,
    selected,
    setSelected,
    eventReturnFocusRef,
    filterFocusRef,
    filterToActor,
    filterToResource,
    blocked,
    canManageSavedViews,
    visibleToLabel,
    retryAccess,
  };
}

export type AuditPageController = ReturnType<typeof useAuditPageController>;
