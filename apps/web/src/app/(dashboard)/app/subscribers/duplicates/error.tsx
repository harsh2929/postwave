// SPDX-License-Identifier: AGPL-3.0-only
//
"use client";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

export default function DuplicatesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ScopedRouteError
      title="Couldn't load duplicates"
      description="Duplicate detection is temporarily unavailable. No subscriber records have been merged or changed."
      error={error}
      reset={reset}
      backHref="/app/subscribers"
      backLabel="Back to subscribers"
    />
  );
}
