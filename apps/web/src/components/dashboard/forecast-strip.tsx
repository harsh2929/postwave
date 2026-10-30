// SPDX-License-Identifier: AGPL-3.0-only
//
// ForecastStrip — the ambient "at this rate you'll cross N subscribers around
// <date>" line under the home performance tiles (parity with desktop
// components/dashboard/ForecastStrip.tsx).
//
// Fed by the `sparklines.subscribers` series and `subscribers_total` that the
// home page's GET /api/v1/dashboard/stats already returns — no new request.
// Renders NOTHING when forecastNextMilestone declines to predict, rather than
// a hedged empty state: a projection that is not supported by the evidence is
// not a smaller projection, it is no projection.
"use client";

import { ArrowUpRight } from "lucide-react";

import { forecastNextMilestone } from "@/lib/dashboard-forecast";

export function ForecastStrip({
  sparkline,
  currentTotal,
  today,
}: {
  /** Daily new-subscriber counts (stats.sparklines?.subscribers). */
  sparkline: readonly unknown[] | null | undefined;
  /** stats.subscribers_total. */
  currentTotal: unknown;
  /** Injectable clock; defaults to now. */
  today?: Date;
}) {
  const forecast = forecastNextMilestone(sparkline, currentTotal, today);
  if (!forecast) return null;
  const when = forecast.crossesAt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const perDay =
    forecast.projectedDailyAdds >= 10
      ? Math.round(forecast.projectedDailyAdds).toLocaleString()
      : forecast.projectedDailyAdds.toFixed(1);
  return (
    <aside
      role="note"
      aria-label="Subscriber forecast"
      data-testid="subscriber-forecast"
      className="flex flex-wrap items-start gap-3 rounded-[12px_17px_12px_17px] border border-mw-ink bg-mw-blue px-4 py-3 text-sm text-white shadow-[3px_4px_0_var(--mw-ink)]"
    >
      <span
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 rotate-[-2deg] items-center justify-center rounded-[6px_9px_6px_9px] bg-mw-yellow text-mw-ink"
      >
        <ArrowUpRight className="h-4 w-4" />
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-hand block text-sm font-semibold text-mw-yellow">
          Growth trajectory
        </span>
        <span>
          At this rate, you&apos;ll cross{" "}
          <strong className="tabular-nums">
            {forecast.target.toLocaleString()}
          </strong>{" "}
          subscribers around <strong>{when}</strong>.
        </span>
        <span className="mt-1 block text-xs text-white/70">
          Projection · a linear trend of about {perDay} new subscribers a day
          over the last {Array.isArray(sparkline) ? sparkline.length : 0} days.
          Directional, not a guarantee.
        </span>
      </p>
    </aside>
  );
}
