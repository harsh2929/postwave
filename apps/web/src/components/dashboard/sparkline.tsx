// SPDX-License-Identifier: AGPL-3.0-only
//
// Tiny inline sparkline for the dashboard stat tiles. Pure SVG, no dependency,
// deterministic (no randomness) so it renders identically on server and client.
// Decorative: aria-hidden, since the numeric value + delta beside it carry the
// meaning for assistive tech.
import { cn } from "@/lib/utils";

export function Sparkline({
  data,
  className,
  width = 96,
  height = 28,
  strokeWidth = 1.5,
}: {
  data: readonly number[];
  className?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
}) {
  const points = data.filter((n) => Number.isFinite(n));
  if (points.length < 2) return null;

  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  // Inset vertically by half the stroke so the line never clips at the edges.
  const pad = strokeWidth;
  const usableH = height - pad * 2;

  const coords = points.map((value, i) => {
    const x = i * stepX;
    const y = pad + (1 - (value - min) / span) * usableH;
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1]!;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible text-primary/70", className)}
      aria-hidden
      role="presentation"
      preserveAspectRatio="none"
    >
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={strokeWidth * 1.4} fill="currentColor" />
    </svg>
  );
}
