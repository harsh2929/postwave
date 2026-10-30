// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

export default function SequenceTemplatesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ScopedRouteError
      title="Couldn't load sequence templates"
      description="The template library is temporarily unavailable. Your sequences and drafts have not been changed."
      error={error}
      reset={reset}
      backHref="/app/sequences"
      backLabel="Back to sequences"
    />
  );
}
