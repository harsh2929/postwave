// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import { FLOW_ACTIVATION_RELEASE_HOLD } from "@/lib/flows-api";

/** Active editor boundary: visible, non-actionable, and transport-free. */
export function FlowActivationStatus() {
  return (
    <div
      role="note"
      aria-label="Flow activation status"
      className="flex max-w-full flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2"
    >
      <Button type="button" size="sm" variant="outline" disabled>
        Activation unavailable
      </Button>
      <span className="max-w-xs text-xs leading-5 text-muted-foreground">
        {FLOW_ACTIVATION_RELEASE_HOLD}
      </span>
    </div>
  );
}
