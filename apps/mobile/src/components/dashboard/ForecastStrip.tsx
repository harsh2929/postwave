/**
 * ForecastStrip — one ambient line under the stat grid: "At this rate you'll
 * cross 1,000 subscribers around 15 Aug."
 *
 * Everything load-bearing is in `lib/forecast.ts`, which is a straight port of
 * the desktop helper so the two clients cannot predict different dates from
 * the same series. This file's only job is to render the result WITH ITS
 * PROVENANCE — a bare date reads as a commitment, so the badge and the caveat
 * are not decoration and must not be dropped to save a line.
 *
 * The series is daily NEW OPT-INS (the server's `sparklines.subscribers`
 * bucket), which is what the desktop projects too. The caveat says so: a
 * workspace with heavy churn will cross later than this line claims.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { date, num } from "@/lib/format";
import { forecastNextMilestone } from "@/lib/forecast";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ForecastStripProps {
  /** Daily-bucketed subscriber opt-ins from `sparklines.subscribers`. */
  sparkline: number[] | undefined;
  /** Current subscriber total. Null (not reported) means no projection. */
  currentTotal: number | null;
}

export function ForecastStrip({
  sparkline,
  currentTotal,
}: ForecastStripProps) {
  const { t } = useTheme();
  if (!sparkline || currentTotal === null) return null;
  const forecast = forecastNextMilestone(sparkline, currentTotal);
  if (!forecast) return null;

  const target = num(forecast.target);
  const when = date(forecast.crossesAt);
  const sentence = `At this rate you'll cross ${target} subscribers around ${when}.`;

  return (
    <View
      accessible
      // `text`, not `alert`: a projection is ambient context, and an alert
      // role would interrupt VoiceOver every time the poll moves the date.
      accessibilityRole="text"
      accessibilityLabel={`Projection. ${sentence} Directional only, from the recent opt-in trend.`}
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pill label="Projection" tone="info" />
        <Text
          // `badgeSmall`, not `caption`: this shares a non-wrapping row with
          // the Projection pill, so it is pinned geometry rather than prose.
          {...typeCap("badgeSmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("badgeSmall"),
            letterSpacing: 0.6,
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
          }}
        >
          Growth trajectory
        </Text>
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {sentence}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Directional only — a straight-line projection from the last{" "}
        {sparkline.length} days of opt-ins, before unsubscribes.
      </Text>
    </View>
  );
}
