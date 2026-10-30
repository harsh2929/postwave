// SPDX-License-Identifier: AGPL-3.0-only
//
// Compact stat card for the affiliates list + detail. Mirrors the visual
// idiom used elsewhere in the dashboard (Inbox Reality / Billing) so we
// don't introduce a new component family for one feature.

import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";

export interface StatsCardProps {
  label: string;
  value: ReactNode;
  /** Subtext under the value (e.g. "last 30 days"). */
  hint?: string;
  /** Optional small trend indicator, e.g. "+12%". */
  trend?: { delta: string; positive: boolean };
}

export function StatsCard({ label, value, hint, trend }: StatsCardProps) {
  return (
    <Card>
      <CardContent className="py-5">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          {trend ? (
            <span
              className={`text-xs font-medium tabular-nums ${
                trend.positive ? "text-success" : "text-destructive"
              }`}
            >
              {trend.delta}
            </span>
          ) : null}
        </div>
        {hint ? (
          <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
