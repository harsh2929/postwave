/**
 * ApiKeyCredentialFields — the three fields of the API-key sign-in path.
 *
 * `app/(auth)/login.tsx` is the entry point for every automation and
 * power-user account, and it was the least-finished auth screen: no offline
 * guard, no autofocus, its own duplicated field wrapper and input style, and
 * errors passed straight through with no mapping. Extracting the fields lets
 * the route keep the probe/sign-in flow and gives this path the same labelled
 * wrapper and reveal-toggle treatment as every other auth screen.
 */
import { useRef } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { AuthField } from "@/components/auth/AuthField";
import { DEFAULT_API_BASE_URL } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ApiKeyCredentialFields({
  baseUrl,
  tenantId,
  apiKey,
  showKey,
  onBaseUrlChange,
  onTenantIdChange,
  onApiKeyChange,
  onToggleKey,
  onSubmit,
  onPaste,
  pasteHint,
}: {
  baseUrl: string;
  tenantId: string;
  apiKey: string;
  showKey: boolean;
  onBaseUrlChange: (value: string) => void;
  onTenantIdChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onToggleKey: () => void;
  onSubmit: () => void;
  /** MAP#63 — fills the key (or the server URL) from the clipboard. */
  onPaste: () => void;
  /** What the last paste found; announced politely, never as an error. */
  pasteHint?: string | undefined;
}) {
  const { t } = useTheme();
  const style = inputStyle(t);
  // Return-key chain: URL → workspace → key → sign in. This is the entry
  // point for every automation account and it was three keyboard dismissals.
  const tenantRef = useRef<TextInput>(null);
  const keyRef = useRef<TextInput>(null);

  return (
    <>
      <AuthField label="API base URL">
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={baseUrl}
          onChangeText={onBaseUrlChange}
          placeholder={DEFAULT_API_BASE_URL}
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="API base URL"
          {...keyboardChain({ next: tenantRef })}
          style={style}
          testID="login-base-url"
          autoFocus
        />
      </AuthField>

      <AuthField label="Workspace (tenant slug or UUID)">
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          ref={tenantRef}
          value={tenantId}
          onChangeText={onTenantIdChange}
          placeholder="acme"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Workspace tenant slug or UUID"
          {...keyboardChain({ next: keyRef })}
          style={style}
          testID="login-tenant"
        />
      </AuthField>

      <AuthField label="API key">
        <View style={{ position: "relative", justifyContent: "center" }}>
          <TextInput
            // Inputs scale with the OS text size but their height does not — cap it.
            {...typeCap("body")}
            ref={keyRef}
            value={apiKey}
            onChangeText={onApiKeyChange}
            placeholder="pw_live_…"
            placeholderTextColor={t.fgSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!showKey}
            accessibilityLabel="API key"
            // NATIVE#44 — logical, not physical. Android declares
            // supportsRtl=true, so on an RTL locale the field mirrors but a
            // hard `paddingRight` does not: the reveal button would sit on top
            // of the key's first characters.
            style={{ ...style, paddingEnd: 60 }}
            testID="login-api-key"
            {...keyboardChain({ onSubmit })}
          />
          <Pressable
            onPress={onToggleKey}
            accessibilityRole="button"
            accessibilityLabel={showKey ? "Hide API key" : "Show API key"}
            accessibilityState={{ selected: showKey }}
            hitSlop={8}
            style={{
              position: "absolute",
              insetInlineEnd: 12,
              top: 0,
              bottom: 0,
              minWidth: 44,
              minHeight: 44,
              paddingHorizontal: 4,
              alignItems: "center",
              justifyContent: "center",
            }}
            testID="login-toggle-key"
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.accent,
                ...typeStyle("bodySmall"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {showKey ? "Hide" : "Show"}
            </Text>
          </Pressable>
        </View>
      </AuthField>

      {/* MAP#63 — a pw_live_ key is ~40 characters of random case-sensitive
          text, and typing it on a phone keyboard was the only way in. The key
          always arrives on the device by being copied, so paste is the real
          affordance; the hint below says what the clipboard actually held so a
          wrong copy is one move to fix instead of three taps of guessing. */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          marginTop: -4,
          marginBottom: 8,
        }}
      >
        <Pressable
          onPress={onPaste}
          accessibilityRole="button"
          accessibilityLabel="Paste API key from clipboard"
          hitSlop={8}
          style={{
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 8,
            alignItems: "center",
            justifyContent: "center",
          }}
          testID="login-paste-key"
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.accent,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Paste from clipboard
          </Text>
        </Pressable>
      </View>

      {pasteHint ? (
        <Text
          accessibilityLiveRegion="polite"
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: -4,
            marginBottom: 8,
          }}
          testID="login-paste-hint"
        >
          {pasteHint}
        </Text>
      ) : null}
    </>
  );
}

/**
 * This screen's own visual treatment (surface background, 12pt radius) rather
 * than the email screens' subtler one — kept deliberately so the API-key path
 * stays visually distinct from the primary flow.
 */
function inputStyle(t: ReturnType<typeof useTheme>["t"]) {
  return {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    color: t.fg,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: FONT.regular,
  } as const;
}
