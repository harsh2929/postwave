import { useEffect, useRef } from "react";

import { SUBSCRIBER_SORTABLE_COLUMNS } from "../../components/subscribers/SubscribersBrowsePanel";
import { coerceUiStatus } from "../../components/subscribers/subscriber-status";
import {
  DEFAULT_ORDER,
  DEFAULT_SORT,
  isServerSort,
} from "../subscribers-paging";
import { visibleSubscriberColumns } from "../subscribers-view-columns";
import { savedSegmentSnapshot } from "./subscribers-page-utils";
import type { SavedSegmentsLibrary } from "./useSavedSegmentsLibrary";
import type { SubscribersPageState } from "./useSubscribersPageState";
import type { SubscribersViewPreferences } from "./useSubscribersViewPreferences";

export function useRestoreActiveSubscriberSavedSegment(
  state: SubscribersPageState,
  view: SubscribersViewPreferences,
  library: SavedSegmentsLibrary,
  identityScope: string | null,
): void {
  const restoredActiveIdRef = useRef<string | null>(null);

  useEffect(() => {
    restoredActiveIdRef.current = null;
  }, [identityScope]);

  useEffect(() => {
    const activeId = state.activeSavedSegmentId;
    if (!activeId) {
      restoredActiveIdRef.current = null;
      return;
    }
    if (library.loading || view.preferencesLoading || library.error) return;
    const segment = library.segments.find(({ id }) => id === activeId);
    const snapshot = segment
      ? savedSegmentSnapshot(segment.predicate_json)
      : null;
    if (
      !segment ||
      !snapshot ||
      (snapshot.version ?? 0) < 3 ||
      !snapshot.authoritative ||
      !snapshot.columns
    ) {
      state.setActiveSavedSegmentId(null);
      return;
    }
    const status =
      snapshot.status === undefined || snapshot.status === "all"
        ? "all"
        : coerceUiStatus(snapshot.status);
    const savedSort = snapshot.sortColumn;
    const supportedSort =
      savedSort !== undefined &&
      (isServerSort(savedSort) ||
        Object.hasOwn(SUBSCRIBER_SORTABLE_COLUMNS, savedSort));
    const sortColumn = supportedSort ? savedSort : DEFAULT_SORT;
    const sortOrder = supportedSort
      ? (snapshot.sortOrder ?? DEFAULT_ORDER)
      : DEFAULT_ORDER;
    const dimensionsMatch =
      status !== null &&
      snapshot.query !== undefined &&
      state.query === snapshot.query &&
      state.debouncedQuery === snapshot.query &&
      state.filter === status &&
      state.showArchived === (snapshot.showArchived ?? false) &&
      state.sortColumn === sortColumn &&
      state.sortOrder === sortOrder;
    if (!dimensionsMatch) {
      restoredActiveIdRef.current = null;
      state.setActiveSavedSegmentId(null);
      return;
    }
    const desiredColumns = visibleSubscriberColumns({
      columns: snapshot.columns,
    });
    const columnsMatch =
      desiredColumns.length === view.visibleColumnKeys.length &&
      desiredColumns.every(
        (column, index) => column === view.visibleColumnKeys[index],
      );
    if (restoredActiveIdRef.current !== activeId) {
      restoredActiveIdRef.current = activeId;
      if (!columnsMatch) view.updateVisibleColumns(desiredColumns);
      return;
    }
    if (!columnsMatch) {
      restoredActiveIdRef.current = null;
      state.setActiveSavedSegmentId(null);
    }
  }, [
    library.error,
    library.loading,
    library.segments,
    state.activeSavedSegmentId,
    state.debouncedQuery,
    state.filter,
    state.query,
    state.setActiveSavedSegmentId,
    state.showArchived,
    state.sortColumn,
    state.sortOrder,
    view.preferencesLoading,
    view.updateVisibleColumns,
    view.visibleColumnKeys,
  ]);
}
