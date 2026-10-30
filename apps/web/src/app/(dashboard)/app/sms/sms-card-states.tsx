// SPDX-License-Identifier: AGPL-3.0-only

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Shared in-card load-error / retry affordance. Rendered in place of an empty
 * state when the SMS data query failed, so a failed load never masquerades as
 * an empty ("No X yet") or first-run tenant (audit SMS-012).
 */
export function CardLoadError({
  message = "This section could not be loaded.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center text-sm">
      <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
      <p className="text-destructive">{message}</p>
      {onRetry ? (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
