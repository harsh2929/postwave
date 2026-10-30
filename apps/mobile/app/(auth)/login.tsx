/**
 * Login screen.
 *
 * Pairing model: long-lived API keys minted from the Moosewave web admin.
 * Users paste:
 *   - Workspace base URL  (e.g. https://api.moosewave.com or self-hosted)
 *   - Tenant slug         (the workspace they want to access)
 *   - API key             (pw_live_…)
 *
 * The form probes /api/v1/me with the supplied credentials before
 * committing — better to fail at sign-in than the first dashboard query.
 *
 * This is the legacy / power-user fallback reached from the email
 * sign-in screen via "I have an API key". A "Use email & password
 * instead" link routes back so users aren't stranded here.
 */
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PostwaveClient } from "@postwave/sdk";

import { redactAuthError } from "@/api/auth";
import { LegalLinks } from "@/components/LegalLinks";
import { TextLink } from "@/components/TextLink";
import { ApiKeyCredentialFields } from "@/components/auth/ApiKeyCredentialFields";
import { useIsOnline } from "@/hooks/useIsOnline";
import { announce } from "@/lib/a11y";
import { CONNECTION_COPY, OFFLINE_COPY } from "@/lib/authErrorCopy";
import { rememberLastBaseUrl, readLastBaseUrl } from "@/lib/authPrefs";
import { DEFAULT_API_BASE_URL, validateApiBaseUrl } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  interpretPairingPaste,
  pairingPasteMessage,
} from "@/lib/pairingClipboard";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";
import { pathLabel } from "@/lib/direction";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function Login() {
  const { t } = useTheme();
  const online = useIsOnline();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [tenantId, setTenantId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the last clipboard paste found. Separate from `error`: a paste that
  // held the wrong thing is information, not a failed sign-in attempt.
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  // Local pending flag. The store only flips `signingIn` once signIn()
  // runs — which is *after* the /me probe completes — so without this the
  // button stays enabled (and spinner-less) for the whole probe window
  // (up to the SDK's 30s timeout), letting a user fire N concurrent probes.
  const [probing, setProbing] = useState(false);

  const signIn = useAuthStore((s) => s.signIn);
  const signingIn = useAuthStore((s) => s.signingIn);
  const busy = probing || signingIn;

  // The server address is not a credential, so it survives sign-out.
  useEffect(() => {
    let cancelled = false;
    void readLastBaseUrl().then((stored) => {
      if (!cancelled && stored) setBaseUrl(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function fail(message: string): void {
    haptics.error();
    setError(message);
    announce(message);
  }

  /**
   * MAP#63 — paste instead of typing a 40-character secret on a phone.
   *
   * Reading the clipboard is a privileged act (iOS shows its own paste
   * confirmation), so it happens ONLY on this explicit tap, never on focus or
   * on mount. The interpretation is pure and tested (lib/pairingClipboard);
   * this only decides which field the verdict lands in. A clipboard read that
   * throws — a locked device, an unsupported item type — is reported as a
   * hint, not as a sign-in error, because nothing about the form is wrong yet.
   */
  async function onPaste(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await Clipboard.getStringAsync();
    } catch {
      setPasteHint("Couldn't read the clipboard on this device.");
      announce("Couldn't read the clipboard on this device.");
      return;
    }
    const verdict = interpretPairingPaste(raw);
    if (verdict.kind === "apiKey") {
      setApiKey(verdict.apiKey);
      setError(null);
      haptics.tap();
    } else if (verdict.kind === "baseUrl") {
      setBaseUrl(verdict.baseUrl);
      setError(null);
      haptics.tap();
    } else {
      haptics.warning();
    }
    const message = pairingPasteMessage(verdict);
    setPasteHint(message);
    announce(message);
  }

  async function onSubmit() {
    // Guard double-submit across the whole flow: `probing` covers the
    // network probe, `signingIn` covers the store's persist step. Either
    // being true means a submit is already in flight.
    if (busy) return;
    setError(null);
    if (!baseUrl.trim() || !tenantId.trim() || !apiKey.trim()) {
      fail("All three fields are required.");
      return;
    }
    const validBaseUrl = validateApiBaseUrl(baseUrl);
    if (!validBaseUrl.ok) {
      fail(validBaseUrl.message);
      return;
    }
    // Say "you're offline" instead of spending the SDK's full timeout.
    if (!online) {
      fail(OFFLINE_COPY);
      return;
    }
    // Cheap shape check — Moosewave keys are minted as `pw_…`. Catches the
    // common paste-the-wrong-thing mistake before a network round-trip.
    if (!apiKey.trim().startsWith("pw_")) {
      fail("That doesn't look like a Moosewave API key (expected pw_…).");
      return;
    }
    setProbing(true);
    try {
      const cleanBaseUrl = validBaseUrl.url;
      const cleanTenantId = tenantId.trim();
      const cleanApiKey = apiKey.trim();
      const client = new PostwaveClient({
        apiKey: cleanApiKey,
        baseUrl: cleanBaseUrl,
        tenantId: cleanTenantId,
        retries: 0,
      });
      await client.request("GET", "/api/v1/me");
      await signIn({
        baseUrl: cleanBaseUrl,
        tenantId: cleanTenantId,
        apiKey: cleanApiKey,
      });
      void rememberLastBaseUrl(cleanBaseUrl);
      haptics.success();
      router.replace("/(tabs)/dashboard");
    } catch (e) {
      fail(formatSignInError(e));
    } finally {
      setProbing(false);
    }
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.bg }}
      edges={["top", "bottom"]}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: 24,
            paddingVertical: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ marginBottom: 32 }}>
            <Text
              accessibilityRole="header"
              {...typeCap("display")}
              style={{
                color: t.fg,
                ...typeStyle("display"),
                fontWeight: "600",
                fontFamily: FONT.display,
                letterSpacing: -0.4,
                marginBottom: 8,
              }}
            >
              Connect Moosewave
            </Text>
            <Text
              {...typeCap("body")}
              style={{
                color: t.fgMuted,
                ...typeStyle("body"),
                fontFamily: FONT.regular,
              }}
            >
              Paste an API key from your workspace settings. Stored encrypted on
              this device only.
            </Text>
          </View>

          <ApiKeyCredentialFields
            baseUrl={baseUrl}
            tenantId={tenantId}
            apiKey={apiKey}
            showKey={showKey}
            onBaseUrlChange={setBaseUrl}
            onTenantIdChange={setTenantId}
            onApiKeyChange={setApiKey}
            onToggleKey={() => setShowKey((v) => !v)}
            onSubmit={() => void onSubmit()}
            onPaste={() => void onPaste()}
            {...(pasteHint ? { pasteHint } : {})}
          />

          {error ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 4,
                marginBottom: 8,
              }}
              testID="login-error"
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
                fontFamily: FONT.regular,
                marginTop: 4,
                marginBottom: 8,
              }}
            >
              You&apos;re offline. Reconnect to verify this key.
            </Text>
          ) : null}

          <Pressable
            onPress={() => void onSubmit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            accessibilityState={{ disabled: busy, busy }}
            style={{
              marginTop: 8,
              paddingVertical: 16,
              borderRadius: 12,
              backgroundColor: t.accent,
              alignItems: "center",
              opacity: busy ? 0.7 : 1,
            }}
            testID="login-submit"
          >
            {busy ? (
              <ActivityIndicator color={t.accentFg} />
            ) : (
              <Text
                {...typeCap("body")}
                style={{
                  color: t.accentFg,
                  fontWeight: "600",
                  fontFamily: FONT.semibold,
                  ...typeStyle("body"),
                }}
              >
                Sign in
              </Text>
            )}
          </Pressable>

          <Text
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              textAlign: "center",
              marginTop: 24,
            }}
          >
            {`Mint a key at ${pathLabel([
              "app.postwave.io",
              "Settings",
              "API keys",
            ])}.`}
          </Text>

          <View
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTopWidth: 1,
              borderColor: t.borderSubtle,
              alignItems: "center",
            }}
          >
            <TextLink
              onPress={() => router.push("/(auth)/sign-in")}
              textStyle={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              Use email &amp; password instead
            </TextLink>
          </View>

          <View style={{ marginTop: 16 }}>
            <LegalLinks />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * The API-key probe goes through the SDK's PostwaveClient (not the
 * AuthResult envelope), so we get raw Error objects. Redact backend
 * internals and give offline failures a friendlier message than a bare
 * "Network request failed".
 */
function formatSignInError(e: unknown): string {
  if (!(e instanceof Error)) return "Sign-in failed (unknown error)";
  const msg = e.message || "";
  if (/network request failed|failed to fetch|network error/i.test(msg)) {
    return CONNECTION_COPY;
  }
  if (/^HTTP\s+40[13]$/i.test(msg) || /unauthorized|forbidden/i.test(msg)) {
    return "That key was rejected. Check the key and the workspace it belongs to.";
  }
  if (/^HTTP\s+\d{3}$/i.test(msg)) {
    return "Moosewave is temporarily unavailable. Please try again.";
  }
  return redactAuthError(msg);
}
