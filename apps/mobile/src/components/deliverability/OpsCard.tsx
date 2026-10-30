/**
 * OpsCard — the shared skeleton of the recovery/evidence cards added in the
 * 2026-08 desktop-parity pass.
 *
 * Every card in that cluster is the same three-part sandwich: a bordered
 * surface, an uppercase caption naming the resource, and a muted body line
 * carrying the verdict or the honest failure. Extracted once so thirteen
 * cards do not carry thirteen drifting copies of the same styles.
 */
import { Pressable, Text, TextInput, View, type ViewStyle } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function OpsCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
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
        marginBottom: 10,
        gap: 10,
        ...style,
      }}
    >
      {children}
    </View>
  );
}

export function OpsCardTitle({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontFamily: FONT.bold,
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

export function OpsCardBody({
  children,
  role,
}: {
  children: string;
  role?: "alert";
}) {
  const { t } = useTheme();
  return (
    <Text
      {...(role === "alert" ? { accessibilityRole: "alert" as const } : {})}
      {...typeCap("bodySmall")}
      style={{
        color: t.fgMuted,
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

/** The 44pt accent text-button every card uses for its verb. */
export function OpsAction({
  label,
  onPress,
  disabled = false,
  destructive = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={{
        alignSelf: "flex-start",
        minHeight: 44,
        justifyContent: "center",
        paddingHorizontal: 2,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{
          color: disabled ? t.fgSubtle : destructive ? t.danger : t.accent,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The shared bordered text field of the ops cluster's small forms. */
export function OpsTextInput({
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  keyboardType = "default",
  secureTextEntry = false,
  multiline = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  keyboardType?: "default" | "email-address" | "number-pad" | "url";
  secureTextEntry?: boolean;
  multiline?: boolean;
}) {
  const { t } = useTheme();
  return (
    <TextInput
      // The field scales with the OS text size but its 44pt box does not.
      {...typeCap("bodySmall")}
      value={value}
      onChangeText={onChangeText}
      accessibilityLabel={accessibilityLabel}
      placeholder={placeholder}
      placeholderTextColor={t.fgSubtle}
      keyboardType={keyboardType}
      secureTextEntry={secureTextEntry}
      multiline={multiline}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        backgroundColor: t.bg,
        borderColor: t.border,
        borderWidth: 1,
        color: t.fg,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: multiline ? 80 : 44,
        textAlignVertical: multiline ? "top" : "center",
        ...typeStyle("bodySmall"),
        fontFamily: FONT.regular,
      }}
    />
  );
}
