import { useEffect, useRef } from "react";

import { isModKey, isTextInputTarget } from "../../lib/keyboard-shortcuts";
import type { Subscriber } from "../../lib/api-client";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersExport } from "./useSubscribersExport";
import type { SubscribersPageState } from "./useSubscribersPageState";
import type { SubscribersSelection } from "./useSubscribersSelection";

export function useSubscribersKeyboard(options: {
  state: SubscribersPageState;
  data: SubscribersData;
  selection: SubscribersSelection;
  exporter: SubscribersExport;
  openCreate: () => void;
  openSubscriber: (subscriber: Subscriber) => void;
}) {
  const { state, data, selection, exporter, openCreate, openSubscriber } =
    options;
  const searchRef = useRef<HTMLInputElement | null>(null);

  const focusDirectoryRow = (index: number): void => {
    window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-subscriber-row-index="${index}"]`,
      );
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (
        state.selected ||
        state.createOpen ||
        state.importOpen ||
        state.dedupeOpen ||
        state.mergeFieldsOpen
      ) {
        return;
      }
      const inText = isTextInputTarget(event.target);
      const directoryGrid = document.querySelector<HTMLElement>(
        '[role="grid"][aria-label="Subscribers directory"]',
      );
      const directoryVisible =
        directoryGrid !== null && directoryGrid.closest("[hidden]") === null;
      if (!directoryVisible) {
        if (!inText && !isModKey(event) && event.key === "n") {
          event.preventDefault();
          openCreate();
        }
        return;
      }
      if (event.key === "/" && !inText && !isModKey(event)) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (isModKey(event) && (event.key === "a" || event.key === "A")) {
        if (inText) return;
        event.preventDefault();
        selection.togglePage();
        return;
      }
      if (isModKey(event) && (event.key === "e" || event.key === "E")) {
        if (inText) return;
        event.preventDefault();
        if (data.rows && data.pageRows.length > 0) {
          void exporter.exportVisible();
        }
        return;
      }
      if (inText || isModKey(event)) return;
      if (data.pageRows.length === 0 && event.key !== "n") return;
      switch (event.key) {
        case "j":
          event.preventDefault();
          {
            const nextIndex = Math.min(
              data.pageRows.length - 1,
              state.focusedRowIndex < 0 ? 0 : state.focusedRowIndex + 1,
            );
            state.setFocusedRowIndex(nextIndex);
            focusDirectoryRow(nextIndex);
          }
          break;
        case "k":
          event.preventDefault();
          {
            const nextIndex = Math.max(
              0,
              state.focusedRowIndex < 0 ? 0 : state.focusedRowIndex - 1,
            );
            state.setFocusedRowIndex(nextIndex);
            focusDirectoryRow(nextIndex);
          }
          break;
        case "x":
          if (
            state.focusedRowIndex >= 0 &&
            state.focusedRowIndex < data.pageRows.length
          ) {
            event.preventDefault();
            selection.toggleRow(data.pageRows[state.focusedRowIndex]);
          }
          break;
        case "n":
          event.preventDefault();
          openCreate();
          break;
        case "Enter":
          if (
            state.focusedRowIndex >= 0 &&
            state.focusedRowIndex < data.pageRows.length
          ) {
            event.preventDefault();
            openSubscriber(data.pageRows[state.focusedRowIndex]);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // The effect deliberately tracks the same visible/modal state as the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.selected,
    state.createOpen,
    state.importOpen,
    state.dedupeOpen,
    state.mergeFieldsOpen,
    data.pageRows,
    state.focusedRowIndex,
    data.rows,
  ]);

  return { searchRef };
}

export type SubscribersKeyboard = ReturnType<typeof useSubscribersKeyboard>;
