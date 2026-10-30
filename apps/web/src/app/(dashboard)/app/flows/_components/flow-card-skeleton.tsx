// SPDX-License-Identifier: AGPL-3.0-only
//
// One card-shaped loading skeleton reused by both the route-level loading.tsx
// and the in-component isLoading branch (FLOW-039), so the loading state
// previews the real card layout (name + status badge + meta line) and the two
// paths cannot diverge into a visible swap.
import { Skeleton } from "@/components/ui/skeleton";

export function FlowCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-3 w-40" />
      <Skeleton className="mt-2 h-3 w-24" />
    </div>
  );
}

export function FlowCardSkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <FlowCardSkeleton key={i} />
      ))}
    </div>
  );
}
