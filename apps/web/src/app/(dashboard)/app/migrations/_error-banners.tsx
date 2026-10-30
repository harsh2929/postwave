// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration cancellation recovery shown on the detail route.
"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function CancelledBanner({
  importedSubscribers,
  onView,
  onResume,
  onRollback,
}: {
  importedSubscribers: number;
  onView: () => void;
  onResume: () => void;
  onRollback: () => void;
}) {
  return (
    <Alert>
      <AlertTitle>Import cancelled</AlertTitle>
      <AlertDescription>
        We&apos;ve kept the {importedSubscribers.toLocaleString()} subscriber
        {importedSubscribers === 1 ? "" : "s"} we imported so far.
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={onView}>
            View imported
          </Button>
          <Button size="sm" variant="ghost" onClick={onResume}>
            Resume
          </Button>
          <Button size="sm" variant="destructive" onClick={onRollback}>
            Roll back
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
