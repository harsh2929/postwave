/**
 * Semantic table view of the asset Library.
 *
 * Selection and Quick Look live on one roving primary button per row. Real
 * sibling action buttons stay reachable for the active row without pretending
 * that a table containing buttons is a listbox.
 */

import { type ReactElement, useEffect, useId, useRef } from "react";

import { type Asset } from "../../lib/api-client";
import {
  asCount,
  asNonEmptyString,
  fmtBytes,
  fmtDims,
  fmtRelDate,
} from "../../lib/library-filters";
import {
  type SelectionEvent,
  type SelectionState,
} from "../../lib/library-selection";
import { AssetThumb } from "./AssetThumb";

interface Props {
  assets: Asset[];
  selection: SelectionState;
  onSelection: (event: SelectionEvent) => void;
  onOpenQuickLook: (id: string) => void;
  onCopyUrl?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function LibraryList({
  assets,
  selection,
  onSelection,
  onOpenQuickLook,
  onCopyUrl,
  onDelete,
}: Props): ReactElement {
  const tableRef = useRef<HTMLTableElement>(null);
  const keyboardFocusPendingRef = useRef(false);
  const instructionsId = useId();
  const activeId = assets.some((asset) => asset.id === selection.focusId)
    ? selection.focusId
    : (assets[0]?.id ?? null);

  useEffect(() => {
    if (!selection.focusId || !tableRef.current) return;
    const primary = findPrimary(tableRef.current, selection.focusId);
    primary?.scrollIntoView({ block: "nearest" });
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
      event.key === "ArrowUp"
        ? "up"
        : event.key === "ArrowDown"
          ? "down"
          : null;
    if (!dir) return;
    event.preventDefault();
    moveFocus({ type: "arrow", dir, extend: event.shiftKey, rowSize: 1 });
  };

  const activateRow = (
    id: string,
    event: React.MouseEvent<HTMLTableRowElement>,
  ): void => {
    const target = event.target as Element;
    if (target.closest(".lib-list-actions")) return;
    if (event.shiftKey) onSelection({ type: "shift-click", id });
    else if (event.metaKey || event.ctrlKey) {
      onSelection({ type: "cmd-click", id });
    } else onSelection({ type: "click", id });
    findPrimary(event.currentTarget, id)?.focus();
  };

  const runFor = (id: string, action: () => void): void => {
    if (selection.focusId !== id) onSelection({ type: "focus", id });
    action();
  };

  return (
    <>
      <p id={instructionsId} className="visually-hidden">
        Asset table. Use Up, Down, Home, and End to move between assets. Space
        toggles selection; Enter previews. Hold Shift while moving to extend
        selection. Tab reaches actions for the active asset. The browser context
        menu is available with right click or Shift+F10.
      </p>
      <table
        ref={tableRef}
        className="lib-list"
        aria-label="Assets"
        aria-describedby={instructionsId}
      >
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Size</th>
            <th scope="col">Dimensions</th>
            <th scope="col">Used in</th>
            <th scope="col">Uploaded</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => {
            const selected = selection.selected.has(asset.id);
            const tabStop = activeId === asset.id;
            const rowClasses = ["lib-list-row"];
            if (selected) rowClasses.push("is-selected");
            if (selection.focusId === asset.id) rowClasses.push("is-focused");
            return (
              <tr
                key={asset.id}
                className={rowClasses.join(" ")}
                data-asset-id={asset.id}
                onClick={(event) => activateRow(asset.id, event)}
                onDoubleClick={(event) => {
                  if (!(event.target as Element).closest(".lib-list-actions")) {
                    onOpenQuickLook(asset.id);
                  }
                }}
              >
                <td>
                  <button
                    type="button"
                    className="lib-list-target"
                    data-library-primary={asset.id}
                    tabIndex={tabStop ? 0 : -1}
                    aria-pressed={selected}
                    aria-label={`${asset.filename}. ${selected ? "Selected" : "Not selected"}. Enter previews; Space toggles selection.`}
                    onFocus={() => {
                      if (selection.focusId !== asset.id) {
                        onSelection({ type: "focus", id: asset.id });
                      }
                    }}
                    onKeyDown={(event) => onPrimaryKeyDown(asset.id, event)}
                  >
                    <span className="lib-list-thumb">
                      <AssetThumb
                        url={asset.url}
                        alt={asNonEmptyString(asset.altText, asset.filename)}
                        mime={asset.mime}
                        loading="lazy"
                      />
                    </span>
                    <span>{asset.filename}</span>
                  </button>
                </td>
                <td className="tabular">{fmtBytes(asset.bytes)}</td>
                <td className="tabular">
                  {fmtDims(asset.width, asset.height)}
                </td>
                <td className="tabular">{asCount(asset.referencesCount)}</td>
                <td>{fmtRelDate(asset.createdAt)}</td>
                <td>
                  <div
                    className="lib-list-actions"
                    role="group"
                    aria-label={`Actions for ${asset.filename}`}
                  >
                    <LibraryListAction
                      label={`Preview ${asset.filename}`}
                      text="Preview"
                      tabIndex={tabStop ? 0 : -1}
                      onClick={() =>
                        runFor(asset.id, () => onOpenQuickLook(asset.id))
                      }
                    />
                    {onCopyUrl ? (
                      <LibraryListAction
                        label={`Copy URL for ${asset.filename}`}
                        text="Copy URL"
                        tabIndex={tabStop ? 0 : -1}
                        onClick={() =>
                          runFor(asset.id, () => onCopyUrl(asset.id))
                        }
                      />
                    ) : null}
                    {onDelete ? (
                      <LibraryListAction
                        label={`Delete ${asset.filename}`}
                        text="Delete"
                        tabIndex={tabStop ? 0 : -1}
                        danger
                        onClick={() =>
                          runFor(asset.id, () => onDelete(asset.id))
                        }
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function LibraryListAction({
  label,
  text,
  tabIndex,
  danger,
  onClick,
}: {
  label: string;
  text: string;
  tabIndex: number;
  danger?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      className={`lib-list-action${danger ? " danger" : ""}`}
      tabIndex={tabIndex}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {text}
    </button>
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
