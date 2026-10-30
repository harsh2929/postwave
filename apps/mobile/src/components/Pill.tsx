/**
 * Pill — small, themed status badge.
 *
 * Tones map onto the theme's semantic colours. The background uses the
 * tone at 15% alpha so the pill reads as a tint rather than a solid
 * block. The label is NOT the raw tone: on its own wash that measured
 * 3.80:1 (light danger) and 3.55:1 (dark accent). It is the tone's
 * AA-safe ink, resolved in lib/pillTone.ts (A11Y-11).
 */
import { Text, View, type ViewStyle } from "react-native";

import { FONT } from "@/lib/fonts";
import { pillColors, type PillTone } from "@/lib/pillTone";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type { PillTone } from "@/lib/pillTone";

export interface PillProps {
  label: string;
  tone?: PillTone;
  size?: "sm" | "md";
  style?: ViewStyle;
  /**
   * What a screen reader says instead of the visible label.
   *
   * A pill is compacted by definition — "Cached", "99+", "Viewer preview" —
   * and the compaction is exactly what a screen-reader user cannot recover.
   * Pass the full sentence here and the visible run is hidden from
   * accessibility so it is announced once, not twice.
   */
  accessibilityLabel?: string | undefined;
}

export function Pill({
  label,
  tone = "neutral",
  size = "sm",
  style,
  accessibilityLabel,
}: PillProps) {
  const { t } = useTheme();
  const { wash, ink } = pillColors(t, tone);

  // A pill is DENSE type by definition: it sits in a row of other pills under
  // a `maxWidth` with `numberOfLines={1}`, so it cannot reflow and gets the
  // dense ceiling (1.4x) rather than a prose one.
  const role = size === "md" ? "badge" : "badgeSmall";
  const padX = size === "md" ? 10 : 8;
  const padY = size === "md" ? 4 : 2;

  return (
    <View
      {...(accessibilityLabel ? { accessible: true, accessibilityLabel } : {})}
      style={[
        {
          alignSelf: "flex-start",
          // Cap width + clip the label so an unexpectedly long status/tag
          // string can't stretch the pill across the row or overflow it.
          maxWidth: 200,
          backgroundColor: wash,
          paddingHorizontal: padX,
          paddingVertical: padY,
          borderRadius: 999,
        },
        style ?? null,
      ]}
    >
      <Text
        numberOfLines={1}
        {...typeCap(role)}
        style={{
          color: ink,
          ...typeStyle(role),
          fontFamily: FONT.semibold,
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </View>
  );
}
