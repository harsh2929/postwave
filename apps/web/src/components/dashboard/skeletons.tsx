// SPDX-License-Identifier: AGPL-3.0-only
//
// Content-shaped loading skeletons. Each mirrors the silhouette of the real
// surface (stat grid, table, chart) so screens settle in place on data
// arrival instead of jumping from a generic block. All shimmer via the base
// <Skeleton> (which honours prefers-reduced-motion).
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Title + subtitle, matching a dashboard page header. */
export function PageHeaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

/** A row of stat-card silhouettes matching the <Stat> grid (label + figure). */
export function StatGridSkeleton({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-3", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-md border bg-card px-4 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * A bordered table silhouette: a muted header bar + `rows` shimmer rows whose
 * cell widths echo the real columns (`columns` = an array of width classes) so
 * the layout doesn't shift when data lands.
 */
export function TableSkeleton({
  rows = 8,
  columns = ["w-48", "w-20", "w-28", "w-16", "w-24"],
  className,
}: {
  rows?: number;
  columns?: string[];
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-md border bg-card", className)}>
      <div className="flex items-center gap-4 border-b bg-muted/40 px-4 py-2.5">
        {columns.map((w, i) => (
          <Skeleton key={i} className={cn("h-3", w)} />
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3.5">
            {columns.map((w, c) => (
              <Skeleton key={c} className={cn("h-4", w)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stat tiles + a bar-chart silhouette, for analytics-style pages. */
export function ChartSkeleton({ className }: { className?: string }) {
  // Deterministic bar heights (no Math.random — stable across SSR/CSR).
  const bars = [62, 84, 48, 96, 72, 56, 88, 42, 78, 92, 52, 68];
  return (
    <div className={cn("space-y-4 rounded-md border bg-card p-5", className)}>
      <Skeleton className="h-4 w-40" />
      <div className="flex h-48 items-end gap-2">
        {bars.map((h, i) => (
          <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}
