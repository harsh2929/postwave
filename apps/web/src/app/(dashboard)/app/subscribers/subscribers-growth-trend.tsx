// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Compact audience-growth trend for the subscribers list header (SUB-042).
// A pure-SVG sparkline of total contacts over a selectable window plus the
// net delta, sourced from GET /subscribers/growth.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useDirectoryIdentity } from "@/components/subscribers/directory-context";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { base } from "@/lib/query-keys";
import { getSubscriberGrowth } from "@/lib/subscriber-growth-api";

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
] as const;

export function SubscribersGrowthTrend() {
  const [days, setDays] = useState<number>(90);
  // Tenant/role-scoped like every other audience read, so a subscriber write
  // can refresh it (subscribers-refresh.ts) and a workspace switch can never
  // show the previous workspace's trend.
  const identity = useDirectoryIdentity();
  const query = useQuery({
    queryKey: [
      ...base("subscriber-growth", identity.tenantId, identity.role),
      days,
    ],
    queryFn: () => getSubscriberGrowth(days),
    enabled: identity.ready,
    staleTime: 5 * 60_000,
  });

  const series = Array.isArray(query.data?.series) ? query.data?.series : [];
  const totals = series.map((p) => p.total);
  const min = Math.min(...(totals.length ? totals : [0]));
  const max = Math.max(...(totals.length ? totals : [1]));
  const range = max - min || 1;
  const w = 240;
  const h = 40;
  const stepX = series.length > 1 ? w / (series.length - 1) : 0;
  const path = series
    .map((p, i) => {
      const x = i * stepX;
      const y = h - ((p.total - min) / range) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const delta = query.data?.delta ?? 0;
  const deltaPct = query.data?.delta_pct ?? 0;
  const deltaColor =
    delta > 0
      ? "text-success"
      : delta < 0
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Audience growth
          </div>
          {query.isPending ? (
            <Skeleton className="mt-1 h-6 w-24" />
          ) : query.error ? (
            <div className="mt-1 text-sm text-muted-foreground">
              Trend unavailable.
            </div>
          ) : series.length < 2 ? (
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Collecting daily history. Growth appears after two daily
              snapshots.
            </p>
          ) : (
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {delta > 0 ? "+" : ""}
                {delta.toLocaleString()}
              </span>
              <span className={`text-xs tabular-nums ${deltaColor}`}>
                {series[0].total > 0
                  ? `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%`
                  : "No starting audience"}
              </span>
            </div>
          )}
        </div>
        <Select
          aria-label="Growth window"
          className="w-32"
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {WINDOWS.map((wnd) => (
            <option key={wnd.days} value={wnd.days}>
              {wnd.label}
            </option>
          ))}
        </Select>
      </div>
      {query.isPending ? (
        <Skeleton className="mt-3 h-10 w-full" />
      ) : series.length > 1 ? (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="mt-3 h-10 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Total contacts over the last ${days} days`}
        >
          <path
            d={path}
            fill="none"
            stroke="hsl(var(--chart-1))"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
    </div>
  );
}
