/**
 * EngagementSparkline — SUB-094.
 *
 * Pure-SVG dual-line sparkline of per-day opens + clicks over the
 * trailing 90 days. No canvas, no chart lib, no new deps. Two lines on a
 * shared x-axis: opens in --pw-accent, clicks in --pw-success. Width is
 * parameterised so the same component can serve the subscriber slideover
 * and (future) the web full-page view.
 *
 * Extracted verbatim from the inline `Sparkline` previously living in
 * SubscriberDetailSlideover.tsx so the presentation logic is shared
 * rather than duplicated. The day-bucketing that feeds `points` lives in
 * lib/engagement-helpers.ts::bucketDailyEngagement.
 */

import type { ReactElement } from "react";

import type { EngagementSparklinePoint } from "../../lib/engagement-helpers";
import type { RequiredChartSupportProps } from "./AccessibleChartData";
import { MultiLineChart } from "./MultiLineChart";

export interface EngagementSparklineProps extends RequiredChartSupportProps {
  /** Per-day [date(YYYY-MM-DD), opens, clicks], oldest → newest. */
  points: EngagementSparklinePoint[];
  width?: number;
  height?: number;
}

export function EngagementSparkline({
  points,
  width = 320,
  height = 80,
  provenance,
  exportFileName,
  exportPrivacy,
  allowExport,
}: EngagementSparklineProps): ReactElement {
  if (points.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No engagement events in the last 90 days.
      </div>
    );
  }
  const totalOpens = points.reduce((sum, point) => sum + point.opens, 0);
  const totalClicks = points.reduce((sum, point) => sum + point.clicks, 0);
  const summary = `${points.length} days: ${totalOpens.toLocaleString()} opens and ${totalClicks.toLocaleString()} clicks.`;
  return (
    <div className="pw-data-visual" style={{ width: "100%", maxWidth: width }}>
      <MultiLineChart
        series={[
          {
            label: "Opens",
            values: points.map((point) => ({
              date: point.date,
              count: point.opens,
            })),
            color: "var(--pw-accent)",
          },
          {
            label: "Clicks",
            values: points.map((point) => ({
              date: point.date,
              count: point.clicks,
            })),
            color: "var(--pw-success)",
          },
        ]}
        height={height}
        title="90-day open and click trend"
        summary={summary}
        valueLabel="Events"
        xTickStride={Math.max(1, Math.floor(points.length / 4))}
        provenance={provenance}
        exportFileName={exportFileName}
        exportPrivacy={exportPrivacy}
        {...(allowExport != null ? { allowExport } : {})}
      />
    </div>
  );
}
