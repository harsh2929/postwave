/**
 * SendTimeWindowList — the ranked windows, and the accessible form of the grid.
 *
 * The heatmap hides its cells from the accessibility tree on purpose (168
 * focusable squares is not a surface anyone can use); this list is where the
 * same finding is stated in words. It is not a secondary view of the grid so
 * much as the grid's caption.
 *
 * IT IS RE-RANKED CLIENT-SIDE, NOT READ OFF `top_buckets`. The server's slice is
 * fixed to `score` and is never filtered, so an empty workspace gets twelve
 * arbitrary all-zero rows presented as its best times to send (analysis.go:109).
 * `topWindows` drops unmeasured cells, which is what turns that case into an
 * honest silence.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import {
  type SendTimeBucket,
  type SendTimeMetric,
  type SendTimeWindow,
} from "@/lib/sendTimeAnalysis";
import {
  formatMetric,
  localWindowLabel,
  SEND_TIME_METRIC_LABEL,
  utcWindowLabel,
} from "@/lib/sendTimeLabels";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SendTimeWindowList({
  windows,
  metric,
  offsetMinutes,
  selected,
  onSelect,
}: {
  windows: readonly SendTimeWindow[];
  metric: SendTimeMetric;
  offsetMinutes: number;
  selected: SendTimeBucket | null;
  onSelect: (bucket: SendTimeBucket) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {windows.map((window) => {
        const isSelected =
          selected !== null &&
          selected.dayOfWeek === window.bucket.dayOfWeek &&
          selected.hourUTC === window.bucket.hourUTC;
        const local = localWindowLabel(window.bucket, offsetMinutes);
        const utc = utcWindowLabel(window.bucket);
        const value = formatMetric(window.value, metric);
        return (
          <Pressable
            key={`${window.bucket.dayOfWeek}-${window.bucket.hourUTC}`}
            onPress={() => onSelect(window.bucket)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={`Rank ${window.rank}. ${local} your time, ${utc}. ${SEND_TIME_METRIC_LABEL[metric]} ${value}.`}
            accessibilityHint="Shows the exact counts behind this hour"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: isSelected ? t.accent : t.borderSubtle,
              backgroundColor: t.surface,
            }}
          >
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontFamily: FONT.semibold,
                width: 18,
              }}
            >
              {String(window.rank)}
            </Text>
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
                {local}
              </Text>
              <Text
                {...typeCap("caption")}
                numberOfLines={1}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {utc}
              </Text>
            </View>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fg,
                ...typeStyle("body"),
                fontFamily: FONT.semibold,
              }}
            >
              {value}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
