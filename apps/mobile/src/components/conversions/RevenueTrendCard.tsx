/**
 * RevenueTrendCard — revenue and conversions per day across the window.
 *
 * TWO SERIES, ONE CHART, AND THEY ARE NOT THE SAME MEASURE. The daily
 * `conversions` count is `count(*)` over every conversion that day, while
 * `revenue_cents` is filtered to the dominant currency
 * (attribution.go:657-668). Plotting both on one axis would invite the reader
 * to compare a count of events with an amount of money, so the chart draws
 * REVENUE only and the conversion count is stated beneath it as a total. A
 * second axis would be the other wrong answer: two y-scales on a phone-width
 * chart is a well-known way to imply a correlation that the data does not show.
 *
 * REVENUE IS PLOTTED IN WHOLE CURRENCY UNITS, not cents. The chart's own axis
 * labels are numbers without a unit, so drawing cents would put "250000" beside
 * a card that says "$2,500.00" and leave the reader to work out they are the
 * same figure.
 *
 * THE SERIES IS ALREADY ZERO-FILLED BY THE SERVER (`zeroFillTimeseries`
 * returns exactly `days` consecutive UTC dates), so a flat run of zeros is a
 * measurement — days on which nothing converted — and is drawn as such rather
 * than being compressed away.
 */
import { Text, View } from "react-native";

import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { SectionLabel } from "@/components/SectionLabel";
import { centsToUnits } from "@/lib/attributionVerdict";
import type { AttributionTimeseries } from "@/lib/conversionAttribution";
import { calendarDate, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function RevenueTrendCard({
  series,
}: {
  series: AttributionTimeseries;
}) {
  const { t } = useTheme();
  if (series.points.length === 0) return null;

  const values = series.points.map((point) => centsToUnits(point.revenueCents));
  const labels = series.points.map((point) =>
    calendarDate(point.date, { fallback: point.date }),
  );
  const conversions = series.points.reduce(
    (sum, point) => sum + point.conversions,
    0,
  );
  const code = series.currency || "the dominant currency";

  return (
    <View>
      <SectionLabel subtitle={`Revenue is in ${code} only, matching the totals above. Days with no conversion are drawn as zero because the server measured them as zero.`}>
        Revenue per day
      </SectionLabel>
      <TimeSeriesChart
        series={[{ id: "revenue", label: `Revenue (${code})`, values }]}
        labels={labels}
        title={`Revenue per day · last ${num(series.days || series.points.length)} days`}
        area
        valueNoun="revenue"
      />
      <Text
        accessible
        accessibilityLabel={`${plural(conversions, "conversion")} across this window, counting every currency and every conversion with no monetary value — the line above shows ${code} revenue only.`}
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
      >
        {plural(conversions, "conversion")} across this window, every currency
        included — the line shows {code} revenue only.
      </Text>
    </View>
  );
}
