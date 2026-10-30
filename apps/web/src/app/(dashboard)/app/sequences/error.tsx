// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

export default function SequencesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ScopedRouteError
      title="Couldn't load sequences"
      description="The sequence workspace is temporarily unavailable. Your saved sequences have not been changed."
      error={error}
      reset={reset}
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
