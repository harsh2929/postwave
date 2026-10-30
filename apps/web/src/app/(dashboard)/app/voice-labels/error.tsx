// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ScopedRouteError } from "@/components/dashboard/scoped-route-error";

export default function VoiceLabelsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ScopedRouteError
      title="Couldn't load voice labels"
      description="Voice labels are temporarily unavailable. Your saved voice settings have not been changed."
      error={error}
      reset={reset}
      backHref="/app"
      backLabel="Back to dashboard"
    />
  );
}
