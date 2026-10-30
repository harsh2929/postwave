/**
 * PlatformConfigPrimitives — the handful of controls the three platform-
 * configuration sheets share, so each sheet is its own form and not a
 * re-declaration of a button.
 *
 *  - SurfaceAction: the one tappable line at the foot of a card that opens a
 *    sheet. Text-only and full-width so it reads as part of the card, not a
 *    second card.
 *  - SheetTitle / SheetNote / SheetButton: the sheet's heading, its caption
 *    lines (with a tone) and its footer buttons.
 *  - SheetHeader: SheetTitle beside the Close control, as every
 *    KeyboardFormSheet in this app is headed. Close is the only way out a
 *    sheet's footer does not repeat, so its label is never shared with a
 *    ConfirmSheet button.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SurfaceAction({
  label,
  onPress,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      style={{
        minHeight: 44,
        justifyContent: "center",
        marginTop: 4,
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accent,
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SheetTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, fontFamily: FONT.bold, ...typeStyle("title") }}
      >
        {title}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          marginTop: 4,
        }}
      >
        {subtitle}
      </Text>
    </View>
  );
}

export function SheetHeader({
  title,
  subtitle,
  onClose,
  closeLabel,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  /** Names the sheet for a screen reader: "Close signup firewall". */
  closeLabel: string;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <View style={{ flexShrink: 1 }}>
        <SheetTitle title={title} subtitle={subtitle} />
      </View>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        hitSlop={12}
        style={{
          minHeight: 44,
          minWidth: 44,
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            fontFamily: FONT.semibold,
            ...typeStyle("callout"),
          }}
        >
          Close
        </Text>
      </Pressable>
    </View>
  );
}

export type SheetNoteTone = "muted" | "danger" | "warning" | "success";

export function SheetNote({
  tone = "muted",
  children,
}: {
  tone?: SheetNoteTone;
  children: string;
}) {
  const { t } = useTheme();
  const color =
    tone === "danger"
      ? t.danger
      : tone === "warning"
        ? t.warning
        : tone === "success"
          ? t.success
          : t.fgMuted;
  return (
    <Text
      {...typeCap("caption")}
      {...(tone === "danger"
        ? { accessibilityRole: "alert" as const, accessibilityLiveRegion: "polite" as const }
        : {})}
      style={{ color, ...typeStyle("caption"), fontFamily: FONT.regular }}
    >
      {children}
    </Text>
  );
}

export function SheetButton({
  label,
  onPress,
  disabled = false,
  tone,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone: "primary" | "neutral" | "danger";
  accessibilityHint?: string;
}) {
  const { t } = useTheme();
  const filled = tone === "primary";
  const fg = filled ? t.accentFg : tone === "danger" ? t.danger : t.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      style={{
        flex: 1,
        borderRadius: 10,
        borderWidth: filled ? 0 : 1,
        borderColor: tone === "danger" ? t.danger : t.border,
        backgroundColor: filled ? t.accent : t.bgSubtle,
        alignItems: "center",
        justifyContent: "center",
        minHeight: 44,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: fg,
          fontFamily: filled ? FONT.bold : FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled group inside a sheet, with the card-style backdrop. */
export function SheetGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 10,
        marginBottom: 12,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.semibold,
          ...typeStyle("caption"),
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
