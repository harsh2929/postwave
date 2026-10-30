import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import type { Subscriber } from "../../lib/api-client";
import {
  applySubscriberSelection,
  type SelectionState,
} from "../../lib/subscriber-selection";
import { subscriberKey } from "./subscribers-page-utils";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

function samePageKeys(
  previous: readonly string[],
  current: readonly string[],
): boolean {
  return (
    previous.length === current.length &&
    previous.every((key, index) => key === current[index])
  );
}

export function useSubscribersSelection(
  state: SubscribersPageState,
  data: SubscribersData,
) {
  const pageKeys = useMemo(
    () => data.pageRows.map(subscriberKey),
    [data.pageRows],
  );
  const pageKeySet = useMemo(() => new Set(pageKeys), [pageKeys]);
  const selectionScope = useMemo(
    () =>
      JSON.stringify({
        query: state.query,
        appliedQuery: state.debouncedQuery,
        filter: state.filter,
        includeArchived: state.showArchived,
        page: state.page,
        sort: state.sortColumn,
        order: state.sortOrder,
      }),
    [
      state.debouncedQuery,
      state.filter,
      state.page,
      state.query,
      state.showArchived,
      state.sortColumn,
      state.sortOrder,
    ],
  );
  const selectionScopeRef = useRef(selectionScope);
  const pageKeysRef = useRef(pageKeys);

  const allPageSelected =
    pageKeys.length > 0 && pageKeys.every((key) => state.selectedKeys.has(key));

  const toggleRow = (row: Subscriber): void => {
    const key = subscriberKey(row);
    if (!pageKeySet.has(key)) return;
    state.setSelectedKeys((previous) => {
      const next = new Set(
        Array.from(previous).filter((selected) => pageKeySet.has(selected)),
      );
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    state.setFocusId(key);
  };

  const selectRow = (
    row: Subscriber,
    modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean },
  ): void => {
    const key = subscriberKey(row);
    if (!pageKeySet.has(key)) return;
    const selection: SelectionState = {
      selected: new Set(
        Array.from(state.selectedKeys).filter((selected) =>
          pageKeySet.has(selected),
        ),
      ),
      focusId:
        state.focusId && pageKeySet.has(state.focusId) ? state.focusId : null,
    };
    const event = modifiers.shift
      ? ({ type: "shift-click", id: key } as const)
      : modifiers.meta || modifiers.ctrl
        ? ({ type: "cmd-click", id: key } as const)
        : ({ type: "click", id: key } as const);
    const next = applySubscriberSelection(selection, pageKeys, event);
    state.setSelectedKeys(next.selected);
    state.setFocusId(next.focusId);
  };

  const togglePage = (): void => {
    state.setSelectedKeys((previous) => {
      const pageIsSelected =
        pageKeys.length > 0 && pageKeys.every((key) => previous.has(key));
      return pageIsSelected ? new Set() : new Set(pageKeys);
    });
    state.setFocusId(null);
  };

  const selectedRows = useMemo<Subscriber[]>(() => {
    return data.pageRows.filter((row) =>
      state.selectedKeys.has(subscriberKey(row)),
    );
  }, [data.pageRows, state.selectedKeys]);

  useLayoutEffect(() => {
    const scopeChanged = selectionScopeRef.current !== selectionScope;
    const pageChanged = !samePageKeys(pageKeysRef.current, pageKeys);
    selectionScopeRef.current = selectionScope;
    pageKeysRef.current = pageKeys;
    if (scopeChanged) {
      state.setSelectedKeys((previous) =>
        previous.size === 0 ? previous : new Set(),
      );
      state.setFocusId(null);
      state.setFocusedRowIndex(-1);
      return;
    }

    state.setSelectedKeys((previous) => {
      const next = new Set(
        Array.from(previous).filter((key) => pageKeySet.has(key)),
      );
      return next.size === previous.size ? previous : next;
    });
    if (state.focusId && !pageKeySet.has(state.focusId)) {
      state.setFocusId(null);
    }
    if (pageChanged) {
      state.setFocusedRowIndex(
        state.focusId && pageKeySet.has(state.focusId)
          ? pageKeys.indexOf(state.focusId)
          : -1,
      );
    } else {
      state.setFocusedRowIndex((index) =>
        index >= data.pageRows.length ? data.pageRows.length - 1 : index,
      );
    }
  }, [
    data.pageRows.length,
    pageKeys,
    pageKeySet,
    selectionScope,
    state.focusId,
    state.setFocusId,
    state.setFocusedRowIndex,
    state.setSelectedKeys,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && state.selectedKeys.size > 0) {
        state.setSelectedKeys(new Set());
        state.setFocusId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.selectedKeys]);

  return {
    allPageSelected,
    selectedRows,
    toggleRow,
    selectRow,
    togglePage,
  };
}

export type SubscribersSelection = ReturnType<typeof useSubscribersSelection>;
