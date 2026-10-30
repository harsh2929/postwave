// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Grouped engagement breakdown (desktop GroupByMenu + GroupedTimeseriesChart):
// pick a dimension, then read one line per campaign / recipient domain for
// the chosen metric and window —
//   GET /api/v1/analytics/timeseries?group_by=&metric=&days=
// The dimension lives in the URL (?group_by=) so "Copy link" reproduces it.
//
// Honest states, same contract as desktop:
//   * 404 / 501 / `unsupported_dimension` → "not available on this server";
//   * any other failure → the server's sentence + Retry (never an empty chart
//     standing in for zero events);
//   * all-zero → "No <metric> recorded in the last N days".

import { useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { rangeDays } from "@/lib/analytics-format";
import {
  GROUPED_DAY_OPTIONS,
  GROUPED_METRIC_LABELS,
  GROUPED_METRICS,
  getGroupedTimeseries,
  groupedSeriesLabels,
  seriesTotal,
  type GroupedDays,
  type GroupedMetric,
  type GroupedSeries,
} from "@/lib/analytics-grouped-api";
import type { GroupedDimension } from "@/lib/analytics-view-params";
import { buildLinePath, niceScale } from "@/lib/chart-scale";
import { base, STALE, type RoleKey } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import { ChartActions } from "./chart-actions";
import { GroupByMenu, type GroupByDimension } from "./group-by-menu";
import { useAnalyticsView, useScrollToTarget } from "./use-analytics-view";

export const GROUPED_CHART_ID = "grouped-breakdown";

const DIMENSION_NOUN: Record<GroupedDimension, string> = {
  campaign: "campaign",
  domain: "recipient domain",
};

const SERIES_COLORS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
];

/** The Group-by selection the chart can draw; null keeps the aggregate view. */
export function chartDimension(
  value: GroupByDimension,
): GroupedDimension | null {
  return value === "campaign" || value === "domain" ? value : null;
}

function nearestDays(range: string): GroupedDays {
  const days = rangeDays(range);
  return days === 7 || days === 90 ? days : 30;
}

/** Endpoint absent on this build, or the dimension refused by contract. */
function isUnsupported(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 404 ||
      error.status === 501 ||
      error.code === "unsupported_dimension")
  );
}

function seriesColor(series: GroupedSeries, index: number): string {
  return series.key === "other"
    ? "hsl(var(--muted-foreground))"
    : `hsl(var(${SERIES_COLORS[index % SERIES_COLORS.length]}))`;
}

const PLOT_W = 640;
const PLOT_H = 200;

function GroupedLines({
  series,
  labels,
  ariaLabel,
}: {
  series: GroupedSeries[];
  labels: string[];
  ariaLabel: string;
}) {
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const scale = niceScale(0, Math.max(0, ...all), 4);
  const box = { width: PLOT_W, height: PLOT_H, pad: 4, domain: scale };
  const dates = series[0]?.points.map((p) => p.date) ?? [];
  return (
    <figure className="space-y-2" aria-label={ariaLabel}>
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        preserveAspectRatio="none"
        className="h-auto w-full"
        style={{ height: PLOT_H }}
      >
        {series.map((s, index) => (
          <path
            key={s.key}
            d={buildLinePath(
              s.points.map((p) => p.value),
              box,
            )}
            fill="none"
            stroke={seriesColor(s, index)}
            strokeWidth={s.key === "other" ? 1.5 : 2}
            strokeDasharray={s.key === "other" ? "4 3" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {dates.length >= 2 ? (
        <figcaption className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{dates[0]}</span>
          <span>{dates[dates.length - 1]}</span>
        </figcaption>
      ) : null}
      <ul
        aria-label="Totals by group"
        className="grid gap-1 text-xs sm:grid-cols-2"
      >
        {series.map((s, index) => (
          <li
            key={s.key}
            data-testid="grouped-series"
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border bg-card px-2 py-1"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: seriesColor(s, index) }}
              />
              <span className="truncate" title={labels[index]}>
                {labels[index]}
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {seriesTotal(s).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function ChipGroup<T extends string | number>({
  label,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  format: (option: T) => string;
  onChange: (option: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <Button
          key={String(option)}
          type="button"
          size="sm"
          variant={option === value ? "secondary" : "ghost"}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {format(option)}
        </Button>
      ))}
    </div>
  );
}

export function GroupedBreakdownCard({
  tenantId,
  role,
  userId = "unverified",
  range,
}: {
  tenantId: string;
  role: RoleKey;
  userId?: string;
  range: string;
}) {
  const { view, mounted, setParam } = useAnalyticsView();
  const metric: GroupedMetric = view.breakdownMetric ?? "opens";
  const days: GroupedDays = view.breakdownDays ?? nearestDays(range);
  const cardRef = useRef<HTMLDivElement>(null);
  const focused = view.focus === GROUPED_CHART_ID;
  useScrollToTarget(focused, cardRef);

  const selection: GroupByDimension = view.groupBy ?? "none";
  const dimension = chartDimension(selection);
  const ready = tenantId !== "anon" && role !== null;

  const query = useQuery({
    queryKey: [
      ...base("analytics-grouped-timeseries", tenantId, role),
      userId,
      dimension,
      metric,
      days,
    ],
    queryFn: ({ signal }) =>
      getGroupedTimeseries(
        { groupBy: dimension as GroupedDimension, metric, days },
        { signal },
      ),
    enabled: ready && dimension !== null,
    staleTime: STALE.dashboard,
  });

  const series = Array.isArray(query.data?.series) ? query.data.series : [];
  const total = series.reduce((sum, s) => sum + seriesTotal(s), 0);
  const metricLabel = GROUPED_METRIC_LABELS[metric];

  let body: ReactNode;
  if (dimension === null) {
    body = (
      <p className="text-sm text-muted-foreground">
        Choose Campaign or Domain to split {metricLabel.toLowerCase()} into one
        line per group.
      </p>
    );
  } else if (query.isPending) {
    body = <Skeleton className="h-52 w-full" />;
  } else if (query.isError && isUnsupported(query.error)) {
    body = (
      <p className="text-sm text-muted-foreground">
        Grouped time series by {DIMENSION_NOUN[dimension]} aren&apos;t available
        on this server.
      </p>
    );
  } else if (query.isError) {
    body = (
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-3 text-sm text-warning-emphasis sm:flex-row sm:items-center sm:justify-between"
      >
        <span>
          Couldn&apos;t load the {metricLabel.toLowerCase()} breakdown:{" "}
          {apiErrorMessage(query.error, "the request failed.")}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  } else if (series.length === 0 || total === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        No {metricLabel.toLowerCase()} recorded in the last {days} days.
      </p>
    );
  } else {
    body = (
      <GroupedLines
        series={series}
        labels={groupedSeriesLabels(series)}
        ariaLabel={`${metricLabel} by ${DIMENSION_NOUN[dimension]}, last ${days} days`}
      />
    );
  }

  return (
    <Card
      ref={cardRef}
      data-analytics-focus={GROUPED_CHART_ID}
      data-focused={focused || undefined}
      className={cn(focused && "ring-2 ring-primary/60")}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <CardTitle>
              {dimension
                ? `${metricLabel} by ${DIMENSION_NOUN[dimension]}`
                : "Engagement breakdown"}
            </CardTitle>
            <CardDescription>
              {dimension
                ? `One line per ${DIMENSION_NOUN[dimension]}, last ${days} days — the top 10 by volume, the rest rolled into “Other”.`
                : "Break engagement down by campaign or recipient domain."}
            </CardDescription>
          </div>
          <ChartActions
            chartId={GROUPED_CHART_ID}
            chartName="Engagement breakdown"
            getChartElement={() => cardRef.current}
            rangeLabel={`${days}d`}
          />
        </div>
        <div className="flex flex-wrap items-start gap-3 pt-2">
          <GroupByMenu
            value={selection}
            disabled={!mounted}
            onChange={(next) => setParam("group_by", chartDimension(next))}
          />
          {dimension ? (
            <>
              <ChipGroup
                label="Metric"
                options={GROUPED_METRICS}
                value={metric}
                format={(m) => GROUPED_METRIC_LABELS[m]}
                onChange={(value) => setParam("breakdown_metric", value)}
              />
              <ChipGroup
                label="Window"
                options={GROUPED_DAY_OPTIONS}
                value={days}
                format={(d) => `${d}d`}
                onChange={(value) => setParam("breakdown_days", String(value))}
              />
            </>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
