// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Directory keyboard commands, ported from desktop's useSubscribersKeyboard:
//   /            focus search
//   j / k        move the focused row down / up
//   x            toggle selection of the focused row
//   Enter        open the focused row
//   n            new subscriber
//   Cmd/Ctrl+A   select every row on the page
//   Cmd/Ctrl+E   export the visible rows
// plus Arrow/Home/End roving focus inside the row list (`rowKeyDown`).
//
// Every command is optional: a surface passes only the verbs it can perform,
// and an omitted verb leaves the key to the browser (Cmd+A still selects
// text where the page has no row selection to offer).

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface DirectoryKeyboardCommands {
  /** Number of rows on the current page; 0 disables the row commands. */
  rowCount?: number;
  onFocusSearch?: () => void;
  onToggleRow?: (index: number) => void;
  onOpenRow?: (index: number) => void;
  onNew?: () => void;
  onSelectPage?: () => void;
  onExport?: () => void;
  /** Move DOM focus to a row. Defaults to `[data-subscriber-row-index="i"]`. */
  focusRow?: (index: number) => void;
  /** Suspend every shortcut (e.g. while a dialog owns the keyboard). */
  disabled?: boolean;
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
}

function modalOpen(): boolean {
  return (
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
  );
}

function defaultFocusRow(index: number): void {
  const row = document.querySelector<HTMLElement>(
    `[data-subscriber-row-index="${index}"]`,
  );
  row?.focus({ preventScroll: true });
  row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

export function useDirectoryKeyboardShortcuts(commands: DirectoryKeyboardCommands) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const latest = useRef(commands);
  const focusedRef = useRef(focusedIndex);
  useEffect(() => {
    latest.current = commands;
    focusedRef.current = focusedIndex;
  });

  const moveTo = useCallback((index: number) => {
    const rows = latest.current.rowCount ?? 0;
    if (rows <= 0) return;
    const next = Math.max(0, Math.min(rows - 1, index));
    setFocusedIndex(next);
    focusedRef.current = next;
    (latest.current.focusRow ?? defaultFocusRow)(next);
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const c = latest.current;
      if (c.disabled || event.defaultPrevented || modalOpen()) return;
      const inText = isTextEntryTarget(event.target);
      const mod = event.metaKey || event.ctrlKey;
      const rows = c.rowCount ?? 0;
      const focused = focusedRef.current;

      if (mod && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (inText) return;
        if (key === "a" && c.onSelectPage && rows > 0) {
          event.preventDefault();
          c.onSelectPage();
        } else if (key === "e" && c.onExport && rows > 0) {
          event.preventDefault();
          c.onExport();
        }
        return;
      }
      if (inText || event.altKey || mod) return;

      switch (event.key) {
        case "/":
          if (!c.onFocusSearch) return;
          event.preventDefault();
          c.onFocusSearch();
          return;
        case "n":
          if (!c.onNew) return;
          event.preventDefault();
          c.onNew();
          return;
        case "j":
          if (rows === 0) return;
          event.preventDefault();
          moveTo(focused < 0 ? 0 : focused + 1);
          return;
        case "k":
          if (rows === 0) return;
          event.preventDefault();
          moveTo(focused < 0 ? 0 : focused - 1);
          return;
        case "x":
          if (!c.onToggleRow || focused < 0 || focused >= rows) return;
          event.preventDefault();
          c.onToggleRow(focused);
          return;
        case "Enter":
          if (!c.onOpenRow || focused < 0 || focused >= rows) return;
          if (event.target instanceof HTMLElement && event.target.closest("button, a"))
            return;
          event.preventDefault();
          c.onOpenRow(focused);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveTo]);

  /** Roving focus for a row element: Arrow keys, Home and End. */
  const rowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, index: number) => {
      const rows = latest.current.rowCount ?? 0;
      const target =
        event.key === "ArrowDown"
          ? index + 1
          : event.key === "ArrowUp"
            ? index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? rows - 1
                : null;
      if (target === null || rows === 0) return;
      event.preventDefault();
      moveTo(target);
    },
    [moveTo],
  );

  return { focusedIndex, setFocusedIndex: moveTo, rowKeyDown };
}
