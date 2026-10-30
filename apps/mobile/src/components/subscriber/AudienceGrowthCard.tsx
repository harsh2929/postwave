/**
 * AudienceGrowthCard — "is my list growing?" above the subscriber list.
 *
 * Mobile had no audience aggregate at all beyond a row count, which is the
 * one number that cannot answer the question. This card is a collapsible
 * header over the subscribers FlatList: a delta headline, a total/added/
 * unsubscribed tile row, and the trailing-window trend.
 *
 * The endpoint (SUB-124) ships with an unusually explicit honesty contract
 * and this card is built around it rather than around the chart:
 *
 *  - Fewer than two snapshots is NOT a flat line. `hasPlottableTrend`
 *    gates the chart, and the server's own `note` is rendered instead.
 *  - `unavailable_metrics` (always `lapsed`) is never charted or totalled.
 *  - `unsubbed` is a verified LOWER BOUND, so its tile reads "at least"
 *    whenever the server declares it partial — in the visible label and in
 *    the spoken summary, not in a footnote.
 *
 * Colours come from the validated chart palette via TimeSeriesChart; no raw
 * hex is passed here. Collapsed state persists per screen + identity.
 */
import { Pressable, Text, View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Skeleton } from "@/components/Skeleton";
import {
  Card,
  Label,
  MiniStat,
} from "@/components/subscriber/SubscriberDetailPrimitives";
import { useAudienceGrowth } from "@/hooks/useAudienceGrowth";
import {
  growthDeltaLine,
  growthSpokenSummary,
  hasPlottableTrend,
  metricIsPartial,
} from "@/lib/audienceGrowth";
import { FONT } from "@/lib/fonts";
import { compactNum, num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AudienceGrowthCard({
  days = 30,
  expanded,
  onToggle,
}: {
  days?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  const growth = useAudienceGrowth(days);

  // A failed growth read must not take the subscriber list down with it, and
  // must not render as "0 growth" either — say nothing.
  if (growth.isError) return null;

  const data = growth.data;
  const deltaLine = growthDeltaLine(data);
  const headline = growth.isLoading
    ? "Loading…"
    : (deltaLine ?? "Not enough snapshots yet");

  return (
    <Card style={{ marginBottom: 12 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          onToggle();
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          growth.isLoading
            ? "Audience growth, loading"
            : growthSpokenSummary(data)
        }
        accessibilityHint={expanded ? "Collapse the chart" : "Expand the chart"}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minHeight: 44,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Label>Growth · {days} days</Label>
          <Text
            numberOfLines={2}
            {...typeCap("heading")}
            style={{
              color: t.fg,
              ...typeStyle("heading"),
              fontWeight: "700",
              fontFamily: FONT.display,
              marginTop: 2,
              fontVariant: ["tabular-nums"],
            }}
          >
            {headline}
          </Text>
        </View>
        {/* `control`: the Show/Hide affordance is pinned to the right of the
            headline's row and must not push it off the card. */}
        <Text
          {...typeCap("control")}
          style={{
            color: t.fgMuted,
            ...typeStyle("control"),
            fontFamily: FONT.regular,
          }}
        >
          {expanded ? "Hide" : "Show"}
        </Text>
      </Pressable>

      {expanded ? (
        <GrowthBody
          days={days}
          isLoading={growth.isLoading}
          data={data}
        />
      ) : null}
    </Card>
  );
}

function GrowthBody({
  days,
  isLoading,
  data,
}: {
  days: number;
  isLoading: boolean;
  data: ReturnType<typeof useAudienceGrowth>["data"];
}) {
  const { t } = useTheme();

  if (isLoading || !data) {
    return (
      <View style={{ marginTop: 12 }}>
        <Skeleton height={72} />
      </View>
    );
  }

  const latest = data.series[data.series.length - 1];
  const unsubPartial = metricIsPartial(data, "unsubbed");
  const plottable = hasPlottableTrend(data);

  return (
    <View style={{ marginTop: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <MiniStat
          label="Subscribers"
          value={latest ? compactNum(latest.total) : "—"}
          sub={latest ? num(latest.total) : null}
          t={t}
        />
        <MiniStat
          label="Added"
          value={compactNum(data.totalAdded)}
          sub={num(data.totalAdded)}
          t={t}
        />
        <MiniStat
          // "At least" is the schema's own framing for a partial metric;
          // printing it as a total would overstate what the ledger proves.
          label={unsubPartial ? "Unsubbed (min)" : "Unsubbed"}
          value={compactNum(data.totalUnsubbed)}
          sub={
            unsubPartial
              ? `at least ${num(data.totalUnsubbed)}`
              : num(data.totalUnsubbed)
          }
          t={t}
        />
      </View>

      {plottable ? (
        <View style={{ marginTop: 12 }}>
          <TimeSeriesChart
            series={[
              {
                id: "total",
                label: "Subscribers",
                values: data.series.map((p) => p.total),
              },
            ]}
            labels={data.series.map((p) => p.date)}
            title={`Subscribers · last ${days} days`}
            valueNoun="subscribers"
            height={140}
            area
          />
        </View>
      ) : (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          The daily snapshot worker needs at least two days before a trend can
          be drawn.
        </Text>
      )}

      {data.note ? (
        // The server's own disclosure, verbatim. Paraphrasing it is how a
        // "partial coverage" caveat quietly turns into a claim.
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {data.note}
        </Text>
      ) : null}
    </View>
  );
}
