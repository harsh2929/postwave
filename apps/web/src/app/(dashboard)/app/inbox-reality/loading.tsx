// SPDX-License-Identifier: AGPL-3.0-only
//
// Cluster-specific loading silhouette. The Inbox Reality overview is a
// reputation card + auth-health card + recent-campaigns list + a pre-send CTA —
// there is no stat grid and no table, so the generic route-loading fallback
// (header + stat grid + table) reflowed on content arrival. This mirrors the
// real layout instead.
import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

function CardSkeleton({ bodyRows = 2 }: { bodyRows?: number }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-6">
      <Skeleton className="h-5 w-52" />
      <Skeleton className="h-3.5 w-72 max-w-full" />
      <div className="flex flex-wrap gap-2 pt-1">
        {Array.from({ length: bodyRows === 2 ? 4 : bodyRows }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-28 rounded-full" />
        ))}
      </div>
    </div>
  );
}

export default function InboxRealityLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeaderSkeleton />
      {/* Reputation card */}
      <CardSkeleton />
      {/* Auth-health card (5 protocol rows) */}
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
        <div className="space-y-2 pt-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-3.5 w-48 max-w-[60%]" />
            </div>
          ))}
        </div>
      </div>
      {/* Recent campaigns list */}
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-40" />
        <div className="divide-y rounded-md border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-52" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
