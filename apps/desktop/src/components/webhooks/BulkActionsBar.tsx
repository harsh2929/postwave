/**
 * BulkActionsBar — selection toolbar that appears when one or more
 * webhook rows are selected. PR 3.
 *
 * Pure presentation; actions are fired by the parent via callbacks.
 * Bulk operations loop over single-resource endpoints — no new
 * server-side bulk endpoint required.
 */

import { type ReactElement } from "react";

interface Props {
  count: number;
  /** Selected rows currently hidden by the active search filter. */
  hiddenCount?: number;
  canEnable?: boolean;
  canDisable?: boolean;
  canDelete?: boolean;
  /** Disables every action while a bulk op is in flight (anti double-fire). */
  busy?: boolean;
  onClear: () => void;
  onEnableAll?: () => void;
  onDisableAll?: () => void;
  onDeleteAll?: () => void;
}

export function BulkActionsBar({
  count,
  hiddenCount = 0,
  canEnable,
  canDisable,
  canDelete,
  busy,
  onClear,
  onEnableAll,
  onDisableAll,
  onDeleteAll,
}: Props): ReactElement | null {
  if (count === 0) return null;
  return (
    <div
      className="wh-bulk-bar"
      role="group"
      aria-label="Bulk webhook actions"
      aria-busy={busy || undefined}
    >
      <span>
        <strong>{count}</strong> selected
        {hiddenCount > 0 ? ` · ${hiddenCount} hidden by search` : ""}
      </span>
      {canEnable && onEnableAll ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onEnableAll}
          disabled={busy}
        >
          Re-enable all
        </button>
      ) : null}
      {canDisable && onDisableAll ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onDisableAll}
          disabled={busy}
        >
          Pause all
        </button>
      ) : null}
      {canDelete && onDeleteAll ? (
        <button
          type="button"
          className="btn btn-danger"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onDeleteAll}
          disabled={busy}
        >
          Delete all
        </button>
      ) : null}
      {busy ? (
        <span className="muted small" role="status" aria-live="polite">
          Applying bulk action…
        </span>
      ) : null}
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={onClear}
        disabled={busy}
      >
        ✕ Clear
      </button>
    </div>
  );
}
