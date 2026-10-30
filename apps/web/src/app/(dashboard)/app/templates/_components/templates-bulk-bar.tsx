// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Archive, RotateCcw, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Sticky bulk-action bar for the templates library (TMPL-031). Renders only
 * when cards are selected. "Add to favorites" works on every card (catalog +
 * owned). Archive/restore are gated by the server-projected capabilities and
 * ask once via a single recoverable lifecycle confirmation.
 */
export function TemplatesBulkBar({
  count,
  favoriteableCount,
  archivableCount,
  restorableCount,
  onClear,
  onFavorite,
  onArchive,
  onRestore,
}: {
  count: number;
  favoriteableCount: number;
  archivableCount: number;
  restorableCount: number;
  onClear: () => void;
  onFavorite: () => void | Promise<void>;
  onArchive: () => void | Promise<void>;
  onRestore: () => void | Promise<void>;
}) {
  if (count === 0) return null;
  const archiveNoun = `${archivableCount.toLocaleString()} template${archivableCount === 1 ? "" : "s"}`;
  const restoreNoun = `${restorableCount.toLocaleString()} template${restorableCount === 1 ? "" : "s"}`;
  return (
    <div
      className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm shadow-sm backdrop-blur"
      role="region"
      aria-label="Bulk template actions"
    >
      <span
        className="font-medium tabular-nums"
        role="status"
        aria-live="polite"
      >
        {count} selected
      </span>
      <div
        className="ml-auto flex items-center gap-2"
        role="group"
        aria-label="Actions for selected templates"
      >
        {favoriteableCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Add ${favoriteableCount.toLocaleString()} selected template${
              favoriteableCount === 1 ? "" : "s"
            } to favorites`}
            onClick={() => void onFavorite()}
          >
            <Star className="h-4 w-4" />
            Add to favorites
          </Button>
        ) : null}
        {archivableCount > 0 ? (
          <ConfirmDialog
            title={`Archive ${archiveNoun}?`}
            description={`${archiveNoun} will become read-only and move to My templates → Archived. Existing campaigns are unaffected, and every template can be restored later.`}
            confirmLabel="Archive"
            onConfirm={onArchive}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Archive ${archiveNoun}`}
              >
                <Archive className="h-4 w-4" />
                Archive
              </Button>
            }
          />
        ) : null}
        {restorableCount > 0 ? (
          <ConfirmDialog
            title={`Restore ${restoreNoun}?`}
            description={`${restoreNoun} will return to the active library and become editable and usable again.`}
            confirmLabel="Restore"
            confirmVariant="default"
            onConfirm={onRestore}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Restore ${restoreNoun}`}
              >
                <RotateCcw className="h-4 w-4" />
                Restore
              </Button>
            }
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Clear template selection"
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
