// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-level loading skeleton (SEG-027): shaped like the segments list so the
// page settles in place instead of blocking on the server fetch.

import {
  PageHeaderSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="px-6 py-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <PageHeaderSkeleton />
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-28 w-full rounded-lg" />
      <Skeleton className="h-10 w-full" />
      <TableSkeleton
        rows={6}
        columns={["w-10", "w-48", "w-16", "w-28", "w-20"]}
      />
    </div>
  );
}
