// SPDX-License-Identifier: AGPL-3.0-only
//
"use client";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

export default function SegmentsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ScopedRouteError
      title="Couldn't load your segments"
      description="The segments service is temporarily unavailable. Subscriber records and saved segment rules have not been changed."
      error={error}
      reset={reset}
      backHref="/app/subscribers"
      backLabel="Back to subscribers"
    />
  );
}
