/**
 * ProductEventRow — one distinct event name in the catalogue.
 *
 * LAST SEEN IS THE HEADLINE, not the volume. An event that silently stopped is
 * the failure this surface exists to catch, and a row led by "48,201 events"
 * reads as healthy forever: the total is cumulative over the window and keeps
 * its size for weeks after ingest dies. So the freshness verdict sits directly
 * under the name, the age is spelled out in words, and the counts are demoted
 * to the trailing column.
 *
 * COLOUR NEVER CARRIES THE STATE. The pill always prints its word ("Silent"),
 * and the sentence beneath it repeats the gap in days — so the row reads
 * correctly in greyscale, to a colour-blind eye, and to VoiceOver.
 *
 * THE TWO WINDOWS ARE LABELLED. `count` covers the chosen window while `daily`
 * always covers 7 days (track/extras.go:195). The trend line therefore carries
 * an explicit "7d" caption rather than sitting anonymously beside a 90-day
 * number.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { Sparkline } from "@/components/charts/Sparkline";
import { compactNum, dateTime, num, plural, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { chartPalette } from "@/lib/chartPalette";
import {
  classifyProductEvent,
  type ProductEventFreshness,
} from "@/lib/productEventHealth";
import type { ProductEventCatalogRow } from "@/lib/productEvents";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/**
 * `silent` is `warning`, never `danger`. Nothing in `product_events` records
 * how often an event is meant to arrive, so a week-long gap on a monthly event
 * is normal and a red row would be a false alarm — see the note at the top of
 * lib/productEventHealth.
 */
function toneFor(freshness: ProductEventFreshness): PillTone {
  if (freshness === "live") return "success";
  if (freshness === "silent") return "warning";
  if (freshness === "unknown") return "neutral";
  return "neutral";
}

export interface ProductEventRowProps {
  row: ProductEventCatalogRow;
  /** The catalogue payload's `asOf`. Ages are measured against it, not a clock. */
  measuredAt: string;
  /** Window the row's counts cover, in days. */
  periodDays: number;
  /** Window the trend line covers, in days (the server's constant 7). */
  seriesDays: number;
  expanded: boolean;
  onToggle: (eventName: string) => void;
}

export function ProductEventRow({
  row,
  measuredAt,
  periodDays,
  seriesDays,
  expanded,
  onToggle,
}: ProductEventRowProps) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);
  const verdict = classifyProductEvent(row.lastSeen, measuredAt);
  // Relative to the SNAPSHOT, not to now — a cached payload rendered in a
  // tunnel must not age on the shelf. When the snapshot is unreadable there is
  // NO relative age: falling back to the device clock would print a confident
  // "2 hours ago" beside a pill that already admits the freshness is unknown.
  // `dateTime` gives the absolute instant a support conversation can act on.
  const snapshot = Date.parse(measuredAt);
  const rel = Number.isNaN(snapshot)
    ? ""
    : relativeTime(row.lastSeen, { now: snapshot, fallback: "" });
  const abs = dateTime(row.lastSeen, "");
  const series = row.daily.map((bucket) => bucket.count);
  // A window we were not told about is not "0 days". Both of these degrade to
  // silence rather than to a fabricated zero (house rule: absence is not zero).
  const seriesLabel = seriesDays > 0 ? `${seriesDays}d` : undefined;
  const windowClause =
    periodDays > 0 ? ` in the last ${plural(periodDays, "day")}` : "";
  const seriesTone =
    verdict.freshness === "silent" ? t.warning : palette.seriesColor(0);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${row.eventName}. ${verdict.label}. ${verdict.description}${
        abs ? ` Last seen ${abs}.` : ""
      } ${num(row.count)} ${row.count === 1 ? "event" : "events"} from ${plural(
        row.uniqueSubscribers,
        "subscriber",
      )}${windowClause}.`}
      accessibilityHint={
        expanded ? "Hides the newest raw events" : "Shows the newest raw events"
      }
      onPress={() => onToggle(row.eventName)}
      // Static object — a function style silently drops layout on NativeWind v4.
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        minHeight: 44,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {row.eventName}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            flexWrap: "wrap",
          }}
        >
          <Pill label={verdict.label} tone={toneFor(verdict.freshness)} />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            {rel ? `last seen ${rel}` : "last seen not reported"}
          </Text>
        </View>
      </View>

      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <Text
          {...typeCap("numeric")}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            fontVariant: ["tabular-nums"],
          }}
        >
          {compactNum(row.count)}
        </Text>
        {/* Hidden from assistive tech: the Pressable's own label already
            carries the exact, uncompacted figure and the subscriber count. */}
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ alignItems: "flex-end" }}
        >
          <Sparkline
            values={series}
            width={72}
            height={22}
            color={seriesTone}
            {...(seriesLabel ? { label: seriesLabel } : {})}
          />
        </View>
      </View>
    </Pressable>
  );
}
