import { useEffect, useMemo, useRef, useState } from "react";

import { SUBSCRIBER_SORTABLE_COLUMNS } from "../../components/subscribers/SubscribersBrowsePanel";
import {
  coerceUiStatus,
  uiStatusToEngine,
} from "../../components/subscribers/subscriber-status";
import { toast } from "../../components/Toast";
import {
  type SavedSegment,
  deleteSavedSegment,
  patchSavedSegment,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  isServerSort,
} from "../subscribers-paging";
import { visibleSubscriberColumns } from "../subscribers-view-columns";
import { savedSegmentSnapshot } from "./subscribers-page-utils";
import { useRestoreActiveSubscriberSavedSegment } from "./useRestoreActiveSubscriberSavedSegment";
import { useSaveCurrentSubscriberSegment } from "./useSaveCurrentSubscriberSegment";
import { useSavedSegmentsLibrary } from "./useSavedSegmentsLibrary";
import type { SubscribersPageState } from "./useSubscribersPageState";
import type { SubscribersViewPreferences } from "./useSubscribersViewPreferences";

export function useSubscribersSavedSegments(
  state: SubscribersPageState,
  view: SubscribersViewPreferences,
  identityScope: string | null,
) {
  const mountedRef = useRef(true);
  const identityRef = useRef(identityScope);
  const applyGenerationRef = useRef(0);
  const deletePromiseRef = useRef<Promise<void> | null>(null);
  identityRef.current = identityScope;
  const library = useSavedSegmentsLibrary(identityScope);
  const [pendingDelete, setPendingDelete] = useState<SavedSegment | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const predicate = useMemo(
    () => ({
      filters: {
        status:
          state.filter === "all" ? "" : (uiStatusToEngine(state.filter) ?? ""),
        q: state.debouncedQuery,
      },
      snapshot: {
        version: 3,
        resource_scope: "subscriber_directory",
        workspace_scope: "current",
        applied_query: state.debouncedQuery,
        status: state.filter,
        include_archived: state.showArchived,
        sort: { column: state.sortColumn, order: state.sortOrder },
        columns: [...view.visibleColumnKeys],
        reset: { page: 1, selection: "clear" },
      },
    }),
    [
      state.debouncedQuery,
      state.filter,
      state.showArchived,
      state.sortColumn,
      state.sortOrder,
      view.visibleColumnKeys,
    ],
  );
  const saveCurrent = useSaveCurrentSubscriberSegment({
    identityScope,
    segments: library.segments,
    total: library.total,
    maximum: library.maximum,
    scopePending: state.query.trim() !== state.debouncedQuery.trim(),
    predicate,
    closeMenu: () => library.setMenuOpen(false),
    onSaved: () => library.load({ supersede: true }),
  });
  useRestoreActiveSubscriberSavedSegment(state, view, library, identityScope);

  useEffect(() => {
    applyGenerationRef.current += 1;
    setPendingDelete(null);
  }, [identityScope]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      applyGenerationRef.current += 1;
    };
  }, []);

  const apply = async (segment: SavedSegment): Promise<boolean> => {
    const ownerIdentity = identityRef.current;
    const generation = ++applyGenerationRef.current;
    const snapshot = savedSegmentSnapshot(segment.predicate_json);
    if (!snapshot) {
      toast.error(
        `"${segment.name}" does not contain a supported subscriber-directory snapshot. Recreate it from the current Directory view.`,
      );
      return false;
    }
    const status =
      snapshot.status === undefined || snapshot.status === "all"
        ? "all"
        : coerceUiStatus(snapshot.status);
    if (
      status == null ||
      snapshot.query === undefined ||
      ((snapshot.version ?? 0) >= 3 && !snapshot.authoritative)
    ) {
      toast.error(
        `"${segment.name}" does not contain a complete, supported subscriber-directory snapshot. Recreate it from the current Directory view.`,
      );
      return false;
    }
    const savedSort = snapshot.sortColumn;
    const supportedSort =
      savedSort !== undefined &&
      (isServerSort(savedSort) ||
        Object.hasOwn(SUBSCRIBER_SORTABLE_COLUMNS, savedSort));
    const routeResult = await state.requestViewChange((current) => ({
      ...current,
      filter: status,
      query: snapshot.query ?? "",
      showArchived: snapshot.showArchived ?? false,
      sortColumn: supportedSort ? savedSort : DEFAULT_SORT,
      sortOrder: supportedSort
        ? (snapshot.sortOrder ?? DEFAULT_ORDER)
        : DEFAULT_ORDER,
      page: 1,
      savedSegmentId:
        (snapshot.version ?? 0) >= 3 && snapshot.authoritative
          ? segment.id
          : null,
    }));
    if (
      routeResult !== "proceeded" ||
      !mountedRef.current ||
      generation !== applyGenerationRef.current ||
      ownerIdentity !== identityRef.current
    ) {
      return false;
    }
    library.setMenuOpen(false);
    if ((snapshot.version ?? 0) >= 2 && snapshot.columns) {
      view.updateVisibleColumns(
        visibleSubscriberColumns({ columns: snapshot.columns }),
      );
    }
    state.setSelected(null);
    state.setFocusId(null);
    state.setFocusedRowIndex(-1);

    try {
      const response = await patchSavedSegment(segment.id, { touch: true });
      if (
        !mountedRef.current ||
        generation !== applyGenerationRef.current ||
        ownerIdentity !== identityRef.current
      ) {
        return true;
      }
      if (response.error) {
        toast.error(
          `Loaded segment "${segment.name}", but couldn't update its recent-sort order: ${remoteFailureFromError(response.error).message}`,
        );
        return true;
      }
      await library.load();
      if (
        mountedRef.current &&
        generation === applyGenerationRef.current &&
        ownerIdentity === identityRef.current
      ) {
        toast.success(`Loaded segment "${segment.name}"`);
      }
      return true;
    } catch {
      if (
        mountedRef.current &&
        generation === applyGenerationRef.current &&
        ownerIdentity === identityRef.current
      ) {
        toast.error(
          `Loaded segment "${segment.name}", but couldn't update its recent-sort order.`,
        );
      }
      return true;
    }
  };

  const remove = async (): Promise<void> => {
    const target = pendingDelete;
    if (!target || deletePromiseRef.current) return;
    const ownerIdentity = identityRef.current;
    const operation = (async (): Promise<void> => {
      setDeleteBusy(true);
      try {
        const response = await deleteSavedSegment(target.id);
        if (!mountedRef.current || ownerIdentity !== identityRef.current)
          return;
        if (response.error) {
          toast.error(
            `Couldn't delete: ${remoteFailureFromError(response.error).message}`,
          );
          return;
        }
        setPendingDelete(null);
        if (state.activeSavedSegmentId === target.id) {
          state.setActiveSavedSegmentId(null);
        }
        library.setSegments((current) =>
          current.filter(({ id }) => id !== target.id),
        );
        library.setTotal((current) => Math.max(0, current - 1));
        await library.load({ supersede: true });
      } catch {
        if (mountedRef.current && ownerIdentity === identityRef.current) {
          toast.error("Couldn't delete the saved segment. Try again.");
        }
      } finally {
        // Busy owns the one process-wide delete promise, not its originating
        // workspace's result. Always release it after settlement so a mounted
        // controller cannot remain permanently disabled after an identity
        // transition.
        if (mountedRef.current) {
          setDeleteBusy(false);
        }
      }
    })();
    deletePromiseRef.current = operation;
    await operation.finally(() => {
      if (deletePromiseRef.current === operation)
        deletePromiseRef.current = null;
    });
  };

  return {
    savedSegments: library.segments,
    activeSavedSegmentId: state.activeSavedSegmentId,
    savedSegmentsTotal: library.total,
    savedSegmentsMax: library.maximum,
    savedSegmentsLoading: library.loading,
    savedSegmentsError: library.error,
    savedDropdownOpen: library.menuOpen,
    setSavedDropdownOpen: library.setMenuOpen,
    savedPreviews: library.previews,
    requestSavedPreview: library.requestPreview,
    invalidatePreviewCounts: library.invalidatePreviewCounts,
    saveCurrentOpen: saveCurrent.open,
    setSaveCurrentOpen: saveCurrent.setOpen,
    saveCurrentName: saveCurrent.name,
    saveCurrentNameLength: saveCurrent.nameLength,
    setSaveCurrentName: saveCurrent.setName,
    saveCurrentScope: saveCurrent.scope,
    setSaveCurrentScope: saveCurrent.setScope,
    saveCurrentNameError: saveCurrent.nameError,
    saveCurrentServerError: saveCurrent.serverError,
    saveCurrentAtLimit: saveCurrent.atLimit,
    saveCurrentBusy: saveCurrent.busy,
    saveCurrentScopePending: saveCurrent.scopePending,
    saveCurrentDiscardConfirmOpen: saveCurrent.discardConfirmOpen,
    setSaveCurrentDiscardConfirmOpen: saveCurrent.setDiscardConfirmOpen,
    discardAndCloseSaveCurrent: saveCurrent.discard,
    pendingSegmentDelete: pendingDelete,
    setPendingSegmentDelete: setPendingDelete,
    segmentDeleteBusy: deleteBusy,
    loadSavedSegments: library.load,
    applySavedSegment: apply,
    submitSaveCurrent: saveCurrent.submit,
    confirmRemoveSaved: remove,
    openSaveCurrent: saveCurrent.show,
  };
}

export type SubscribersSavedSegments = ReturnType<
  typeof useSubscribersSavedSegments
>;
