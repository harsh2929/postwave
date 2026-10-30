/**
 * The sending-settings form's two presentational primitives.
 *
 * Lifted verbatim out of app/(tabs)/sending-settings.tsx, which is the largest
 * screen in the deliverability cluster and hundreds of lines over its source
 * budget. Neither of these holds any sending policy — they are a labelled
 * TextInput with an error/hint slot and an outline button — so they are pure
 * chrome sitting at the bottom of an edit screen whose remaining length is all
 * behaviour worth reading.
 *
 * Exported under `Sending`-prefixed names because `Field` and `SecondaryButton`
 * are far too generic to own in a shared components directory; the screen
 * aliases them back at the import so no call site changed.
 */
import { Pressable, Text, TextInput, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export function SendingSecondaryButton({
  label,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  tone = "muted",
}: {
  label: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  tone?: "muted" | "danger";
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={{
        marginTop: 10,
        paddingVertical: 12,
        minHeight: 44,
        borderRadius: 12,
        borderColor: tone === "danger" ? t.danger : t.border,
        borderWidth: 1,
        backgroundColor: t.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: tone === "danger" ? t.danger : t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function SendingField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  returnKeyType,
  onSubmitEditing,
  inputRef,
  error,
  disabled = false,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad" | "numbers-and-punctuation";
  returnKeyType?: "next" | "done";
  onSubmitEditing?: () => void;
  inputRef?: React.RefObject<TextInput | null>;
  disabled?: boolean;
  // Explicit `| undefined` so callers can pass a possibly-undefined field
  // error under exactOptionalPropertyTypes without a non-null assertion.
  error?: string | undefined;
}) {
  const { t } = useTheme();
  const hasError = Boolean(error);
  return (
    <View style={{ marginBottom: 14 }}>
      {/* A field caption, not a heading: the input below already carries it
          as its accessible name, and a header role put all four fields into
          VoiceOver's rotor Headings list beside the screen title. */}
      <Text
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
        {label}
      </Text>
      <TextInput
        {...(inputRef ? { ref: inputRef } : {})}
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onChangeText={onChangeText}
        editable={!disabled}
        placeholder={placeholder ?? ""}
        placeholderTextColor={t.fgSubtle}
        keyboardType={keyboardType ?? "default"}
        returnKeyType={returnKeyType ?? "done"}
        {...(onSubmitEditing ? { onSubmitEditing } : {})}
        blurOnSubmit={returnKeyType !== "next"}
        autoCapitalize="none"
        autoCorrect={false}
        // A TextInput scales with the OS text setting exactly like a Text.
        {...typeCap("body")}
        style={{
          backgroundColor: t.surface,
          borderColor: hasError ? t.danger : t.border,
          borderWidth: 1,
          color: t.fg,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          // Size only: an explicit lineHeight mis-centres the caret.
          fontSize: fontSizeFor("body"),
          fontFamily: FONT.regular,
          opacity: disabled ? 0.6 : 1,
        }}
        accessibilityState={{ disabled }}
      />
      {hasError ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
