// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Recovery for a failed draft save (desktop parity automation-71; desktop
// reference apps/desktop/src/components/sequence/StepCanvas.tsx:1646-1666 and
// the :2339 "Discard the failed change and reload?" confirm). The local
// snapshot is never dropped silently: a transient failure offers to re-send it
// under the same version, and a version conflict (412) offers — behind a
// confirm that names the loss — to discard it and load the latest saved draft.

import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { SaveFailure } from "@/lib/flow-canvas-model";

export function AutosaveRecoveryBanner({
  failure,
  busy,
  canRetry,
  retryUnavailableReason,
  onRetry,
  onReload,
}: {
  failure: SaveFailure | null;
  /** A save or reload is in flight. */
  busy: boolean;
  /** Write authority for re-sending the snapshot. */
  canRetry: boolean;
  retryUnavailableReason?: string;
  onRetry: () => void;
  onReload: () => void | Promise<void>;
}) {
  if (!failure) return null;
  return (
    <section
      role="alert"
      aria-label={
        failure.kind === "queued"
          ? "Draft change waiting to sync"
          : "Draft save needs attention"
      }
      className="flex flex-wrap items-start gap-3 border-b border-destructive/30 bg-destructive/5 px-4 py-3 text-sm sm:px-6"
    >
      <TriangleAlert
        className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
        aria-hidden
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {failure.kind === "queued"
            ? "Draft change waiting to sync."
            : "Draft save needs attention."}
        </p>
        <p className="break-words text-muted-foreground">{failure.message}</p>
        {failure.kind === "fix" ? (
          <p className="text-xs text-muted-foreground">
            Your changes are still here. Correct the step named above, then save
            again.
          </p>
        ) : null}
      </div>
      {failure.kind === "retry" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !canRetry}
          title={canRetry ? undefined : retryUnavailableReason}
          onClick={onRetry}
        >
          <RotateCcw className="h-4 w-4" /> Retry failed change
        </Button>
      ) : null}
      {failure.kind === "reload" ? (
        <ConfirmDialog
          trigger={
            <Button type="button" size="sm" variant="outline" disabled={busy}>
              <RefreshCw className="h-4 w-4" /> Reload latest version
            </Button>
          }
          title="Discard the failed change and reload?"
          description="The unsaved changes on this page are discarded and the latest saved version of the draft is loaded. Review that version, then re-apply the change you intended."
          confirmLabel="Discard and reload"
          onConfirm={onReload}
        />
      ) : null}
    </section>
  );
}
