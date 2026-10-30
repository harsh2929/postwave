// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// One fidelity badge for the whole sequences cluster (SEQ-051). Replaces the
// two drifting copies (the hub's `FidelityBadge` and the detail rail's
// `FidelityChip`) with a single component that carries a legend tooltip
// explaining the 0–100 score and its green/amber/red thresholds.

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fidelityColor } from "@/lib/voice-types";

const COLOR_CLASS: Record<"green" | "amber" | "red", string> = {
  green: "bg-success-subtle text-success-emphasis",
  amber: "bg-warning-subtle text-warning-emphasis",
  red: "bg-destructive/10 text-destructive-emphasis",
};

export const FIDELITY_LEGEND =
  "Voice fidelity (0–100): how closely this reads like your voice profile. 80+ strong, 60–79 fair, under 60 weak.";

export function FidelityBadge({
  score,
  size = "md",
  withTooltip = true,
}: {
  score: number;
  size?: "sm" | "md";
  withTooltip?: boolean;
}) {
  const badge = (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-semibold tabular-nums",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs",
        COLOR_CLASS[fidelityColor(score)],
      )}
    >
      {score}
    </span>
  );
  if (!withTooltip) return badge;
  return (
    <Tooltip
      label={FIDELITY_LEGEND}
      className="left-0 w-64 max-w-[calc(100vw-2rem)] translate-x-0 whitespace-normal [&[aria-hidden=true]]:hidden"
    >
      {badge}
    </Tooltip>
  );
}
