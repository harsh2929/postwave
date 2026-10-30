/**
 * LibrarySelectionBar — floating bar that appears when one or more
 * assets are selected. Provides bulk Copy URLs, Delete, and Clear.
 *
 * Stateless — actions are wired by the page.
 */

import { type ReactElement } from "react";

interface Props {
  count: number;
  canMutate: boolean;
  onCopyUrls: () => void;
  onDelete: () => void;
  onClear: () => void;
  busy?: boolean;
}

export function LibrarySelectionBar({
  count,
  canMutate,
  onCopyUrls,
  onDelete,
  onClear,
  busy = false,
}: Props): ReactElement | null {
  if (count === 0) return null;
  return (
    <div
      className="lib-selection-bar"
      role="group"
      aria-label="Selection actions"
    >
      <span>
        <strong>{count}</strong> selected
      </span>
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 12px", fontSize: 12 }}
        onClick={onCopyUrls}
        disabled={busy}
      >
        {busy ? "Working…" : "Copy URLs"}
      </button>
      {canMutate ? (
        <button
          type="button"
          className="btn btn-danger"
          style={{ padding: "4px 12px", fontSize: 12 }}
          onClick={onDelete}
          disabled={busy}
        >
          Delete
        </button>
      ) : (
        <span className="muted small">Viewer access can copy URLs only.</span>
      )}
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 12px", fontSize: 12 }}
        onClick={onClear}
        disabled={busy}
      >
        ✕ Clear
      </button>
    </div>
  );
}
