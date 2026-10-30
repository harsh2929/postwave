// SPDX-License-Identifier: AGPL-3.0-only
//
// Reputation trend sparkline (INBOX-031). Renders the tenant's SenderScore
// history as a small inline SVG so the point-in-time reputation card gains a
// "where is this heading" dimension. Snapshots accrue one-per-fetch, so a fresh
// tenant has too few usable points to draw — that "collecting data" state is a
// first-class outcome, not an error.

import { TrendingDown, TrendingUp, Minus } from "lucide-react";

import type { ReputationSnapshot } from "@/lib/inbox-reality-types";
import { cn } from "@/lib/utils";

// -1 is the service's "source unavailable" sentinel; only 0-100 are real.
function usableScore(snap: ReputationSnapshot): boolean {
  return snap.sender_score >= 0 && snap.sender_score <= 100;
}

const WIDTH = 220;
const HEIGHT = 44;
const PAD = 3;

/**
 * SenderScore trend for the reputation card. Draws a sparkline over the usable
 * (0-100) SenderScore points and labels the net change across the window. With
 * fewer than two usable points it shows a "collecting data" hint instead — the
 * series only accrues as the dashboard is used.
 */
export function ReputationTrend({
  snapshots,
}: {
  snapshots: ReputationSnapshot[];
}) {
  // Oldest-first already (service ORDER BY checked_at ASC), but don't trust it.
  const points = snapshots
    .filter(usableScore)
    .slice()
    .sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));

  if (points.length < 2) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2.5">
        <p className="text-xs font-medium">SenderScore trend</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Collecting data — the trend appears once at least two reputation
          checks have been recorded. Use “Re-check” above to add a point.
        </p>
      </div>
    );
  }

  const scores = points.map((p) => p.sender_score);
  const first = scores[0];
  const last = scores[scores.length - 1];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const delta = last - first;

  // Normalize into the SVG box. A flat series (min===max) has no range, so
  // anchor every point to the vertical middle (frac 0.5) rather than dividing
  // by a fabricated span of 1 — which would pin the line to the bottom edge.
  const span = max - min;
  const stepX =
    points.length > 1 ? (WIDTH - PAD * 2) / (points.length - 1) : 0;
  const coords = scores.map((s, i) => {
    const x = PAD + i * stepX;
    const frac = span === 0 ? 0.5 : (s - min) / span;
    const y = PAD + (HEIGHT - PAD * 2) * (1 - frac);
    return { x, y };
  });
  const linePath = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    `${linePath} L${coords[coords.length - 1].x.toFixed(1)},${HEIGHT - PAD} ` +
    `L${coords[0].x.toFixed(1)},${HEIGHT - PAD} Z`;

  const trend =
    delta > 0
      ? { Icon: TrendingUp, label: `+${delta}`, cls: "text-emerald-600 dark:text-emerald-400" }
      : delta < 0
        ? { Icon: TrendingDown, label: `${delta}`, cls: "text-destructive" }
        : { Icon: Minus, label: "0", cls: "text-muted-foreground" };
  const last30 = points[points.length - 1];

  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">SenderScore trend</p>
          <p className="text-[11px] text-muted-foreground">
            {points.length} checks · range {min}–{max}
          </p>
        </div>
        <div className={cn("flex items-center gap-1 text-xs font-medium", trend.cls)}>
          <trend.Icon className="h-3.5 w-3.5" aria-hidden />
          <span>{trend.label}</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-2 h-11 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={`SenderScore trend: ${first} to ${last} over ${points.length} checks (net ${trend.label}).`}
      >
        <path d={areaPath} className="fill-primary/10" stroke="none" />
        <path
          d={linePath}
          className="stroke-primary"
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={coords[coords.length - 1].x}
          cy={coords[coords.length - 1].y}
          r={2.5}
          className="fill-primary"
        />
      </svg>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Latest {last}/100
        {last30.checked_at
          ? ` · ${new Date(last30.checked_at).toLocaleDateString(undefined, {
              dateStyle: "medium",
            })}`
          : ""}
      </p>
    </div>
  );
}
