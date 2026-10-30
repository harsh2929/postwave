/**
 * StepEditorFooter — the validation message and the Cancel / Save pair.
 *
 * Lifted out of StepEditor for two reasons, in this order:
 *   - the editor's render function was the single longest in the package and
 *     already carried a legacy line-debt allowance; the footer is the one
 *     block in it that depends on nothing but the draft and two callbacks, so
 *     it is the cheapest honest split;
 *   - the save button's disabled state and the error text are ONE decision
 *     (`validateStep(draft)`) that was being taken twice — once in an inline
 *     IIFE for `invalid`, once again inside `onPress`. Taking it here, once,
 *     is what stops the two drifting into a button that is enabled while the
 *     draft is invalid.
 *
 * ACCESSIBILITY. `accessibilityState.disabled` is published beside the visual
 * `opacity: 0.5`, because a dimmed button conveys nothing to VoiceOver, and
 * the failure text is an `alert` so it is announced rather than silently
 * appearing above the buttons the user just pressed.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function StepEditorFooter({
  invalid,
  saveError,
  onCancel,
  onSave,
}: {
  invalid: boolean;
  saveError: string | null;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      {saveError ? (
        <Text
          {...typeCap("label")}
          accessibilityRole="alert"
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 16,
            fontFamily: FONT.regular,
          }}
        >
          {saveError}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 24 }}>
        <FooterButton label="Cancel" onPress={onCancel} />
        <FooterButton
          label="Save step"
          onPress={onSave}
          primary
          {...{ invalid }}
        />
      </View>
    </>
  );
}

function FooterButton({
  label,
  onPress,
  primary = false,
  invalid = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  invalid?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={invalid}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: invalid }}
      style={{
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        borderWidth: primary ? 0 : 1,
        borderColor: t.border,
        backgroundColor: primary ? t.accent : t.surface,
        alignItems: "center",
        opacity: invalid ? 0.5 : 1,
        minHeight: 44,
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("body")}
        style={{
          color: primary ? t.accentFg : t.fg,
          ...typeStyle("body"),
          fontWeight: primary ? "700" : "600",
          fontFamily: primary ? FONT.bold : FONT.semibold,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
