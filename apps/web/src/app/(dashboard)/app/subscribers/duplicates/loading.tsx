// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-level loading skeleton for the SUB-037 duplicates surface.

import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="px-6 py-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <PageHeaderSkeleton />
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-32 w-full rounded-lg" />
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  );
}
