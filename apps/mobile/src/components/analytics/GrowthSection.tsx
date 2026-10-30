/**
 * GrowthSection — subscriber growth over the selected reporting window.
 *
 * Backed by GET /api/v1/analytics/subscribers/timeseries, which returns
 * end-of-day CUMULATIVE totals rather than daily adds. That distinction is the
 * whole reason the axis is not forced to zero here: a workspace sitting at
 * 48,000 subscribers plotted from zero is a flat line at the top of the frame
 * that shows nothing. Cumulative stock is the one legitimate case for a
 * non-zero baseline, and the net-change figure above the chart carries the
 * magnitude the truncated axis no longer can.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  subscriberChartInput,
  subscriberNetChange,
  type SubscriberPoint,
} from "@/lib/analyticsSeries";
import { FONT } from "@/lib/fonts";
import { num, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface GrowthSectionProps {
  query: QueryLike;
  points: readonly SubscriberPoint[];
  gate: Pick<OnlineQueryGate, "enabled">;
  rangeLabel: string;
}

export function GrowthSection({
  query,
  points,
  gate,
  rangeLabel,
}: GrowthSectionProps) {
  const { t } = useTheme();
  const { labels, values } = subscriberChartInput(points);
  const net = subscriberNetChange(points);
  const latest = points[points.length - 1]?.count ?? null;

  return (
    <View>
      <SectionLabel topMargin={20}>Audience growth</SectionLabel>
      <Card style={{ gap: 12 }}>
        <QueryStates
          query={query}
          isEmpty={points.length === 0}
          gate={gate}
          skeleton={<SkeletonCard lines={4} />}
          empty={{
            title: "No growth data yet",
            description:
              "Subscriber history appears once this workspace has at least one day of measured activity.",
          }}
        >
          <View
            accessible
            accessibilityLabel={
              latest === null
                ? "Subscriber total unavailable"
                : `${plural(latest, "subscriber")} at the end of ${rangeLabel}${
                    net === null
                      ? ""
                      : `, a net change of ${net >= 0 ? "up" : "down"} ${num(Math.abs(net))}`
                  }`
            }
          >
            <Text
              // The card's hero figure, so it takes the scale's tightest
              // ceiling. No explicit leading: `figure` is a display number,
              // and a fixed lineHeight here would fight the display face.
              {...typeCap("figure")}
              style={{
                color: t.fg,
                fontFamily: FONT.display,
                fontSize: fontSizeFor("figure"),
                letterSpacing: -0.6,
                fontVariant: ["tabular-nums"],
              }}
            >
              {num(latest)}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: net === null ? t.fgSubtle : net >= 0 ? t.success : t.danger,
                fontFamily: FONT.medium,
                ...typeStyle("numeric"),
                marginTop: 2,
              }}
            >
              {net === null
                ? `Subscribers · ${rangeLabel}`
                : `${net >= 0 ? "▲" : "▼"} ${net >= 0 ? "+" : "−"}${num(Math.abs(net))} over ${rangeLabel}`}
            </Text>
          </View>

          <TimeSeriesChart
            series={[
              { id: "subscribers", label: "Subscribers", values },
            ]}
            labels={labels}
            area
            // Cumulative stock, not a count of events: see the note above.
            zeroBased={false}
            valueNoun="subscribers"
          />
        </QueryStates>
      </Card>
    </View>
  );
}
