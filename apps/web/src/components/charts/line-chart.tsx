// SPDX-License-Identifier: AGPL-3.0-only
//
// Reusable, dependency-free SVG line chart used by the analytics trend charts
// and the custom-report graph (ANL-012). Deterministic (SSR-safe), theme-tokened
// (all colors via `hsl(var(--chart-*))` so it works in light + dark), and
// responsive (the plot scales; axis labels are HTML so they never distort).
"use client";

import { useId } from "react";

import { buildAreaPath, buildLinePath, niceScale } from "@/lib/chart-scale";
import { cn } from "@/lib/utils";

export interface LineChartProps {
  values: number[];
  /** X-axis labels aligned to `values` (first + last are shown). */
  labels?: string[];
  height?: number;
  className?: string;
  /** CSS var name for the line/area color, e.g. "--chart-1". */
  colorVar?: string;
  ariaLabel: string;
  formatY?: (n: number) => string;
}

const PLOT_W = 640;

export function LineChart({
  values,
  labels,
  height = 180,
  className,
  colorVar = "--chart-1",
  ariaLabel,
  formatY = (n) => n.toLocaleString(),
}: LineChartProps) {
  const gradientId = useId();
  const points = values.filter((n) => Number.isFinite(n));
  if (points.length < 2) {
    return (
      <div
        className={cn(
          "flex h-40 items-center justify-center rounded-md border border-dashed bg-muted/20 text-xs text-muted-foreground",
          className,
        )}
      >
        Not enough data to chart yet.
      </div>
    );
  }

  const plotH = height;
  const pad = 4;
  const scale = niceScale(Math.min(...points), Math.max(...points), 4);
  const box = { width: PLOT_W, height: plotH, pad, domain: scale };
  const line = buildLinePath(points, box);
  const area = buildAreaPath(points, box);

  const span = scale.max - scale.min || 1;
  const yFor = (v: number) =>
    pad + (1 - (v - scale.min) / span) * (plotH - pad * 2);

  const color = `hsl(var(${colorVar}))`;

  return (
    <figure className={cn("space-y-1", className)} aria-label={ariaLabel}>
      <div className="flex gap-2">
        {/* Y-axis tick labels (HTML so they stay crisp/undistorted). */}
        <div
          className="flex flex-col justify-between py-0.5 text-right text-[10px] tabular-nums text-muted-foreground"
          style={{ height: plotH }}
          aria-hidden
        >
          {[...scale.ticks].reverse().map((t) => (
            <span key={t}>{formatY(t)}</span>
          ))}
        </div>
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${PLOT_W} ${plotH}`}
          preserveAspectRatio="none"
          className="h-auto w-full"
          style={{ height: plotH }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Horizontal gridlines at each nice tick. */}
          {scale.ticks.map((t) => (
            <line
              key={t}
              x1={0}
              x2={PLOT_W}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="hsl(var(--border))"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              shapeRendering="crispEdges"
            />
          ))}
          <path d={area} fill={`url(#${gradientId})`} stroke="none" />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      {labels && labels.length >= 2 ? (
        <figcaption className="flex justify-between pl-8 text-[10px] tabular-nums text-muted-foreground">
          <span>{labels[0]}</span>
          <span>{labels[labels.length - 1]}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
