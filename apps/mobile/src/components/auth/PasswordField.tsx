/**
 * PasswordField — a password input with a Show/Hide reveal.
 *
 * Sign-in had a reveal toggle. Sign-up, password reset and account deletion —
 * where the rules demand 12+ characters and three keyboard-plane switches on a
 * phone — did not. That is exactly backwards: the reveal matters most where
 * the password is longest and typed blind.
 *
 * Visibility collapses on blur and on submit (matching desktop), so a revealed
 * password never survives a context switch onto the app-switcher snapshot.
 */
import { forwardRef, useState } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
} from "react-native";

import { authInputStyle } from "@/components/auth/authInputStyle";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface PasswordFieldProps
  extends Omit<TextInputProps, "secureTextEntry" | "style"> {
  value: string;
  onChangeText: (value: string) => void;
  /** Paints the danger border; pair with AuthField's error caption. */
  invalid?: boolean | undefined;
  /**
   * Override for surfaces outside the auth tree that already own an input
   * style — the Settings account-deletion card, whose sibling inputs would
   * otherwise sit on a different background than the password field.
   */
  inputStyle?: TextStyle | undefined;
}

export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(
  function PasswordField(
    { value, onChangeText, invalid, inputStyle, onBlur, onSubmitEditing, ...rest },
    ref,
  ) {
    const { t } = useTheme();
    const [visible, setVisible] = useState(false);

    return (
      <View style={{ position: "relative", justifyContent: "center" }}>
        <TextInput
          // The field's height is fixed by `authInputStyle`, so the text
          // inside it takes the `body` role's ceiling rather than scaling
          // freely and clipping its own descenders. Spread BEFORE `rest` so a
          // caller may still override it.
          {...typeCap("body")}
          {...rest}
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          onBlur={(event) => {
            setVisible(false);
            onBlur?.(event);
          }}
          onSubmitEditing={(event) => {
            setVisible(false);
            onSubmitEditing?.(event);
          }}
          // Static object — NativeWind v4 silently drops function-style styles.
          // NATIVE#44 — `paddingEnd`, not `paddingRight`: Android declares
          // supportsRtl=true, and on an RTL locale the physical value leaves
          // the reveal button sitting over the first characters typed.
          style={{
            ...(inputStyle ?? authInputStyle(t, { invalid: Boolean(invalid) })),
            paddingEnd: 64,
          }}
        />
        <Pressable
          onPress={() => setVisible((current) => !current)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={visible ? "Hide password" : "Show password"}
          accessibilityState={{ selected: visible }}
          style={{
            position: "absolute",
            insetInlineEnd: 10,
            top: 0,
            bottom: 0,
            minWidth: 44,
            minHeight: 44,
            paddingHorizontal: 4,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accent,
              ...typeStyle("label"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {visible ? "Hide" : "Show"}
          </Text>
        </Pressable>
      </View>
    );
  },
);
