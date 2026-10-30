// SPDX-License-Identifier: AGPL-3.0-only
import { Skeleton } from "@/components/ui/skeleton";

import { FlowCardSkeletonGrid } from "./_components/flow-card-skeleton";

export default function FlowsLoading() {
  return (
    <div
      role="status"
      aria-label="Loading flows"
      className="w-full min-w-0 space-y-6 px-4 py-5 sm:p-6"
    >
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-9 w-full" />
      <FlowCardSkeletonGrid />
    </div>
  );
}
