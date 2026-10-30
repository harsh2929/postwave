/**
 * Native card collection for the asset Library grid.
 *
 * This is deliberately not a listbox: cards contain real Preview/Copy/Delete
 * buttons, and listbox options may not own those interactive descendants. The
 * primary asset buttons use roving DOM focus for Arrow/Home/End while sibling
 * actions for the active card remain reachable with Tab.
 */

import { type ReactElement, useEffect, useId, useRef } from "react";

import { type Asset } from "../../lib/api-client";
import {
  type SelectionEvent,
  type SelectionState,
} from "../../lib/library-selection";
import { LibraryTile } from "./LibraryTile";

export type Density = "comfortable" | "cozy" | "compact";

interface Props {
  assets: Asset[];
  selection: SelectionState;
  density: Density;
  /** Approximate rendered row size, used for vertical focus movement. */
  rowSize: number;
  onSelection: (event: SelectionEvent) => void;
  onOpenQuickLook: (id: string) => void;
  onCopyUrl?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function LibraryGrid({
  assets,
  selection,
  density,
  rowSize,
  onSelection,
  onOpenQuickLook,
  onCopyUrl,
  onDelete,
}: Props): ReactElement {
  const containerRef = useRef<HTMLUListElement>(null);
  const keyboardFocusPendingRef = useRef(false);
  const instructionsId = useId();
  const activeId = assets.some((asset) => asset.id === selection.focusId)
    ? selection.focusId
    : (assets[0]?.id ?? null);

  useEffect(() => {
    if (!selection.focusId || !containerRef.current) return;
    const primary = findPrimary(containerRef.current, selection.focusId);
    primary?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (keyboardFocusPendingRef.current) {
      keyboardFocusPendingRef.current = false;
      primary?.focus();
    }
  }, [selection.focusId]);

  const moveFocus = (event: SelectionEvent): void => {
    keyboardFocusPendingRef.current = true;
    onSelection(event);
  };

  const onPrimaryKeyDown = (
    id: string,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      onSelection({ type: "select-all" });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onSelection({ type: "escape" });
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      onSelection({ type: "cmd-click", id });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onOpenQuickLook(id);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      moveFocus({
        type: "boundary",
        edge: event.key === "Home" ? "first" : "last",
        extend: event.shiftKey,
      });
      return;
    }
    const dir =
      event.key === "ArrowRight"
        ? "right"
        : event.key === "ArrowLeft"
          ? "left"
          : event.key === "ArrowUp"
            ? "up"
            : event.key === "ArrowDown"
              ? "down"
              : null;
    if (!dir) return;
    event.preventDefault();
    moveFocus({ type: "arrow", dir, extend: event.shiftKey, rowSize });
  };

  const activatePrimary = (
    id: string,
    event: React.MouseEvent<HTMLButtonElement>,
  ): void => {
    // Click is the canonical activation boundary. It is emitted by completed
    // mouse/touch gestures and by assistive technology, but not by a cancelled
    // pointer gesture. Space and Enter are handled above and prevent their
    // follow-up click so keyboard input cannot double-fire.
    if (event.shiftKey) onSelection({ type: "shift-click", id });
    else if (event.metaKey || event.ctrlKey) {
      onSelection({ type: "cmd-click", id });
    } else onSelection({ type: "click", id });
  };

  const runFor = (id: string, action: () => void): void => {
    if (selection.focusId !== id) onSelection({ type: "focus", id });
    action();
  };

  return (
    <>
      <p id={instructionsId} className="visually-hidden">
        Asset cards. Use Arrow keys, Home, and End to move. Space toggles
        selection; Enter previews. Hold Shift while moving to extend selection.
        Tab reaches actions for the active asset. The browser context menu is
        available with right click or Shift+F10.
      </p>
      <ul
        ref={containerRef}
        className="lib-grid"
        data-density={density}
        aria-label="Assets"
        aria-describedby={instructionsId}
      >
        {assets.map((asset) => (
          <LibraryTile
            key={asset.id}
            asset={asset}
            selected={selection.selected.has(asset.id)}
            focused={selection.focusId === asset.id}
            tabStop={activeId === asset.id}
            onFocus={() => {
              if (selection.focusId !== asset.id) {
                onSelection({ type: "focus", id: asset.id });
              }
            }}
            onActivate={(event) => activatePrimary(asset.id, event)}
            onDoubleClick={() => onOpenQuickLook(asset.id)}
            onKeyDown={(event) => onPrimaryKeyDown(asset.id, event)}
            onPreview={() => runFor(asset.id, () => onOpenQuickLook(asset.id))}
            onCopyUrl={
              onCopyUrl
                ? () => runFor(asset.id, () => onCopyUrl(asset.id))
                : undefined
            }
            onDelete={
              onDelete
                ? () => runFor(asset.id, () => onDelete(asset.id))
                : undefined
            }
          />
        ))}
      </ul>
    </>
  );
}

function findPrimary(root: HTMLElement, id: string): HTMLButtonElement | null {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/(["\\])/gu, "\\$1");
  return root.querySelector<HTMLButtonElement>(
    `[data-library-primary="${escaped}"]`,
  );
}
