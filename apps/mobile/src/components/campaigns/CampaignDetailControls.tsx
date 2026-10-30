import { type RefObject } from "react";
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme, type ThemeTokens } from "@/lib/theme";

/**
 * The date/hour/minute picker moved to its own file when it grew a scroll
 * effect, a measured row height and an OS-text-size-aware container. Re-
 * exported so every existing call site keeps one import path.
 */
export { DateTimeWheel } from "@/components/campaigns/DateTimeWheel";

/**
 * `Card` here was a byte-for-byte copy of the shared primitive's default
 * variant — same surface, same subtle border, same radius 16, same padding 16
 * — declared under the same NAME, so the two could drift apart with nothing
 * to notice. Re-exported instead of redeclared: the four campaign cards that
 * import `Card` from this module keep their import path, and a change to card
 * geometry now reaches them from src/lib/shellStyleTokens.ts like everywhere
 * else. The shared one is a strict superset (it also takes `style`,
 * `variant` and the rest of ViewProps), so no call site changes.
 */
export { Card } from "@/components/Card";

export function StatRow({
  label,
  value,
  t,
  last,
}: {
  label: string;
  value: string;
  t: ThemeTokens;
  last?: boolean;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: 8,
        borderBottomColor: t.borderSubtle,
        borderBottomWidth: last ? 0 : 1,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{ color: t.fgMuted, fontSize: 13, fontFamily: FONT.regular }}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        {...typeCap("mono")}
        style={{
          color: t.fg,
          fontSize: 13,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  primary,
  danger,
  disabled,
  buttonRef,
}: {
  label: string;
  onPress: () => void;
  // `| undefined` on every optional: exactOptionalPropertyTypes is on, so a
  // caller forwarding an already-optional prop straight through (the common
  // case for `disabled`) is otherwise a type error at every call site.
  primary?: boolean | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * Attach when this button opens a sheet: KeyboardFormSheet focuses it again
   * on dismiss, so a VoiceOver user is returned to the control they pressed
   * rather than to the top of the screen.
   */
  buttonRef?: RefObject<View | null> | undefined;
}) {
  const { t } = useTheme();
  const bg = primary ? t.accent : danger ? t.bgSubtle : t.bgSubtle;
  const borderColor = primary ? t.accent : danger ? t.danger : t.border;
  const fgColor = primary ? t.accentFg : danger ? t.danger : t.fg;
  return (
    <Pressable
      {...(buttonRef ? { ref: buttonRef } : {})}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={{
        backgroundColor: bg,
        borderColor,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
        minHeight: 44,
        borderRadius: 10,
        opacity: disabled ? 0.5 : 1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: fgColor,
          fontSize: 13,
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ModalHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 16,
      }}
    >
      <Text
        {...typeCap("title")}
        style={{
          color: t.fg,
          fontSize: 22,
          fontWeight: "700",
          fontFamily: FONT.display,
        }}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Text
          {...typeCap("heading")}
          style={{ color: t.fgMuted, fontSize: 16, fontFamily: FONT.regular }}
        >
          Cancel
        </Text>
      </Pressable>
    </View>
  );
}
