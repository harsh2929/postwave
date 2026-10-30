// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared period-over-period delta chip: an up/down/flat arrow + the signed
// label from computeDelta, colored with semantic tokens (success/destructive)
// so it reads correctly in light + dark. `goodDirection` lets a "lower is
// better" metric (bounces, unsubscribes) color a rise as bad — the arrow always
// shows the actual direction, only the color reflects good/bad. Extracted from
// the dashboard home so home + analytics render one identical affordance.
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import type { MetricDelta } from "@/lib/dashboard-insights";
import { cn } from "@/lib/utils";

export function DeltaBadge({
  delta,
  goodDirection = "up",
  className,
}: {
  delta: MetricDelta;
  /** Which direction is a good outcome for this metric. */
  goodDirection?: "up" | "down";
  className?: string;
}) {
  if (delta.direction === "flat") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-0.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <Minus className="h-3 w-3" aria-hidden />
        {delta.label}
        <span className="sr-only"> versus the previous period</span>
      </span>
    );
  }
  const up = delta.direction === "up";
  const good = delta.direction === goodDirection;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        good ? "text-success" : "text-destructive",
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {delta.label}
      <span className="sr-only"> versus the previous period</span>
    </span>
  );
}
