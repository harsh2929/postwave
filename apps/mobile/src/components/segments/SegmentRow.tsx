/**
 * SegmentRow — one row of the segments catalogue.
 *
 * `lastCount` is a POINTER server-side, so an absent value means "never
 * evaluated", not "matches nobody". Rendering that as "0" would be a lie an
 * operator acts on, so the two cases read differently.
 */
import { memo } from "react";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { MobileSegment } from "@/api/segments";
import { FONT } from "@/lib/fonts";
import { compactNum, exact, plural, relativeTime } from "@/lib/format";
import { countAstConditions } from "@/lib/segmentAst";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function SegmentRowBody({ segment }: { segment: MobileSegment }) {
  const { t } = useTheme();
  const evaluated = segment.lastCount != null;
  const conditions = countAstConditions(segment.queryAst);
  const sizeText = evaluated ? compactNum(segment.lastCount) : "—";
  const sizeSpoken = evaluated
    ? exact(segment.lastCount, "members")
    : "Size not evaluated yet";
  const freshness = segment.lastEvaluatedAt
    ? relativeTime(segment.lastEvaluatedAt, { fallback: "" })
    : "";

  return (
    <Link
      href={{ pathname: "/(tabs)/segments/[id]", params: { id: segment.id } }}
      asChild
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open segment ${segment.name}, ${sizeSpoken}`}
        // NativeWind v4: static style object only.
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          padding: 14,
          // A DECLARED tap-target floor. The row cleared 44pt only because
          // of the font sizes it happens to render today; shrink the content
          // to one short line, or drop Dynamic Type to its smallest step, and
          // it silently fell under the threshold with nothing enforcing it.
          minHeight: 64,
          marginBottom: 8,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {segment.name}
          </Text>
          <Text
            accessibilityLabel={sizeSpoken}
            {...typeCap("numeric")}
            style={{
              color: evaluated ? t.fg : t.fgSubtle,
              ...typeStyle("numeric"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
              fontVariant: ["tabular-nums"],
            }}
          >
            {sizeText}
          </Text>
        </View>
        {segment.description ? (
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              marginTop: 4,
            }}
            numberOfLines={2}
          >
            {segment.description}
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          {segment.isTemplate ? (
            <Pill label="From template" tone="info" />
          ) : null}
          {conditions > 0 ? (
            <Pill label={plural(conditions, "condition")} tone="neutral" />
          ) : null}
          {evaluated ? null : <Pill label="Not evaluated" tone="warning" />}
          {freshness ? (
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("badgeSmall"),
                fontFamily: FONT.regular,
              }}
            >
              Sized {freshness}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Link>
  );
}

export const SegmentRow = memo(SegmentRowBody);
