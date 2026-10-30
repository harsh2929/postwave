"use client";

import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import {
  FidelityBadge,
  FIDELITY_LEGEND,
} from "@/components/sequences/fidelity-badge";
import { type SequenceEmail } from "@/lib/voice-types";

// Kept as a thin re-export so existing call sites (the detail rail) stay stable
// while all fidelity chrome flows through the single shared badge (SEQ-051).
export function FidelityChip({ score }: { score: number }) {
  return <FidelityBadge score={score} size="sm" withTooltip={false} />;
}

export function FidelityBreakdown({ email }: { email: SequenceEmail }) {
  const [open, setOpen] = useState(false);
  const hasBreakdown = email.fidelityBreakdownPresent === true;
  const b = email.fidelityBreakdown;
  const rows: { key: keyof typeof b; label: string }[] = [
    { key: "embedding", label: "Embedding similarity" },
    { key: "stylistic", label: "Stylistic features" },
    { key: "vocab", label: "Vocabulary alignment" },
    { key: "structural", label: "Structural patterns" },
  ];
  return (
    <div className="border-t bg-card">
      <button
        type="button"
        onClick={() => {
          if (hasBreakdown) setOpen((value) => !value);
        }}
        aria-expanded={hasBreakdown ? open : undefined}
        disabled={!hasBreakdown}
        className="flex min-h-11 w-full items-center justify-between px-4 py-2 text-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Tooltip
          label={FIDELITY_LEGEND}
          className="left-0 w-64 max-w-[calc(100vw-2rem)] translate-x-0 whitespace-normal [&[aria-hidden=true]]:hidden"
        >
          <span className="font-medium cursor-help">
            Voice fidelity - {email.fidelity}/100
          </span>
        </Tooltip>
        <span className="text-xs text-muted-foreground">
          {hasBreakdown
            ? open
              ? "Hide breakdown"
              : "Show breakdown"
            : "Component scores unavailable"}
        </span>
      </button>
      {open && (
        <Card className="m-4 mt-0">
          <CardContent className="p-4 space-y-2">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-3">
                <span className="text-sm w-48 text-muted-foreground">
                  {row.label}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-foreground"
                    style={{
                      width: `${Math.min(100, Math.max(0, b[row.key]))}%`,
                    }}
                  />
                </div>
                <span className="text-xs tabular-nums w-10 text-right">
                  {Math.round(b[row.key])}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
