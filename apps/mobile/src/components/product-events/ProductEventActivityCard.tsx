/**
 * ProductEventActivityCard — workspace-wide ingest volume for the window.
 *
 * This is the ONLY part of the surface that can be read as "everything is
 * fine", and it is the part least able to prove it: `/track/stats` totals the
 * whole window (track/extras.go:413-421), so a workspace whose busiest
 * integration died yesterday still shows a large, healthy-looking number for
 * another twenty-nine days. It is deliberately placed ABOVE a catalogue sorted
 * by silence, and it discloses its own measurement instant, because the tiles
 * answer "how much" and only the list below answers "still".
 *
 * TIME ZONE IS STATED, NOT ASSUMED. Buckets are `date_trunc('day', occurred_at
 * AT TIME ZONE 'UTC')` (extras.go:428) and the payload says so in `timeZone`.
 * A "today" that is really a UTC day is a small lie that gets big at 11pm in
 * Auckland, so the card prints the zone rather than relabelling the buckets.
 *
 * ABSENCE IS NOT ZERO: an unparseable `asOf` produces no "measured" line at
 * all, never a fabricated timestamp.
 */
import { Text, View } from "react-native";

import { StatCard } from "@/components/StatCard";
import { compactNum, dateTime, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import type { ProductEventStats } from "@/lib/productEvents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ProductEventActivityCard({
  stats,
}: {
  stats: ProductEventStats;
}) {
  const { t } = useTheme();
  const series = stats.daily.map((bucket) => bucket.count);
  const measured = dateTime(stats.asOf, "");

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <StatCard
          label="Events"
          value={compactNum(stats.totalEvents)}
          exact={`${num(stats.totalEvents)} events`}
          numeric={stats.totalEvents}
          sparkline={series}
          style={{ flexBasis: "48%", flexGrow: 1 }}
        />
        <StatCard
          label="Subscribers"
          value={compactNum(stats.uniqueSubscribers)}
          exact={`${num(stats.uniqueSubscribers)} subscribers`}
          numeric={stats.uniqueSubscribers}
          style={{ flexBasis: "48%", flexGrow: 1 }}
        />
        <StatCard
          label="Event names"
          value={num(stats.uniqueEventNames)}
          exact={`${num(stats.uniqueEventNames)} distinct event names`}
          numeric={stats.uniqueEventNames}
          style={{ flexBasis: "48%", flexGrow: 1 }}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {/* Every clause is conditional on the server having sent the fact.
            A window of "0 days" or a fabricated "Measured —" would each be a
            statement this card was never given. */}
        {`${
          stats.periodDays > 0
            ? `Totals cover the last ${plural(stats.periodDays, "day")}`
            : "Totals cover the window the server chose"
        }${stats.timeZone ? `, in ${stats.timeZone} days` : ""}${
          measured ? `. Measured ${measured}` : ""
        }.`}
      </Text>
    </View>
  );
}
