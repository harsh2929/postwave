// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import type { AdminGate } from "@/lib/use-admin-gate";

export function AdminGateNotice({
  gate,
  readOnlyMessage,
  className = "",
}: {
  gate: AdminGate;
  readOnlyMessage: string;
  className?: string;
}) {
  const state =
    gate.state ??
    (gate.loading ? "loading" : gate.canWrite ? "writer" : "read-only");
  if (state === "writer") return null;
  if (state === "loading") {
    return (
      <div
        role="status"
        aria-busy="true"
        className={`rounded-md border border-dashed bg-muted/25 p-3 text-sm text-muted-foreground ${className}`}
      >
        Checking workspace permissions…
      </div>
    );
  }
  if (state === "error") {
    return (
      <div
        role="alert"
        className={`flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 ${className}`}
      >
        <div>
          <p className="text-sm font-medium text-destructive">
            Workspace permissions could not be verified
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Write controls remain unavailable until identity verification
            succeeds. This is not a read-only role decision.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={gate.retrying === true}
          disabled={gate.retrying === true}
          onClick={() => gate.retry?.()}
        >
          {gate.retrying ? "Retrying…" : "Retry permissions"}
        </Button>
      </div>
    );
  }
  return (
    <p
      role="note"
      className={`rounded-md border bg-muted/25 p-3 text-sm text-muted-foreground ${className}`}
    >
      {readOnlyMessage}
    </p>
  );
}
