/**
 * GroupedTrendSection — "which campaigns, or which mailbox providers, is this
 * number coming from?"
 *
 * The desktop answers with a ten-line chart behind a GroupByMenu. Ten lines at
 * 360pt is a thicket, so this card keeps the largest few series separable and
 * folds the rest into one honestly-named trailing line (see
 * lib/groupedTimeseries.ts, which does the arithmetic and the naming).
 *
 * THE DIMENSION CONTROL OFFERS EXACTLY WHAT THE SERVER ACCEPTS. `group_by=list`
 * is a structured 400 (`unsupported_dimension`) because campaign_report_events
 * carries no per-event list attribution, so a "List" chip here would be a
 * control whose only possible outcome is an error. Both chips come straight
 * from the endpoint's whitelist.
 *
 * BOUNCES ARE NOT A SUCCESS METRIC, and the chart cannot know that — so the
 * metric chips are neutral and the caption says what is being counted rather
 * than judging it.
 *
 * NativeWind v4: SegmentedControl owns every Pressable here, and it uses static
 * style objects (house rule 1).
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonCard } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import {
  GROUPED_DIMENSIONS,
  GROUPED_METRICS,
  dimensionLabel,
  groupedCaption,
  groupedChartInput,
  type GroupedDimension,
  type GroupedMetric,
  type GroupedSeries,
} from "@/lib/groupedTimeseries";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const DIMENSION_OPTIONS = GROUPED_DIMENSIONS.map((value) => ({
  value,
  label: dimensionLabel(value),
}));

const METRIC_OPTIONS = GROUPED_METRICS.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

export interface GroupedTrendSectionProps {
  query: QueryLike;
  series: readonly GroupedSeries[];
  gate: Pick<OnlineQueryGate, "enabled">;
  dimension: GroupedDimension;
  metric: GroupedMetric;
  onDimensionChange: (next: GroupedDimension) => void;
  onMetricChange: (next: GroupedMetric) => void;
  rangeLabel: string;
}

export function GroupedTrendSection({
  query,
  series,
  gate,
  dimension,
  metric,
  onDimensionChange,
  onMetricChange,
  rangeLabel,
}: GroupedTrendSectionProps) {
  const { t } = useTheme();
  const input = groupedChartInput(series);

  return (
    <View style={{ gap: 10 }}>
      {/* The controls sit ABOVE the query states, not inside them: a reader
          who lands on an error or an empty result must still be able to switch
          dimension, which is the most likely way out of both. */}
      <SegmentedControl
        accessibilityLabel="Break down by"
        options={DIMENSION_OPTIONS}
        value={dimension}
        onChange={onDimensionChange}
      />
      <SegmentedControl
        accessibilityLabel="Metric"
        options={METRIC_OPTIONS}
        value={metric}
        onChange={onMetricChange}
      />

      <QueryStates
        query={query}
        isEmpty={input.series.length === 0}
        gate={gate}
        skeleton={<SkeletonCard lines={4} />}
        empty={{
          title: "Nothing recorded in this window",
          description: `No ${metric} were attributed to any ${
            dimension === "campaign" ? "campaign" : "recipient domain"
          } in ${rangeLabel.toLowerCase()}.`,
        }}
      >
        <View style={{ gap: 10 }}>
          <TimeSeriesChart
            series={input.series}
            labels={input.labels.map((day) => date(day, day))}
            title={`${
              metric.charAt(0).toUpperCase() + metric.slice(1)
            } by ${dimensionLabel(dimension).toLowerCase()}`}
            valueNoun={metric}
            // Event COUNTS, not a stock: a truncated baseline would make a
            // small movement look like a collapse.
            zeroBased
          />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {groupedCaption(dimension, input.rolledUp)}
          </Text>
        </View>
      </QueryStates>
    </View>
  );
}
