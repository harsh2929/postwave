// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-level loading skeleton for the Overview / Home page. Mirrors the real
// page's width (max-w-5xl) and stack silhouette — header + stat grid + a card —
// built from the content-shaped helpers so content settles in place instead of
// jumping on data arrival (OVR-012).
import {
  PageHeaderSkeleton,
  StatGridSkeleton,
} from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeaderSkeleton />
        <Skeleton className="h-9 w-24" />
      </div>
      {/* Performance snapshot (4 tiles) + headline counts (3 tiles). */}
      <StatGridSkeleton count={4} className="grid-cols-2 sm:grid-cols-4" />
      <StatGridSkeleton />
      {/* Onboarding checklist + a content card. */}
      <Skeleton className="h-48 w-full rounded-lg" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
