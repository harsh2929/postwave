/**
 * PasswordResetRequestForm — the "enter your email" half of forgot-password.
 *
 * Extracted from the route module so the screen keeps the flow logic and this
 * keeps the form. Three fixes travel with it:
 *   - the shared `authInputStyle`, because this file's local copy silently
 *     omitted `fontFamily: FONT.regular` and rendered in the system font while
 *     every sibling auth input rendered in Inter;
 *   - a Send button that visibly re-arms after a rate-limit, instead of
 *     letting the user tap themselves deeper into a lockout;
 *   - the API-URL field is revealed by the screen whenever a base-URL
 *     validation error fires, so the message is never about a hidden field.
 */
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
} from "react-native";

import { authInputStyle } from "@/components/auth/authInputStyle";
import { DEFAULT_API_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardDismiss } from "@/lib/keyboardChain";

export function PasswordResetRequestForm({
  baseUrl,
  email,
  error,
  busy,
  online,
  showApi,
  resendSeconds,
  onToggleApi,
  onBaseUrlChange,
  onEmailChange,
  onSubmit,
  onBack,
}: {
  baseUrl: string;
  email: string;
  error: string;
  busy: boolean;
  online: boolean;
  showApi: boolean;
  resendSeconds: number;
  onToggleApi: () => void;
  onBaseUrlChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const { t } = useTheme();
  const coolingDown = resendSeconds > 0;
  const disabled = busy || coolingDown;

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
        Enter your account email and we&apos;ll send a link to choose a new
        password.
      </Text>
      <Pressable
        onPress={onToggleApi}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={
          showApi ? "Hide API base URL field" : "Change API base URL"
        }
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginBottom: 6,
          }}
          numberOfLines={1}
        >
          {showApi ? "Hide API server" : `Connecting to ${baseUrl}`}
        </Text>
      </Pressable>
      {showApi ? (
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={baseUrl}
          onChangeText={onBaseUrlChange}
          editable={!busy}
          accessibilityLabel="API base URL"
          placeholder={DEFAULT_API_BASE_URL}
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          {...keyboardDismiss()}
          style={{ ...authInputStyle(t), marginBottom: 14 }}
        />
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
          letterSpacing: 0.5,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Email
      </Text>
      <TextInput
        // Inputs scale with the OS text size but their height does not — cap it.
        {...typeCap("body")}
        value={email}
        onChangeText={onEmailChange}
        onSubmitEditing={onSubmit}
        returnKeyType="send"
        editable={!busy}
        accessibilityLabel="Account email"
        placeholder="you@example.com"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        autoFocus
        style={authInputStyle(t)}
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
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
          accessibilityLiveRegion="polite"
          {...typeCap("bodySmall")}
          style={{
            color: t.warning,
            ...typeStyle("bodySmall"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          You&apos;re offline. Reconnect to send a reset link.
        </Text>
      ) : null}
      <Pressable
        onPress={onSubmit}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={
          coolingDown
            ? `Send available again in ${resendSeconds} seconds`
            : "Send reset link"
        }
        accessibilityState={{ disabled, busy }}
        style={{
          marginTop: 16,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: t.accent,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
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
            {coolingDown ? `Try again in ${resendSeconds}s` : "Send reset link"}
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={{
          marginTop: 10,
          paddingVertical: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 44,
          backgroundColor: t.surface,
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
