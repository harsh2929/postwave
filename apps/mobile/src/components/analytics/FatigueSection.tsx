/**
 * FatigueSection — "are we mailing people too much?"
 *
 * Backed by GET /api/v1/analytics/fatigue, which buckets mailed subscribers
 * into deciles by how many emails they received in the window and reports the
 * open and unsubscribe rate of each. A healthy programme shows a flat-ish open
 * curve; fatigue shows it sagging in the heavy deciles.
 *
 * Two deliberate choices:
 *
 *  - THE CURVE IS DRAWN, NOT RANKED. A BarChart would sort the deciles by value
 *    and destroy the only thing the data means — send volume is the x-axis, and
 *    reordering it turns a fatigue curve into a meaningless league table. So
 *    this uses the line chart with the decile labels as the axis.
 *  - ONE MEASURE PER CHART. Open rate (~30%) and unsubscribe rate (~0.2%) share
 *    no usable scale, and a second y-axis would let the author choose where the
 *    lines cross. The unsub figure is reported as text beside the verdict
 *    instead.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonCard } from "@/components/Skeleton";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { fatigueVerdict, type FatigueDecile } from "@/lib/analyticsSeries";
import { FONT } from "@/lib/fonts";
import { percent } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FatigueSectionProps {
  query: QueryLike;
  deciles: readonly FatigueDecile[];
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function FatigueSection({ query, deciles, gate }: FatigueSectionProps) {
  const { t } = useTheme();
  const verdict = fatigueVerdict(deciles);
  const heaviest = deciles[deciles.length - 1];

  return (
    <View>
      <SectionLabel>Send fatigue</SectionLabel>
      <Card style={{ gap: 12 }}>
        <QueryStates
          query={query}
          isEmpty={deciles.length === 0}
          gate={gate}
          skeleton={<SkeletonCard lines={4} />}
          empty={{
            title: "Not enough send history",
            description:
              "The fatigue curve needs subscribers who have received mail in this window.",
          }}
        >
          {verdict ? (
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: "row" }}>
                <Pill
                  label={
                    verdict.severity === "fatigued"
                      ? "Fatigue detected"
                      : verdict.severity === "watch"
                        ? "Worth watching"
                        : "Healthy"
                  }
                  tone={
                    verdict.severity === "fatigued"
                      ? "danger"
                      : verdict.severity === "watch"
                        ? "warning"
                        : "success"
                  }
                />
              </View>
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fg,
                  fontFamily: FONT.regular,
                  ...typeStyle("bodySmall"),
                }}
              >
                {verdict.headline}
              </Text>
            </View>
          ) : (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("bodySmall"),
              }}
            >
              Too few send-volume buckets to read a trend yet — the curve below
              is the raw measurement.
            </Text>
          )}

          <TimeSeriesChart
            series={[
              {
                id: "open-rate",
                label: "Open rate",
                // Percentage points, so the axis reads 0–40 rather than 0–0.4.
                values: deciles.map((decile) => decile.openRate * 100),
              },
            ]}
            labels={deciles.map((decile) => `${decile.bucket} sends`)}
            title="Open rate by emails received"
            valueNoun="percent"
          />

          {heaviest ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              Heaviest-mailed group ({heaviest.bucket} sends):{" "}
              {percent(heaviest.unsubRate, { digits: 2 })} unsubscribe rate.
              Buckets are equal-population deciles by send volume.
            </Text>
          ) : null}
        </QueryStates>
      </Card>
    </View>
  );
}
