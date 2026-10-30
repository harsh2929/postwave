// SPDX-License-Identifier: AGPL-3.0-only
import { Skeleton } from "@/components/ui/skeleton";

export default function SequenceTemplatesLoading() {
  return (
    <div
      role="status"
      aria-label="Loading sequence templates"
      className="mx-auto w-full min-w-0 max-w-6xl space-y-7 p-4 sm:p-6 lg:p-8"
    >
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-44 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
