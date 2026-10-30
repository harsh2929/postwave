// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-level skeleton. Mirrors the real Overview tab: a header, an 8-tile KPI
// grid, and a chart silhouette (the page does render trend charts), so the
// loading→loaded transition doesn't reshuffle the layout (ANL-021).
import {
  ChartSkeleton,
  PageHeaderSkeleton,
  StatGridSkeleton,
} from "@/components/dashboard/skeletons";

export default function AnalyticsLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <PageHeaderSkeleton />
      <StatGridSkeleton count={8} className="sm:grid-cols-2 lg:grid-cols-4" />
      <ChartSkeleton />
    </div>
  );
}
