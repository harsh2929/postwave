/**
 * The small shared parts of the "describe an audience" sheet, split out
 * because the sheet itself hit its size budget and because the AI escalation
 * card carries a rule worth isolating: nothing leaves the deployment without
 * the server's own processing disclosure being on screen next to the button
 * that sends it.
 */
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FieldLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        letterSpacing: 0.6,
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        marginBottom: 4,
      }}
    >
      {children}
    </Text>
  );
}

/** A muted micro-line: rationale, provenance, a disabled-reason sentence. */
export function MicroLine({
  children,
  tone = "subtle",
}: {
  children: string;
  tone?: "subtle" | "muted" | "strong" | "warning";
}) {
  const { t } = useTheme();
  const color =
    tone === "warning"
      ? t.warning
      : tone === "strong"
        ? t.fg
        : tone === "muted"
          ? t.fgMuted
          : t.fgSubtle;
  return (
    <Text
      {...typeCap("label")}
      style={{
        color,
        ...typeStyle("label"),
        fontFamily: tone === "strong" ? FONT.semibold : FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

export function PrimaryButton({
  label,
  busy,
  disabled,
  onPress,
  accessibilityLabel,
  disabledReason,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  disabledReason?: string | undefined;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      {...(disabledReason ? { accessibilityHint: disabledReason } : {})}
      accessibilityState={{ disabled, busy }}
      // Static style object: a function-style `style` on a Pressable silently
      // drops layout under NativeWind v4.
      style={{
        marginTop: 18,
        minHeight: 48,
        borderRadius: 12,
        backgroundColor: t.accent,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {busy ? <ActivityIndicator size="small" color={t.accentFg} /> : null}
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accentFg,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The AI escalation. A card rather than a bare button because the decision
 * needs the disclosure beside it — this is the moment the operator's prose
 * leaves the deployment, and the handler models the acknowledgement as
 * per-request for exactly that reason.
 */
export function AIRetry({
  lines,
  onRetry,
}: {
  lines: { label: string; value: string }[];
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 6,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
        }}
      >
        Try the AI compiler?
      </Text>
      <MicroLine tone="muted">
        Your description is sent for external processing. Nothing is sent
        unless you tap below.
      </MicroLine>
      {lines.map((line) => (
        <MicroLine key={line.label}>{`${line.label}: ${line.value}`}</MicroLine>
      ))}
      <Pressable
        onPress={() => {
          haptics.tap();
          onRetry();
        }}
        accessibilityRole="button"
        accessibilityLabel="Send this description to the AI compiler"
        style={{
          minHeight: 44,
          borderRadius: 10,
          borderColor: t.border,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
          marginTop: 2,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
          }}
        >
          Send and compile
        </Text>
      </Pressable>
    </View>
  );
}
