// SPDX-License-Identifier: AGPL-3.0-only
//
// Structured loading skeleton for the migration detail route. A hard nav to a
// migration used to flash a lone centered spinner with no page structure
// (MIGR-015); this mirrors the real layout: breadcrumb + title, an audience
// scope card, the verification report, and the audit card.
import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { PageShell } from "@/components/dashboard/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

export default function MigrationDetailLoading() {
  return (
    <PageShell className="max-w-4xl">
      <h1 className="sr-only">Migration details</h1>
      <span className="sr-only" role="status">
        Loading migration details
      </span>
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <div className="flex items-start justify-between gap-4">
          <PageHeaderSkeleton />
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-md border bg-card p-5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <div className="grid gap-3 pt-2 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, s) => (
              <div key={s} className="space-y-2 rounded-md border p-4">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-14" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </PageShell>
  );
}
