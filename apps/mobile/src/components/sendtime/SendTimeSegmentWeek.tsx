/**
 * SendTimeSegmentWeek — one segment's 7×24 week, as colour.
 *
 * A SIBLING OF `SendTimeHeatmap`, NOT A REUSE OF IT. The two grids are the same
 * SHAPE and different MEASUREMENTS, and the difference is exactly the kind that
 * a shared component would quietly erase:
 *
 *   - the tenant grid has three cell states, because a cell there can mean
 *     "nothing was ever sent into this hour" — painted as an outline so it can
 *     never be mistaken for a measured zero;
 *   - this grid is a NORMALISED model covering all 168 cells at once
 *     (dow_pattern.go:322-355), so a zero is a measurement — "this audience
 *     shows no modelled engagement then" — and belongs at the floor of the
 *     ramp, not in outline. Only a malformed row is unknown here.
 *
 * Making one component serve both would mean passing the semantics in as a
 * flag, which is a worse place for them than two short files.
 *
 * ACCESSIBILITY IS PER-ROW, exactly as on the tenant grid: 168 focusable cells
 * is a swipe marathon nobody finishes, and the useful unit is the day. Each day
 * is one element that names its strongest modelled hour; the best/secondary
 * windows under the grid are the precise form of the same answer.
 *
 * NativeWind v4: static View styles only — no function-style Pressable style.
 */
import { memo } from "react";
import { Text, View, useWindowDimensions } from "react-native";

import { withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import { DAYS_PER_WEEK, HOURS_PER_DAY, rampIntensity } from "@/lib/sendTimeAnalysis";
import { utcHourLabel, WEEKDAY_LONG, WEEKDAY_SHORT } from "@/lib/sendTimeLabels";
import {
  segmentCellAt,
  segmentDayPeak,
  segmentGridPeak,
  type SegmentSendTimePattern,
} from "@/lib/sendTimeSegmentHeatmap";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const GAP = 2;
const DAY_LABEL_WIDTH = 30;
/** Card padding (16 each side) plus the screen's own 16 each side. */
const HORIZONTAL_PADDING = 64;
const TICK_HOURS = [0, 6, 12, 18];

function dayLabel(pattern: SegmentSendTimePattern, day: number): string {
  const name = WEEKDAY_LONG[day] ?? "";
  const best = segmentDayPeak(pattern, day);
  if (!best) return `${name}: nothing modelled`;
  return `${name}: strongest at ${utcHourLabel(best.hourUTC)} UTC`;
}

export const SendTimeSegmentWeek = memo(function SendTimeSegmentWeek({
  pattern,
}: {
  pattern: SegmentSendTimePattern;
}) {
  const { t } = useTheme();
  const { width } = useWindowDimensions();

  const available = width - HORIZONTAL_PADDING - DAY_LABEL_WIDTH;
  const cell = Math.max(
    6,
    Math.floor((available - GAP * (HOURS_PER_DAY - 1)) / HOURS_PER_DAY),
  );
  const gridWidth = cell * HOURS_PER_DAY + GAP * (HOURS_PER_DAY - 1);
  const peak = segmentGridPeak(pattern);

  return (
    <View>
      <View style={{ flexDirection: "row", marginBottom: 4 }}>
        <View style={{ width: DAY_LABEL_WIDTH }} />
        <View style={{ width: gridWidth, flexDirection: "row" }}>
          {Array.from({ length: HOURS_PER_DAY }, (_, hour) => (
            <View
              key={hour}
              style={{
                width: cell,
                marginEnd: hour === HOURS_PER_DAY - 1 ? 0 : GAP,
                alignItems: "flex-start",
              }}
            >
              {TICK_HOURS.includes(hour) ? (
                <Text
                  {...typeCap("badgeSmall")}
                  numberOfLines={1}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("badgeSmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {String(hour)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      </View>

      {Array.from({ length: DAYS_PER_WEEK }, (_, day) => (
        <View
          key={day}
          accessible
          accessibilityRole="text"
          accessibilityLabel={dayLabel(pattern, day)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginBottom: day === DAYS_PER_WEEK - 1 ? 0 : GAP,
          }}
        >
          <Text
            {...typeCap("badgeSmall")}
            numberOfLines={1}
            style={{
              width: DAY_LABEL_WIDTH,
              color: t.fgSubtle,
              ...typeStyle("badgeSmall"),
              fontFamily: FONT.medium,
            }}
          >
            {WEEKDAY_SHORT[day]}
          </Text>
          <View
            style={{ width: gridWidth, flexDirection: "row" }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
              const intensity = rampIntensity(
                segmentCellAt(pattern, day, hour),
                peak,
              );
              return (
                <View
                  key={hour}
                  style={{
                    width: cell,
                    height: cell,
                    marginEnd: hour === HOURS_PER_DAY - 1 ? 0 : GAP,
                    borderRadius: 2,
                    // `null` is a MALFORMED row, not a quiet hour — the only
                    // unknown this grid has. A modelled zero paints at the
                    // ramp's floor, because it is an answer.
                    backgroundColor:
                      intensity === null
                        ? "transparent"
                        : withAlpha(t.accent, 0.12 + intensity * 0.88),
                    borderWidth: 1,
                    borderColor:
                      intensity === null ? t.borderSubtle : "transparent",
                  }}
                />
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
});
