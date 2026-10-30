/**
 * HeaderAction — a 44pt tappable glyph for a ScreenHeader's `right` slot.
 *
 * ScreenHeader takes an arbitrary node, so every screen that wanted an action
 * there would otherwise hand-roll its own padding and hit target. The glyph is
 * decorative; the button's name comes from `accessibilityLabel`, which is
 * mandatory here for that reason.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface HeaderActionProps {
  /** Short glyph or word. Never the accessible name. */
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "accent" | "muted";
}

export function HeaderAction({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  tone = "accent",
}: HeaderActionProps) {
  const { t } = useTheme();
  const glyph = label.length <= 2;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={8}
      {...(disabled ? { disabled: true } : {})}
      style={{
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {/* A one- or two-character `label` is a GLYPH standing in for an icon
          — the button's name comes from `accessibilityLabel`, so the glyph is
          decorative and must not scale a 44pt target out of the header. A
          word-length label is content and goes on the scale. */}
      {glyph ? (
        <Text
          allowFontScaling={false}
          importantForAccessibility="no"
          style={{
            color: tone === "accent" ? t.accent : t.fgMuted,
            fontSize: 22,
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
      ) : (
        <Text
          {...typeCap("control")}
          importantForAccessibility="no"
          style={{
            color: tone === "accent" ? t.accent : t.fgMuted,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
