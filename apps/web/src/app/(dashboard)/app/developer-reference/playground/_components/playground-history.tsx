// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * History tab — this browser's record of playground attempts for the current
 * workspace and principal. It keeps only method, route template, status,
 * timing and outcome class; values and bodies are never written, so opening
 * an entry starts a blank draft.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { PlaygroundHistoryEntry } from "@/lib/api-playground-storage";

export function PlaygroundHistory({
  entries,
  onOpen,
  onClear,
}: {
  entries: PlaygroundHistoryEntry[];
  onOpen: (entry: PlaygroundHistoryEntry) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
        No playground requests have been sent from this browser for this
        workspace yet. Attempts appear here without their values.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {entries.length} recent {entries.length === 1 ? "attempt" : "attempts"} —
          parameter values, headers, and bodies are never stored.
        </p>
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" size="sm">
              Clear history
            </Button>
          }
          title="Clear playground history?"
          description={`This permanently removes all ${entries.length} history ${entries.length === 1 ? "entry" : "entries"} for this workspace from this browser. Requests already sent are not affected.`}
          confirmLabel="Clear history"
          onConfirm={onClear}
        />
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Playground history">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid gap-2 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono">
                  {entry.method}
                </Badge>
                <code className="break-all text-xs">{entry.pathTemplate}</code>
              </div>
              <p className="text-xs text-muted-foreground">
                {entry.outcome === "http" ? `HTTP ${entry.status}` : entry.outcome} ·{" "}
                {entry.durationMs} ms · {new Date(entry.at).toLocaleString()}
                {entry.ambiguous ? " · outcome may be ambiguous" : ""}
              </p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpen(entry)}>
              Open draft
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
