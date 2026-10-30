// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import type { ReactNode } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Sticky bulk-action bar for the campaigns list (CAMP-005). Renders only when
 * rows are selected; destructive bulk delete asks once (with the count) via a
 * single ConfirmDialog rather than per row. `extraActions` carries the
 * selection verbs that are not deletes (Move to folder, Tag, Export CSV).
 */
export function CampaignBulkBar({
  canWrite,
  count,
  extraActions,
  onClear,
  onDelete,
  readOnlyMessage,
}: {
  canWrite: boolean;
  count: number;
  extraActions?: ReactNode;
  onClear: () => void;
  onDelete: () => void | Promise<void>;
  readOnlyMessage: string;
}) {
  if (count === 0) return null;
  const noun = `${count.toLocaleString()} campaign${count === 1 ? "" : "s"}`;
  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm shadow-sm backdrop-blur">
      <span className="font-medium tabular-nums">{count} selected</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {extraActions}
        <ConfirmDialog
          title={`Delete ${noun}?`}
          description={`${noun} will be removed from this workspace. This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={onDelete}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={!canWrite}
              title={!canWrite ? readOnlyMessage : undefined}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          }
        />
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
