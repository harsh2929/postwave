// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { cn } from "@/lib/utils";

/**
 * Loading silhouette shared by the form editor's deferred (next/dynamic)
 * panels. Lives in its own module so the page and the split-out editor panels
 * can both use it without pulling either into the other's chunk.
 */
export function DeferredFormPanel({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-24 animate-pulse rounded-md border bg-muted/30 motion-reduce:animate-none",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
