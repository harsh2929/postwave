// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Compact, in-place recovery for the read-only content/automation surfaces. */
export function ContentQueryError({
  message,
  onRetry,
  retrying = false,
  className,
}: {
  message: string;
  onRetry: () => void | Promise<unknown>;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "mt-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm font-medium text-foreground",
        className,
      )}
    >
      <p>{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void onRetry()}
        loading={retrying}
      >
        Retry
      </Button>
    </div>
  );
}
