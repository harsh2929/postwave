/**
 * SubActionButton + ModalHeader — the two chrome primitives shared by the
 * subscriber detail action row and both of its sheets.
 *
 * They live in their own module rather than inside SubscriberDetailModals
 * so AddToListModal can use them without an import cycle.
 *
 * SubActionButton previously conveyed "busy" only by swapping its label
 * text and "disabled" only by dropping to 50% opacity, with no explanation
 * anywhere. Offline or read-only, all four detail actions greyed out and
 * the user was left to guess. `busy` now renders a spinner and sets
 * accessibilityState.busy; `disabledReason` is spoken as an
 * accessibilityHint — the mobile equivalent of desktop's
 * `bulkAvailabilityCopy` wired through aria-describedby.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubActionButton({
  label,
  onPress,
  danger,
  disabled,
  busy,
  disabledReason,
  t,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a spinner beside the label; also implies disabled. */
  busy?: boolean;
  /** Why the control is unavailable ("You're offline", "Read-only access"). */
  disabledReason?: string | undefined;
  t: ThemeTokens;
}) {
  const borderColor = danger ? t.danger : t.border;
  const fgColor = danger ? t.danger : t.fg;
  const inert = Boolean(disabled || busy);
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inert, busy: Boolean(busy) }}
      {...(inert && disabledReason ? { accessibilityHint: disabledReason } : {})}
      // NativeWind v4: never a function-style style prop on Pressable.
      style={{
        backgroundColor: t.bgSubtle,
        borderColor,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 10,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        opacity: inert ? 0.5 : 1,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={fgColor} /> : null}
      {/* `callout`, not a dense role: the action row wraps, the button's 44pt
          is a minHeight and the label has no numberOfLines, so this control
          genuinely can honour a large text setting. */}
      <Text
        {...typeCap("callout")}
        style={{
          color: fgColor,
          ...typeStyle("callout"),
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
  t,
}: {
  title: string;
  onClose: () => void;
  t: ThemeTokens;
}) {
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
          ...typeStyle("title"),
          fontWeight: "700",
          fontFamily: FONT.display,
        }}
        numberOfLines={2}
      >
        {title}
      </Text>
      <Pressable
        onPress={onClose}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          Cancel
        </Text>
      </Pressable>
    </View>
  );
}
