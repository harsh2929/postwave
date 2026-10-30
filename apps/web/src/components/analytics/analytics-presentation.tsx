// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Rates vs prior period" — the Analytics page's presentation controls
// (desktop AnalyticsPresentation + AnalyticsTopPanels):
//
//   * Compare with prior period (desktop `vsPrevious`): one toggle that shows
//     or hides every prior-period delta on these tiles. Off is carried in the
//     URL as ?compare=off so a shared link keeps the reader's choice.
//   * Metric focus (desktop parseAnalyticsHash `metric`): /app/analytics?
//     metric=opens&range=7d — the drill-down target for the home tiles and the
//     anomaly list — scrolls to and highlights that KPI. Clicking a tile
//     focuses it (and so makes the link shareable); "Clear focus" drops it.
//   * Copy link (desktop ChartActions) for the card, via ?focus=key-rates.
//
// Everything renders from the /api/v1/dashboard/stats payload the page already
// fetched (compare=true is the server default, so `previous` is present) —
// no second request, and a missing prior window is said, not faked as 0.

import { useRef } from "react";
import { Crosshair, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { DeltaBadge } from "@/components/dashboard/delta-badge";
import type { DashboardStats } from "@/lib/analytics-api";
import {
  computeEngagementRates,
  formatRate,
  rangeDays,
} from "@/lib/analytics-format";
import type { FocusMetric } from "@/lib/analytics-view-params";
import { computeDelta, type MetricDelta } from "@/lib/dashboard-insights";
import { cn } from "@/lib/utils";

import { ChartActions } from "./chart-actions";
import { useAnalyticsView, useScrollToTarget } from "./use-analytics-view";

export const KEY_RATES_CHART_ID = "key-rates";

interface RateTile {
  metric: FocusMetric;
  label: string;
  value: string;
  hint: string;
  /** null = no prior window to compare against. */
  delta: MetricDelta | null;
  goodDirection: "up" | "down";
}

function ratio(num: number | undefined, den: number | undefined): number | null {
  if (typeof num !== "number" || typeof den !== "number") return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

/**
 * Change between two rates in percentage points ("+1.2 pts"). A relative
 * percentage of a percentage misleads ("+50%" for 2% → 3%), so rates compare
 * in points.
 */
export function pointsDelta(
  current: number | null,
  previous: number | null,
): MetricDelta | null {
  if (current === null || previous === null) return null;
  const points = (current - previous) * 100;
  const rounded = Math.round(points * 10) / 10;
  const direction = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  const label =
    direction === "flat"
      ? "0 pts"
      : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)} pts`;
  return { direction, pct: null, absolute: rounded, label };
}

export function buildRateTiles(stats: DashboardStats): RateTile[] {
  const rates = computeEngagementRates(stats);
  const prev = stats.previous ?? null;
  const added = stats.subscribers_added_30d;
  return [
    {
      metric: "subscribers",
      label: "Subscribers",
      value: stats.subscribers_total.toLocaleString(),
      hint: `${added >= 0 ? "+" : ""}${added.toLocaleString()} added`,
      delta:
        prev && typeof prev.subscribers_added === "number"
          ? computeDelta(added, prev.subscribers_added)
          : null,
      goodDirection: "up",
    },
    {
      metric: "opens",
      label: "Open rate",
      value: formatRate(rates.openRate),
      hint: `${stats.opens_total_30d.toLocaleString()} opens`,
      delta: pointsDelta(
        rates.openRate,
        ratio(prev?.unique_opens, prev?.unique_delivered),
      ),
      goodDirection: "up",
    },
    {
      metric: "clicks",
      label: "Click rate",
      value: formatRate(rates.clickRate),
      hint: `${stats.clicks_total_30d.toLocaleString()} clicks`,
      delta: pointsDelta(
        rates.clickRate,
        ratio(prev?.unique_clicks, prev?.unique_delivered),
      ),
      goodDirection: "up",
    },
    {
      metric: "bounces",
      label: "Bounce rate",
      value: formatRate(rates.bounceRate),
      hint: `${stats.bounces_total_30d.toLocaleString()} bounces`,
      delta: pointsDelta(
        rates.bounceRate,
        ratio(prev?.unique_bounces, prev?.unique_sent),
      ),
      goodDirection: "down",
    },
    {
      metric: "unsubscribes",
      label: "Unsub rate",
      value: formatRate(rates.unsubRate),
      hint: `${stats.subscribers_unsubbed_30d.toLocaleString()} unsubscribed`,
      delta: pointsDelta(
        rates.unsubRate,
        ratio(prev?.subscribers_unsubbed, prev?.unique_delivered),
      ),
      goodDirection: "down",
    },
  ];
}

export function AnalyticsPresentation({
  stats,
  range,
  loading = false,
}: {
  stats: DashboardStats | null;
  range: string;
  loading?: boolean;
}) {
  const { view, mounted, setParam } = useAnalyticsView();
  const cardRef = useRef<HTMLDivElement>(null);
  const focusedTileRef = useRef<HTMLButtonElement>(null);
  const days = rangeDays(range);

  const tiles = stats ? buildRateTiles(stats) : [];
  const focusedTile = tiles.find((t) => t.metric === view.metric) ?? null;
  useScrollToTarget(focusedTile !== null, focusedTileRef);
  useScrollToTarget(
    focusedTile === null && stats !== null && view.focus === KEY_RATES_CHART_ID,
    cardRef,
  );

  if (!stats) {
    return loading ? <Skeleton className="h-40 w-full" /> : null;
  }

  const cardFocused = view.focus === KEY_RATES_CHART_ID;

  return (
    <Card
      ref={cardRef}
      data-analytics-focus={KEY_RATES_CHART_ID}
      data-focused={cardFocused || undefined}
      className={cn(cardFocused && "ring-2 ring-primary/40")}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>Rates vs prior period</CardTitle>
            <CardDescription>
              Last {days} days
              {view.compare
                ? `, compared with the ${days} days before.`
                : ". Prior-period comparison is hidden."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
              <Checkbox
                checked={view.compare}
                disabled={!mounted}
                onChange={(event) =>
                  setParam("compare", event.target.checked ? null : "off")
                }
              />
              Compare with prior period
            </label>
            {focusedTile ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setParam("metric", null)}
              >
                <X className="h-4 w-4" aria-hidden />
                Clear focus
              </Button>
            ) : null}
            <ChartActions
              chartId={KEY_RATES_CHART_ID}
              chartName="Rates vs prior period"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {view.compare && !stats.previous ? (
          <p className="mb-3 text-xs text-muted-foreground">
            No prior-period figures were returned for this window, so there is
            nothing to compare against.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {tiles.map((tile) => {
            const focused = tile.metric === view.metric;
            return (
              <button
                key={tile.metric}
                ref={focused ? focusedTileRef : undefined}
                type="button"
                data-testid="analytics-rate-tile"
                data-metric={tile.metric}
                aria-pressed={focused}
                aria-label={`${tile.label}: ${tile.value}${
                  view.compare && tile.delta
                    ? `, ${tile.delta.label} versus the previous period`
                    : ""
                }${focused ? " (focused)" : ""}`}
                onClick={() =>
                  setParam("metric", focused ? null : tile.metric)
                }
                className={cn(
                  "flex min-w-0 flex-col rounded-md border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  focused && "border-primary ring-2 ring-primary/40",
                )}
              >
                <span className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase text-muted-foreground">
                  {tile.label}
                  {focused ? (
                    <Badge variant="info" className="gap-1 normal-case">
                      <Crosshair className="h-3 w-3" aria-hidden />
                      Focused
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-1 text-lg font-semibold tabular-nums">
                  {tile.value}
                </span>
                <span className="flex flex-wrap items-center justify-between gap-x-2 text-xs text-muted-foreground">
                  <span className="truncate">{tile.hint}</span>
                  {view.compare && tile.delta ? (
                    <DeltaBadge
                      delta={tile.delta}
                      goodDirection={tile.goodDirection}
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
