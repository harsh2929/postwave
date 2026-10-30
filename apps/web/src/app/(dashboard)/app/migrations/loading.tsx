// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-segment loading skeleton for the migrations index. The generic
// route-loading (header + stat grid + table) never matched this page's shape —
// it has no stat grid, it has a source-card grid + a recent table — so a hard
// nav flashed a stat-grid silhouette that never resolved (MIGR-005). This
// mirrors the real layout: header, source-card grid, recent table.
import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { PageShell } from "@/components/dashboard/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function MigrationsLoading() {
  return (
    <PageShell className="max-w-6xl space-y-8">
      <span className="sr-only" role="status">
        Loading migrations
      </span>
      <div className="rounded-2xl border bg-card p-5 sm:p-6">
        <PageHeaderSkeleton />
      </div>
      <section className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-md border bg-card p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-3/4" />
              <div className="space-y-1.5 pt-1">
                {Array.from({ length: 4 }).map((_, r) => (
                  <Skeleton key={r} className="h-3 w-2/3" />
                ))}
              </div>
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <TableSkeleton
          rows={4}
          columns={["w-40", "w-24", "w-20", "w-16", "w-16"]}
        />
      </section>
    </PageShell>
  );
}
