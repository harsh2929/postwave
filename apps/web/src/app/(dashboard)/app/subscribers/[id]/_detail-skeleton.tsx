// SPDX-License-Identifier: AGPL-3.0-only
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/dashboard/page-shell";

/**
 * Branded skeleton mirroring the subscriber drill-down layout (breadcrumb +
 * avatar/status/gauge header + 5-stat grid + tabbed body). Used by both the
 * route-level `loading.tsx` and the client-side loading gate so the load reads
 * as one smooth shimmer instead of a generic fallback -> bare "Loading…" ->
 * full layout triple-flash.
 */
export function SubscriberDetailSkeleton() {
  return (
    <PageShell className="max-w-5xl">
      <Skeleton className="h-4 w-40" />

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-6">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-[72px] w-[72px] rounded-full" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={`stat-sk-${i}`} className="rounded-lg border bg-card p-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="mt-2 h-6 w-10" />
          </div>
        ))}
      </div>

      <div className="space-y-4">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={`row-sk-${i}`} className="flex items-center gap-3">
              <Skeleton className="h-3 w-3 rounded-full" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  );
}
