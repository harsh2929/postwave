/**
 * TemplateCompareBar — the floating shortlist bar for side-by-side compare.
 *
 * Appears only while at least one design is long-press-selected. "Compare"
 * arms at the server's own floor (2) and the bar SAYS what is missing below
 * it, rather than rendering a dead button with no sentence.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { TEMPLATE_COMPARE_MIN } from "@/lib/templateDiscovery";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateCompareBarProps {
  count: number;
  onCompare: () => void;
  onClear: () => void;
}

export function TemplateCompareBar(props: TemplateCompareBarProps) {
  const { t } = useTheme();
  if (props.count === 0) return null;
  const ready = props.count >= TEMPLATE_COMPARE_MIN;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: t.border,
        backgroundColor: t.surface,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flex: 1,
        }}
      >
        {ready
          ? `${props.count} selected`
          : "Long-press another design to compare"}
      </Text>
      <Pressable
        onPress={props.onClear}
        accessibilityRole="button"
        accessibilityLabel="Clear the compare selection"
        style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.fgMuted,
            ...typeStyle("control"),
            fontFamily: FONT.regular,
          }}
        >
          Clear
        </Text>
      </Pressable>
      {ready ? (
        <Pressable
          onPress={props.onCompare}
          accessibilityRole="button"
          accessibilityLabel={`Compare ${props.count} designs side by side`}
          style={{
            minHeight: 44,
            borderRadius: 12,
            paddingHorizontal: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: t.accent,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.accentFg,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            Compare
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
