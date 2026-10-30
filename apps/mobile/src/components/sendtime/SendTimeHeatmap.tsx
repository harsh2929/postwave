/**
 * SendTimeHeatmap — the 7×24 week, as colour.
 *
 * WHY A GRID OF SQUARES AND NOT A TABLE. 168 numbers is a spreadsheet on a
 * desktop and an unreadable wall on a phone. As colour it is one glance: the
 * bright band IS the answer. The numbers are still reachable — tap a cell and
 * the detail card below states it exactly — but they are not what the screen
 * leads with.
 *
 * THREE CELL STATES, NOT TWO. A cell is either
 *   - MEASURED, painted at an intensity scaled to the grid's peak,
 *   - MEASURED AT ZERO, painted at the floor of the ramp, or
 *   - NEVER MEASURED, painted as an empty outline.
 * Collapsing the last two is the whole bug this file exists to avoid: "we sent
 * into Tuesday 3am and nobody opened" and "we have never sent into Tuesday 3am"
 * are opposite facts and must not look alike. `rampIntensity` returns `null`
 * for the third, and `null` gets the outline.
 *
 * ACCESSIBILITY IS PER-ROW, NOT PER-CELL. 168 focusable elements is a VoiceOver
 * swipe marathon that nobody would ever finish, and the individual cell is the
 * least useful unit anyway. Each DAY is one accessible element whose label
 * names that day's strongest measured hour; the ranked window list beside the
 * grid is the precise, fully accessible form of the same data. The cells stay
 * touchable for sighted inspection and are hidden from the accessibility tree.
 *
 * NativeWind v4: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on every cell.
 */
import { memo } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";

import { FONT } from "@/lib/fonts";
import { withAlpha } from "@/lib/color";
import {
  bucketMetric,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  rampIntensity,
  type SendTimeAnalysis,
  type SendTimeBucket,
  type SendTimeMetric,
} from "@/lib/sendTimeAnalysis";
import {
  formatMetric,
  utcHourLabel,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
} from "@/lib/sendTimeLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const GAP = 2;
const DAY_LABEL_WIDTH = 30;
const HORIZONTAL_PADDING = 32;
/** Hours that get a printed tick. Every hour would be unreadable at this size. */
const TICK_HOURS = [0, 6, 12, 18];

export interface SendTimeHeatmapProps {
  analysis: SendTimeAnalysis;
  metric: SendTimeMetric;
  peak: number;
  selected: SendTimeBucket | null;
  onSelect: (bucket: SendTimeBucket) => void;
}

/**
 * The strongest MEASURED cell in one day, or null when that day was never
 * measured. Used only for the row's spoken label.
 */
function peakOfDay(
  analysis: SendTimeAnalysis,
  day: number,
  metric: SendTimeMetric,
): { bucket: SendTimeBucket; value: number } | null {
  let best: { bucket: SendTimeBucket; value: number } | null = null;
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const bucket = analysis.grid[day * HOURS_PER_DAY + hour];
    if (!bucket) continue;
    const value = bucketMetric(bucket, metric);
    if (value === null) continue;
    if (!best || value > best.value) best = { bucket, value };
  }
  return best;
}

function dayLabel(
  analysis: SendTimeAnalysis,
  day: number,
  metric: SendTimeMetric,
): string {
  const name = WEEKDAY_LONG[day] ?? "";
  const best = peakOfDay(analysis, day, metric);
  if (!best) return `${name}: nothing measured`;
  return `${name}: strongest at ${utcHourLabel(best.bucket.hourUTC)} UTC, ${formatMetric(
    best.value,
    metric,
  )}`;
}

export const SendTimeHeatmap = memo(function SendTimeHeatmap({
  analysis,
  metric,
  peak,
  selected,
  onSelect,
}: SendTimeHeatmapProps) {
  const { t } = useTheme();
  const { width } = useWindowDimensions();

  // Sized to the viewport so the WHOLE WEEK is visible at once. A horizontally
  // scrolling heatmap loses the one thing a heatmap is for — you cannot compare
  // Monday to Friday if Friday is off-screen.
  const available = width - HORIZONTAL_PADDING - DAY_LABEL_WIDTH;
  const cell = Math.max(
    8,
    Math.floor((available - GAP * (HOURS_PER_DAY - 1)) / HOURS_PER_DAY),
  );
  const gridWidth = cell * HOURS_PER_DAY + GAP * (HOURS_PER_DAY - 1);

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
          accessibilityLabel={dayLabel(analysis, day, metric)}
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
              const bucket = analysis.grid[day * HOURS_PER_DAY + hour];
              const intensity = bucket
                ? rampIntensity(bucketMetric(bucket, metric), peak)
                : null;
              const isSelected =
                selected !== null &&
                selected.dayOfWeek === day &&
                selected.hourUTC === hour;
              return (
                <Pressable
                  key={hour}
                  onPress={bucket ? () => onSelect(bucket) : undefined}
                  style={{
                    width: cell,
                    height: cell,
                    marginEnd: hour === HOURS_PER_DAY - 1 ? 0 : GAP,
                    borderRadius: 2,
                    // `null` intensity is the never-measured cell: an outline,
                    // deliberately not the coldest paint on the ramp.
                    backgroundColor:
                      intensity === null
                        ? "transparent"
                        : withAlpha(t.accent, 0.12 + intensity * 0.88),
                    borderWidth: 1,
                    borderColor: isSelected
                      ? t.fg
                      : intensity === null
                        ? t.borderSubtle
                        : "transparent",
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
