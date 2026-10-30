// SPDX-License-Identifier: AGPL-3.0-only
//
// Default route-segment loading fallback for dashboard pages. Most dashboard
// surfaces are header + stat grid + table, so the generic shape mirrors that
// (a table silhouette rather than a blank block) — table-heavy routes can
// point their own loading.tsx at a more specific skeleton.
import {
  PageHeaderSkeleton,
  StatGridSkeleton,
  TableSkeleton,
} from "@/components/dashboard/skeletons";

export default function RouteLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeaderSkeleton />
      <StatGridSkeleton />
      <TableSkeleton rows={6} />
    </div>
  );
}
