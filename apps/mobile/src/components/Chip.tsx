/**
 * Chip — selectable filter chip used in lists (Subscribers, Approvals,
 * Audit). Active state inverts to the accent colour so the affordance
 * is unambiguous on both light and dark themes.
 */
import { useCallback } from "react";
import { Pressable, Text, type PressableProps } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  /** Override accessibilityLabel; defaults to the visible label. */
  accessibilityLabel?: string;
  disabled?: boolean;
}

export function Chip({
  label,
  active,
  onPress,
  accessibilityLabel,
  disabled,
}: ChipProps) {
  const { t } = useTheme();

  // exactOptionalPropertyTypes: Pressable rejects `disabled?: undefined`
  // so we only spread the prop when truthy.
  const extra: Partial<Pick<PressableProps, "disabled">> = disabled
    ? { disabled: true }
    : {};

  // LOVE#14. Chip is the densest control in the app — filters on campaigns,
  // subscribers, approvals, suppressions, lists and audit — and it was the
  // only selection control with no physical feedback, while SegmentedControl,
  // SearchField, SwipeableRow and both chart legends all fire `haptics.tap()`.
  // Selection felt inert exactly where interaction is heaviest.
  //
  // `tap`, not `success`: choosing a filter is a navigation, not a commit, and
  // the shared haptics module already no-ops under Reduce Motion and on
  // platforms without a taptic engine.
  const handlePress = useCallback(() => {
    haptics.tap();
    onPress();
  }, [onPress]);

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={6}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        minHeight: 44,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? t.accent : t.border,
        backgroundColor: active
          ? t.accent
          : t.surface,
        opacity: disabled ? 0.5 : 1,
        alignItems: "center",
        justifyContent: "center",
      }}
      {...extra}
    >
      {/* `label`, not a dense role: the chip's 44pt is a minHeight and the
          text is free to wrap, so this control genuinely can honour a large
          text setting instead of clipping. */}
      <Text
        {...typeCap("label")}
        style={{
          color: active ? t.accentFg : t.fg,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
