// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Engagement velocity + engagement funnel (desktop AnalyticsTrendPanels:
// EngagementVelocityPanel / EngagementFunnelPanel, view-model
// buildEngagementSeries / buildFunnelRows).
//
// Velocity plots daily opens and clicks from the /api/v1/dashboard/stats
// sparklines the page already fetched for the selected range, plus daily
// replies from GET /api/v1/replies/timeseries?days=<range>. The three lines
// share one date axis and one y-scale, so a series that covers fewer days is
// drawn over the days it covers — never stretched across the whole window.
//
// The funnel is Sent → Delivered → Opened → Clicked over the same window,
// each step capped by the one before it, with each step's conversion from
// the previous one.
//
// A replies failure costs the chart its replies line and says so with the
// server's sentence; it is never drawn as a flat line of zeros.

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import type { DashboardStats } from "@/lib/analytics-api";
import { formatRate, rangeDays } from "@/lib/analytics-format";
import {
  buildEngagementSeries,
  buildFunnelRows,
  engagementSeriesHasData,
  engagementTableRows,
  funnelEmailsSent,
  funnelStepConversions,
  linePathOnAxis,
  rangeDates,
  type EngagementPoint,
} from "@/lib/analytics-recent-campaigns";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { getReplyTimeseriesForDays } from "@/lib/replies-api";
import { cn } from "@/lib/utils";

import { ChartActions } from "./chart-actions";
import { useAnalyticsView, useScrollToTarget } from "./use-analytics-view";

export const ENGAGEMENT_VELOCITY_CHART_ID = "engagement-velocity";

const PLOT_W = 640;
const PLOT_H = 200;

interface TrendProps {
  stats: DashboardStats | null;
  range: string;
  tenantId: string;
  role: RoleKey;
}

function sparkline(stats: DashboardStats, key: string): number[] {
  const values = stats.sparklines?.[key];
  return Array.isArray(values)
    ? values.filter((value): value is number => typeof value === "number")
    : [];
}

const LINES: ReadonlyArray<{
  key: "opens" | "clicks" | "replies";
  label: string;
  colorVar: string;
}> = [
  { key: "opens", label: "Opens", colorVar: "--chart-1" },
  { key: "clicks", label: "Clicks", colorVar: "--chart-2" },
  { key: "replies", label: "Replies", colorVar: "--chart-3" },
];

function total(points: readonly EngagementPoint[]): number {
  return points.reduce((sum, point) => sum + point.count, 0);
}

export function EngagementVelocityPanel({
  stats,
  range,
  tenantId,
  role,
}: TrendProps) {
  const days = rangeDays(range);
  const identityReady = tenantId !== "" && tenantId !== "anon" && role !== null;
  const repliesQuery = useQuery({
    queryKey: [...base("analytics-replies-timeseries", tenantId, role), days],
    queryFn: ({ signal }) => getReplyTimeseriesForDays(days, { signal }),
    enabled: identityReady && stats !== null,
    staleTime: STALE.dashboard,
  });
  const { view } = useAnalyticsView();
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = view.focus === ENGAGEMENT_VELOCITY_CHART_ID;
  useScrollToTarget(focused && stats !== null, cardRef);

  if (!stats) return null;

  const series = buildEngagementSeries(
    days,
    sparkline(stats, "opens"),
    sparkline(stats, "clicks"),
    repliesQuery.isSuccess ? repliesQuery.data.points : null,
  );
  const axis = rangeDates(days);
  const hasData = engagementSeriesHasData(series);
  const max = Math.max(
    0,
    ...series.opens.map((p) => p.count),
    ...series.clicks.map((p) => p.count),
    ...series.replies.map((p) => p.count),
  );
  const box = { width: PLOT_W, height: PLOT_H, pad: 4, max };
  const drawn = LINES.filter((line) => series[line.key].length > 1);
  const rows = engagementTableRows(series);
  const repliesWindow = repliesQuery.isSuccess
    ? repliesQuery.data.window_days
    : null;

  return (
    <Card
      ref={cardRef}
      data-analytics-focus={ENGAGEMENT_VELOCITY_CHART_ID}
      data-focused={focused || undefined}
      className={cn("h-full", focused && "ring-2 ring-primary/60")}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>Engagement velocity</CardTitle>
            <CardDescription>
              Daily opens, clicks and replies across all campaigns · last {days}{" "}
              days
            </CardDescription>
          </div>
          <ChartActions
            chartId={ENGAGEMENT_VELOCITY_CHART_ID}
            chartName="Engagement velocity"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {repliesQuery.isError ? (
          <div
            role="alert"
            className="flex flex-col items-start justify-between gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis sm:flex-row sm:items-center"
          >
            <span>
              Replies couldn&apos;t be loaded, so the chart has no replies line.{" "}
              {apiErrorMessage(repliesQuery.error)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void repliesQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {repliesWindow !== null &&
        repliesWindow > 0 &&
        repliesWindow !== days ? (
          <p className="text-xs text-muted-foreground">
            The server returned replies for the last {repliesWindow} days, not{" "}
            {days}.
          </p>
        ) : null}
        {hasData ? (
          <>
            <ul
              className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
              aria-label="Series"
            >
              {LINES.map((line) => (
                <li
                  key={line.key}
                  data-testid="velocity-legend"
                  className="flex items-center gap-1.5"
                >
                  <span
                    aria-hidden
                    className="h-0.5 w-4 rounded-full"
                    style={{ background: `hsl(var(${line.colorVar}))` }}
                  />
                  {line.label}
                  <span className="tabular-nums text-muted-foreground">
                    {series[line.key].length > 0
                      ? total(series[line.key]).toLocaleString()
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
            <svg
              role="img"
              aria-label={`Daily ${drawn
                .map((line) => line.label.toLowerCase())
                .join(", ")} over the last ${days} days`}
              viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
              preserveAspectRatio="none"
              className="h-auto w-full"
              style={{ height: PLOT_H }}
            >
              {drawn.map((line) => (
                <path
                  key={line.key}
                  data-series={line.key}
                  d={linePathOnAxis(series[line.key], axis, box)}
                  fill="none"
                  stroke={`hsl(var(${line.colorVar}))`}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {axis.length >= 2 ? (
              <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
                <span>{axis[0]}</span>
                <span>{axis[axis.length - 1]}</span>
              </div>
            ) : null}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Show the daily figures
              </summary>
              <TableContainer
                aria-label="Engagement velocity daily figures"
                className="mt-2 max-h-64"
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Date (UTC)</TableHead>
                      <TableHead scope="col">Opens</TableHead>
                      <TableHead scope="col">Clicks</TableHead>
                      <TableHead scope="col">Replies</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.date}>
                        <TableHead scope="row" className="font-normal">
                          {row.date}
                        </TableHead>
                        <TableCell className="tabular-nums">
                          {row.opens === null
                            ? "—"
                            : row.opens.toLocaleString()}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {row.clicks === null
                            ? "—"
                            : row.clicks.toLocaleString()}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {row.replies === null
                            ? "—"
                            : row.replies.toLocaleString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </details>
          </>
        ) : repliesQuery.isPending && !repliesQuery.isError ? (
          <p className="text-sm text-muted-foreground" aria-busy="true">
            Loading daily engagement…
          </p>
        ) : (
          <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {repliesQuery.isError
              ? "No opens or clicks were recorded in this window."
              : "No engagement events in this window."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function EngagementFunnelPanel({
  stats,
  range,
}: Pick<TrendProps, "stats" | "range">) {
  if (!stats) return null;
  const days = rangeDays(range);
  const emailsSent = funnelEmailsSent(stats.unique_sent_30d);
  const delivered = funnelEmailsSent(stats.unique_delivered_30d);
  const opens = funnelEmailsSent(stats.unique_opens_30d);
  const clicks = funnelEmailsSent(stats.unique_clicks_30d);
  const countsAvailable =
    emailsSent !== null &&
    delivered !== null &&
    opens !== null &&
    clicks !== null;
  const rows = buildFunnelRows(
    emailsSent,
    emailsSent !== null && delivered !== null ? emailsSent - delivered : 0,
    opens ?? 0,
    clicks ?? 0,
  );
  const conversions = funnelStepConversions(rows);
  const top = rows[0]?.value ?? 0;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Engagement funnel</CardTitle>
        <CardDescription>
          Sent → Delivered → Opened → Clicked · last {days} days. Each
          percentage is against the step before it. Counts are unique
          recipients, so repeat opens and clicks do not widen the funnel.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!countsAvailable ? (
          <p className="rounded-md border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            Unique-recipient counts are unavailable for this window — the funnel
            appears once sent, delivered, open and click counts are recorded.
          </p>
        ) : (
          <ol className="space-y-3" aria-label="Engagement funnel">
            {rows.map((row, index) => {
              const conversion = conversions[index] ?? null;
              return (
                <li
                  key={row.label}
                  data-testid="funnel-step"
                  data-step={row.label}
                  className="space-y-1"
                >
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">{row.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {row.value.toLocaleString()}
                      {index > 0
                        ? ` · ${formatRate(conversion)} of ${rows[index - 1]?.label.toLowerCase()}`
                        : ""}
                    </span>
                  </div>
                  <span
                    aria-hidden
                    className="block h-2 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className="block h-full rounded-full bg-primary/80"
                      style={{
                        width: `${top > 0 ? (row.value / top) * 100 : 0}%`,
                      }}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Velocity + funnel side by side, the way desktop lays out the pair. */
export function EngagementTrendPanels(props: TrendProps) {
  if (!props.stats) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EngagementVelocityPanel {...props} />
      <EngagementFunnelPanel stats={props.stats} range={props.range} />
    </div>
  );
}
