/**
 * RetentionSection — "are newer signups worse than older ones?"
 *
 * The desktop answers this with a triangular cohort heatmap. That grid does
 * not survive the trip to a phone: twelve rows of colour-coded cells at 360pt
 * is a picture of data rather than data, and a reader takes an impression from
 * it instead of a fact. What travels is the sentence the grid encodes, and one
 * comparable bar per cohort underneath it.
 *
 * SELF-GATING, and this is the important part. `cohortComparison` returns null
 * — and this section renders NOTHING — whenever the comparison would be
 * dishonest: fewer than two cohorts, a cohort too small for a rate to mean
 * anything, or no week of maturity in common. A young workspace gets silence
 * rather than "July retention: 0%", which is what a naive read of the payload
 * produces, because the server truncates an immature cohort's week array
 * instead of padding it with zeros.
 *
 * The window control at the top of the screen deliberately does not reach this
 * card: a cohort's clock starts at its own signup date, so "last 7 days" has
 * no meaning here. The caption says so rather than leaving the reader to
 * assume the segmented control applies.
 */
import { Text, View } from "react-native";

import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { BarChart } from "@/components/charts/BarChart";
import { SkeletonCard } from "@/components/Skeleton";
import type { OnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  cohortBarsAt,
  cohortComparison,
  MIN_COMPARABLE_COHORT,
  type CohortRow,
} from "@/lib/cohortRetention";
import { FONT } from "@/lib/fonts";
import { num, percent, plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RetentionSectionProps {
  query: QueryLike;
  cohorts: readonly CohortRow[];
  gate: Pick<OnlineQueryGate, "enabled">;
}

export function RetentionSection({
  query,
  cohorts,
  gate,
}: RetentionSectionProps) {
  const { t } = useTheme();
  const comparison = cohortComparison(cohorts);

  return (
    <QueryStates
      query={query}
      isEmpty={cohorts.length === 0}
      gate={gate}
      skeleton={<SkeletonCard lines={3} />}
      empty={{
        title: "No cohorts yet",
        description:
          "Signup cohorts appear once this workspace has a month of subscribers behind it.",
      }}
    >
      {comparison === null ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("bodySmall"),
          }}
        >
          {`Not enough history to compare cohorts yet. Two signup months of at least ${num(MIN_COMPARABLE_COHORT)} subscribers each, both past their first week, are needed before a comparison means anything.`}
        </Text>
      ) : (
        <View style={{ gap: 12 }}>
          <View
            accessible
            accessibilityLabel={`${comparison.headline} ${percent(
              comparison.recentRate,
            )} against ${percent(comparison.priorRate)}.`}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fg,
                fontFamily: FONT.medium,
                ...typeStyle("callout"),
              }}
            >
              {comparison.headline}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                // Movement is reported in NEUTRAL ink. A cohort engaging less
                // is not necessarily bad news (a big low-intent acquisition
                // month dilutes the rate), and colouring it red would assert
                // a judgement the number cannot support.
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("numeric"),
                marginTop: 4,
                fontVariant: ["tabular-nums"],
              }}
            >
              {`${percent(comparison.recentRate)} vs ${percent(
                comparison.priorRate,
              )} · ${plural(comparison.recent.size, "subscriber")} vs ${num(
                comparison.prior.size,
              )}`}
            </Text>
          </View>

          <BarChart
            data={cohortBarsAt(cohorts, comparison.weekIndex)}
            valueNoun="percent engaged"
            emphasise={comparison.recent.label}
            maxRows={6}
          />

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {`Share of each signup month that opened, clicked or replied in week ${
              comparison.weekIndex + 1
            } after joining. Measured from each cohort's own signup date, so the reporting window above does not apply. Cohorts that have not reached week ${
              comparison.weekIndex + 1
            } are left out rather than drawn at zero.`}
          </Text>
        </View>
      )}
    </QueryStates>
  );
}
