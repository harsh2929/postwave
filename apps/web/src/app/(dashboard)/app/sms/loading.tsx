// SPDX-License-Identifier: AGPL-3.0-only
//
// Route-segment skeleton shaped to the SMS surface (header + tab bar + a
// couple of form-heavy card silhouettes) rather than the generic
// header/stat/table fallback, so the cold load doesn't flash a mismatched
// layout or the literal word "loading" (audit SMS-015).
import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { PageShell } from "@/components/dashboard/page-shell";
import { Skeleton } from "@/components/ui/skeleton";

function CardSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-3 rounded-md border bg-card p-5">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className="space-y-2 pt-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function SmsLoading() {
  return (
    <PageShell className="max-w-6xl">
      <div className="flex items-center justify-between gap-3">
        <PageHeaderSkeleton />
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-9 w-full max-w-md" />
      <div className="grid gap-4 md:grid-cols-3">
        <CardSkeleton lines={3} />
        <div className="md:col-span-2">
          <CardSkeleton lines={3} />
        </div>
      </div>
      <CardSkeleton lines={5} />
    </PageShell>
  );
}
