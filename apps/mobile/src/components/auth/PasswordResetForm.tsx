import { useRef } from "react";
import { ActivityIndicator, Pressable, Text, TextInput } from "react-native";

import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import { announce } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  MIN_PASSWORD_LENGTH,
  passwordBlockingError,
} from "@/lib/passwordPolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function PasswordResetForm({
  password,
  confirm,
  busy,
  error,
  online,
  onPasswordChange,
  onConfirmChange,
  onSubmit,
  onBack,
}: {
  password: string;
  confirm: string;
  busy: boolean;
  error: string;
  online: boolean;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const { t } = useTheme();
  const confirmRef = useRef<TextInput>(null);
  const mismatch = confirm.length > 0 && password !== confirm;
  const blocking = passwordBlockingError(password);
  const disabled =
    busy || blocking !== null || password !== confirm;

  function submit(): void {
    if (blocking) {
      haptics.error();
      announce(blocking);
      return;
    }
    onSubmit();
  }

  return (
    <>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Enter a new password for your Moosewave account.
      </Text>
      <AuthField
        label="New password"
        {...(password && blocking ? { error: blocking } : {})}
      >
        <PasswordField
          value={password}
          onChangeText={onPasswordChange}
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          placeholderTextColor={t.fgSubtle}
          autoComplete="password-new"
          textContentType="newPassword"
          accessibilityLabel="New password"
          editable={!busy}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => confirmRef.current?.focus()}
          autoFocus
          invalid={Boolean(password) && blocking !== null}
        />
        <PasswordRequirements password={password} />
      </AuthField>
      <AuthField
        label="Confirm password"
        {...(mismatch ? { error: "Passwords do not match" } : {})}
      >
        <PasswordField
          ref={confirmRef}
          value={confirm}
          onChangeText={onConfirmChange}
          placeholder="Re-enter the new password"
          placeholderTextColor={t.fgSubtle}
          autoComplete="password-new"
          textContentType="newPassword"
          accessibilityLabel="Confirm new password"
          editable={!busy}
          returnKeyType="go"
          onSubmitEditing={submit}
          invalid={mismatch}
        />
      </AuthField>
      {error ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {error}
        </Text>
      ) : !online ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("bodySmall")}
          style={{
            color: t.warning,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          You&apos;re offline. Reconnect to reset your password.
        </Text>
      ) : null}
      <Pressable
        onPress={submit}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Reset password"
        accessibilityState={{ disabled, busy }}
        style={{
          marginTop: 16,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
          opacity: disabled ? 0.7 : 1,
        }}
      >
        {busy ? (
          <ActivityIndicator color={t.accentFg} />
        ) : (
          <Text
            {...typeCap("body")}
            style={{
              color: t.accentFg,
              fontWeight: "700",
              fontFamily: FONT.bold,
              ...typeStyle("body"),
            }}
          >
            Reset password
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={onBack}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Back to sign in"
        style={{
          marginTop: 10,
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: "center",
          backgroundColor: t.surface,
          opacity: busy ? 0.6 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Back
        </Text>
      </Pressable>
    </>
  );
}
