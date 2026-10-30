/**
 * SaveBar — sticky "you have unsaved changes" bar with Discard +
 * Save actions. Pinned to the bottom of the settings content area
 * (above the chrome bar) so it never overlaps the sidebar.
 *
 * Behavioural contract:
 *
 *   - Renders nothing when `dirty` is false. The slide-in animation
 *     fires on mount so it feels intentional rather than abrupt.
 *   - "Save" button is disabled when `saving` is true; clicking
 *     invokes the supplied `onSave`.
 *   - "Discard" calls `onDiscard` (parent decides whether to confirm).
 *   - When `error` is non-empty, swaps the secondary slot for a
 *     red status line; keeps the buttons clickable so a retry is
 *     one click away.
 *   - When the parent passes `savedAt`, a fading "Saved" badge
 *     replaces the dirty state for 2 seconds then unmounts.
 */

import { type ReactElement, useEffect, useState } from "react";

interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  /** Hold both actions when the parent cannot safely save or discard. */
  actionsDisabled?: boolean;
  /** Optional error from the last save attempt. */
  error?: string | null;
  /** Counted summary, e.g. "3 unsaved changes". Auto-pluralised by parent. */
  summary?: string;
  onSave: () => void | Promise<void>;
  onDiscard: () => void;
  /**
   * Optional ISO timestamp from the last successful save. When set
   * and dirty=false, a brief "Saved" indicator fades in for 2s.
   */
  savedAt?: string | null;
}

export function SaveBar({
  dirty,
  saving,
  actionsDisabled = false,
  error,
  summary,
  onSave,
  onDiscard,
  savedAt,
}: SaveBarProps): ReactElement | null {
  // Brief "Saved" indicator after a successful save. Renders even
  // when dirty=false; auto-unmounts after 2 s.
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (savedAt && !dirty) {
      setShowSaved(true);
      const t = window.setTimeout(() => setShowSaved(false), 2000);
      return () => window.clearTimeout(t);
    }
    setShowSaved(false);
    return undefined;
  }, [savedAt, dirty]);

  if (!dirty && !showSaved) return null;

  return (
    <div
      className={`settings-savebar${dirty ? " is-dirty" : " is-saved"}`}
      role="status"
    >
      <div className="settings-savebar-inner">
        {dirty ? (
          <>
            <span className="settings-savebar-summary">
              {error ? (
                <span className="settings-savebar-error" role="alert">
                  {error}
                </span>
              ) : (
                summary || "Unsaved changes"
              )}
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm"
              onClick={onDiscard}
              disabled={saving || actionsDisabled}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void onSave()}
              disabled={saving || actionsDisabled}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </>
        ) : (
          <span className="settings-savebar-saved">
            <CheckIcon /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
