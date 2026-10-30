/**
 * Sign-up — creates a new tenant + owner user. Backend requires a
 * 12-char password and a unique workspace slug. We mirror those rules
 * client-side (live strength meter, slug validation) to avoid the
 * round-trip on bad input.
 *
 * On 201 the backend sets the pw_session cookie. We then GET /me to
 * snapshot the profile (so settings can render "signed in as …") and
 * route from the canonical MFA fields returned by /me.
 */
import { router } from "expo-router";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { LegalLinks } from "@/components/LegalLinks";
import { TextLink } from "@/components/TextLink";
import { AuthField } from "@/components/auth/AuthField";
import { authInputStyle } from "@/components/auth/authInputStyle";
import { PasswordField } from "@/components/auth/PasswordField";
import { PasswordRequirements } from "@/components/auth/PasswordRequirements";
import {
  createAuthClient,
  isValidWorkspaceSlug,
  redactAuthError,
  suggestWorkspaceSlug,
} from "@/api/auth";
import { useIsOnline } from "@/hooks/useIsOnline";
import { announce } from "@/lib/a11y";
import { OFFLINE_COPY, signUpErrorMessage } from "@/lib/authErrorCopy";
import { DEFAULT_API_BASE_URL, validateApiBaseUrl } from "@/lib/config";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { passwordBlockingError } from "@/lib/passwordPolicy";
// MAP#53 — one tested predicate, shared with sign-in. Two byte-identical
// private copies is how "accepted at sign-up, rejected at sign-in" starts.
import { isLikelyEmail } from "@/lib/signInForm";
import { WorkspaceSlugField } from "@/components/auth/WorkspaceSlugField";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  destinationForSession,
  sessionProfileFromMe,
  useAuthStore,
} from "@/store/auth";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

export default function SignUp() {
  const { t } = useTheme();
  const online = useIsOnline();
  const passwordRef = useRef<TextInput>(null);
  const workspaceRef = useRef<TextInput>(null);
  const slugRef = useRef<TextInput>(null);
  const signInSession = useAuthStore((s) => s.signInSession);
  const prepareForSessionAuthentication = useAuthStore(
    (s) => s.prepareForSessionAuthentication,
  );

  const [baseUrl] = useState(DEFAULT_API_BASE_URL);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Aligned to the server's only rule (len >= 12). The character-class rules
  // are advice, so a long passphrase is no longer rejected behind a greyed-out
  // button with nothing to explain it.
  const passwordBlocked = passwordBlockingError(password);

  function fail(message: string): void {
    haptics.error();
    setError(message);
    announce(message);
  }

  function onWorkspaceNameChange(v: string) {
    setWorkspaceName(v);
    if (error) setError("");
    if (!slugTouched) setWorkspaceSlug(suggestWorkspaceSlug(email, v));
  }

  async function onSubmit() {
    if (busy) return;
    setError("");
    if (!email.trim() || !password) {
      fail("Email and password are required");
      return;
    }
    if (!isLikelyEmail(email)) {
      fail("Enter a valid email address");
      return;
    }
    if (passwordBlocked) {
      fail(passwordBlocked);
      passwordRef.current?.focus();
      return;
    }
    if (!workspaceName.trim()) {
      fail("Workspace name is required");
      workspaceRef.current?.focus();
      return;
    }
    const slug = workspaceSlug || suggestWorkspaceSlug(email, workspaceName);
    if (!isValidWorkspaceSlug(slug)) {
      fail(
        "Workspace slug: 1–40 chars, lowercase, digits and hyphens; no leading or trailing hyphen",
      );
      slugRef.current?.focus();
      return;
    }
    // Say "you're offline" before spending the full 15s auth timeout.
    if (!online) {
      fail(OFFLINE_COPY);
      return;
    }
    const validBaseUrl = validateApiBaseUrl(baseUrl);
    if (!validBaseUrl.ok) {
      fail(validBaseUrl.message);
      return;
    }
    setBusy(true);
    const api = createAuthClient(validBaseUrl.url);
    try {
      await prepareForSessionAuthentication();
    } catch (err) {
      setBusy(false);
      setError(
        redactAuthError(
          err instanceof Error ? err.message : "Secure sign-out is pending",
        ),
      );
      return;
    }
    const res = await api.signup({
      email: email.trim(),
      password,
      workspace_name: workspaceName.trim(),
      workspace_slug: slug,
    });
    if (res.error) {
      setBusy(false);
      fail(signUpErrorMessage(res.error));
      return;
    }
    // Cookie is set; load /me and persist the profile, then route.
    const me = await api.getMe();
    if (me.error || !me.data) {
      await useAuthStore.getState().cancelSession(api.baseUrl);
      setBusy(false);
      fail(me.error ? signUpErrorMessage(me.error) : "Couldn't load profile");
      return;
    }
    const profile = sessionProfileFromMe(me.data);
    try {
      await signInSession({
        baseUrl: api.baseUrl,
        profile,
      });
    } catch {
      // signInSession throws on an unusable /me profile or a SecureStore
      // write failure. The account already exists (signup 201) and the
      // cookie was set — signInSession revokes or journals it before this
      // error is shown, so retrying cannot inherit a half-persisted session.
      setBusy(false);
      fail("Couldn't finish signing you in. Please try signing in.");
      return;
    }
    setBusy(false);
    haptics.success();
    router.replace(destinationForSession(profile));
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
          contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ marginBottom: 18, marginTop: 12 }}>
            <Text
              accessibilityRole="header"
              {...typeCap("display")}
              style={{
                color: t.fg,
                ...typeStyle("display"),
                fontWeight: "700",
                fontFamily: FONT.display,
                letterSpacing: -0.4,
                marginBottom: 6,
              }}
            >
              Create your workspace
            </Text>
            <Text
              {...typeCap("callout")}
              style={{
                color: t.fgMuted,
                ...typeStyle("callout"),
                fontFamily: FONT.regular,
              }}
            >
              You&apos;ll be the owner. You can invite teammates later from
              workspace settings.
            </Text>
          </View>

          <AuthField label="Email">
            <TextInput
              // Inputs scale with the OS text size but their height does not — cap it.
              {...typeCap("body")}
              value={email}
              onChangeText={(v) => {
                setEmail(v);
                if (error) setError("");
              }}
              placeholder="you@example.com"
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              accessibilityLabel="Email address"
              autoFocus
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => passwordRef.current?.focus()}
              style={authInputStyle(t)}
            />
          </AuthField>

          <AuthField
            label="Password"
            {...(password && passwordBlocked ? { error: passwordBlocked } : {})}
          >
            <PasswordField
              ref={passwordRef}
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (error) setError("");
              }}
              placeholder="At least 12 characters"
              placeholderTextColor={t.fgSubtle}
              autoComplete="password-new"
              textContentType="newPassword"
              accessibilityLabel="Password, at least 12 characters"
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => workspaceRef.current?.focus()}
              invalid={Boolean(password) && passwordBlocked !== null}
            />
            <PasswordRequirements password={password} />
          </AuthField>

          <AuthField label="Workspace name">
            <TextInput
              // Inputs scale with the OS text size but their height does not — cap it.
              {...typeCap("body")}
              ref={workspaceRef}
              value={workspaceName}
              onChangeText={onWorkspaceNameChange}
              placeholder="Acme Co"
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="words"
              accessibilityLabel="Workspace name"
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => slugRef.current?.focus()}
              style={authInputStyle(t)}
            />
          </AuthField>

          <WorkspaceSlugField
            ref={slugRef}
            value={workspaceSlug}
            onChangeText={(v) => {
              setSlugTouched(true);
              setWorkspaceSlug(v);
              if (error) setError("");
            }}
            onSubmitEditing={() => void onSubmit()}
          />

          {!online ? (
            <Text
              accessibilityLiveRegion="polite"
              {...typeCap("bodySmall")}
              style={{
                color: t.warning,
                ...typeStyle("bodySmall"),
                marginBottom: 8,
                fontFamily: FONT.regular,
              }}
            >
              You&apos;re offline. Reconnect to create your workspace.
            </Text>
          ) : null}

          {error ? (
            <Text
              accessibilityRole="alert"
              {...typeCap("bodySmall")}
              style={{
                color: t.danger,
                ...typeStyle("bodySmall"),
                marginVertical: 8,
                fontFamily: FONT.regular,
              }}
            >
              {error}
            </Text>
          ) : null}

          <Pressable
            onPress={() => void onSubmit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Create account"
            accessibilityHint={
              passwordBlocked ?? "Creates your workspace and signs you in."
            }
            accessibilityState={{ disabled: busy, busy }}
            testID="signup-submit"
            style={{
              marginTop: 6,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: t.accent,
              alignItems: "center",
              opacity: busy ? 0.6 : 1,
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
                Create account
              </Text>
            )}
          </Pressable>

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 12,
              fontFamily: FONT.regular,
            }}
          >
            By signing up you agree to Moosewave&apos;s Terms and Privacy Policy.
            We&apos;ll send a verification email; you can verify later from
            Settings.
          </Text>

          <View style={{ marginTop: 10 }}>
            <LegalLinks
              links={[
                { key: "terms", label: "Terms" },
                { key: "privacy", label: "Privacy" },
              ]}
            />
          </View>

          <View style={{ alignItems: "center", marginTop: 18 }}>
            <TextLink
              onPress={() => router.push("/(auth)/sign-in")}
              textStyle={{
                color: t.accent,
                ...typeStyle("bodySmall"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Already have an account? Sign in
            </TextLink>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
