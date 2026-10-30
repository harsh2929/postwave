/**
 * InboxBulkBar — sticky bottom strip when 1+ conversations are
 * checked. Refined SMS Inbox PR 2. Mirrors the TagBulkBar idiom
 * (count + action buttons + ✕ clear). Bulk actions resolve via
 * api.bulkSMSConversationAction in the parent.
 */

import type { ReactElement } from "react";

interface Props {
  count: number;
  onClear: () => void;
  onArchive: () => void;
  onSnooze: () => void;
}

export function InboxBulkBar({
  count,
  onClear,
  onArchive,
  onSnooze,
}: Props): ReactElement | null {
  if (count === 0) return null;
  return (
    <div
      className="sms-bulk-bar"
      role="group"
      aria-label="Conversation actions"
    >
      <span>
        <strong>{count}</strong> selected
      </span>
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={onSnooze}
      >
        Snooze 8h
      </button>
      <button
        type="button"
        className="btn"
        style={{ padding: "4px 10px", fontSize: 12 }}
        onClick={onArchive}
      >
        Archive
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
