/**
 * TagBulkBar — selection toolbar that appears when 1+ tag rows are
 * checked. Refined Tags PR 1, extended in PR 3 with Recolour /
 * Describe entry points. Mirrors the WebhookBulkBar pattern — pure
 * presentation; parent owns selection state + action implementations.
 */

import { type ReactElement } from "react";

interface Props {
  count: number;
  canDelete: boolean;
  deleteUnavailableReason?: string;
  onClear: () => void;
  onDelete: () => void;
  /** Optional: surfaces a "Merge…" CTA that opens the Merge dialog
   *  pre-seeded with the selected tag(s). Full-surface wiring #27:
   *  the dialog now fans N sources out as N merge calls, so the CTA
   *  is no longer limited to a single selection. */
  onMerge?: () => void;
  /** Refined Tags PR 3: bulk recolour entry point. */
  onRecolour?: () => void;
  /** Refined Tags PR 3: bulk description set/clear entry point. */
  onDescribe?: () => void;
}

export function TagBulkBar({
  count,
  canDelete,
  deleteUnavailableReason,
  onClear,
  onDelete,
  onMerge,
  onRecolour,
  onDescribe,
}: Props): ReactElement | null {
  if (count === 0) return null;
  return (
    <div className="tag-bulk-bar" role="group" aria-label="Tag actions">
      <span>
        <strong>{count}</strong> selected
      </span>
      {onMerge ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onMerge}
        >
          Merge…
        </button>
      ) : null}
      {onRecolour ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onRecolour}
        >
          Recolour…
        </button>
      ) : null}
      {onDescribe ? (
        <button
          type="button"
          className="btn"
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={onDescribe}
        >
          Describe…
        </button>
      ) : null}
      <button
        type="button"
        className={`btn btn-danger${canDelete ? "" : " pw-discoverable-unavailable"}`}
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={() => {
          if (canDelete) onDelete();
        }}
        aria-disabled={!canDelete || undefined}
        aria-describedby={!canDelete ? "tags-delete-availability" : undefined}
        aria-label={
          !canDelete && deleteUnavailableReason
            ? `Delete unavailable: ${deleteUnavailableReason}`
            : `Delete ${count}`
        }
      >
        Delete {count}
      </button>
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={onClear}
        aria-keyshortcuts="Escape"
      >
        ✕ Clear
      </button>
    </div>
  );
}
