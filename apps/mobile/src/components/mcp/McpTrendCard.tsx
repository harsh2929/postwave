/**
 * McpTrendCard — calls over the window, with the two things that make the
 * line honest.
 *
 * ROLL-UP. `lib/mcpTrend` sums hourly buckets into UTC days once the series
 * gets too dense to draw, and the subtitle says so — see the module note there
 * for why summing rather than sampling is the only safe way to thin this
 * particular series.
 *
 * CLAMP. `/trend` clamps its own window to 30 days
 * (apikeycalls.go:481-483) independently of `/stats`, which clamps to 90
 * (handlers.go:238-254), and it echoes what it actually used as `windowHours`.
 * When the reader picks a window the endpoint will not honour, the chart is of
 * a different period than the control above it — so the card says which period
 * it is really showing rather than letting the control speak for it.
 */
import { View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { SectionLabel } from "@/components/SectionLabel";
import { calendarDate, time } from "@/lib/format";
import {
  mcpWindowClampNotice,
  mcpWindowLabel,
  type McpTrend,
  type McpWindow,
} from "@/lib/mcpActivity";
import { mcpTrendNotice, mcpTrendSeries } from "@/lib/mcpTrend";

export function McpTrendCard({
  trend,
  window,
}: {
  trend: McpTrend;
  window: McpWindow;
}) {
  const series = mcpTrendSeries(trend.points, window);
  const rollup = mcpTrendNotice(series);
  const clamp = mcpWindowClampNotice(window, trend.windowHours);
  const labels = series.buckets.map((bucket) =>
    series.granularity === "hour"
      ? time(bucket, bucket)
      : calendarDate(bucket, { fallback: bucket }),
  );
  const subtitle = [clamp, rollup].filter(Boolean).join(" ");

  if (series.buckets.length === 0) return null;

  return (
    <View>
      <SectionLabel {...(subtitle ? { subtitle } : {})}>
        Calls over the last {mcpWindowLabel(window)}
      </SectionLabel>
      <TimeSeriesChart
        series={[{ id: "calls", label: "Calls", values: [...series.values] }]}
        labels={labels}
        title={
          series.granularity === "hour"
            ? "Calls per hour"
            : "Calls per day (UTC)"
        }
        area
        valueNoun="calls"
      />
    </View>
  );
}
