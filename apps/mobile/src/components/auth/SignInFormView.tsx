/**
 * SignInFormView — the credential form. Presentation only.
 *
 * Every decision this file appears to make was already made by
 * `useSignInController` (state, network, focus, announcements) or by the two
 * pure modules behind it (`lib/signInForm` for per-field verdicts,
 * `lib/signInFlow` for the order of refusals). What is left here is layout,
 * and the handful of native props that only exist at the element: keyboard
 * type, autofill hints, return-key behaviour and the Dynamic Type ceilings.
 *
 * Mirrors apps/desktop/src/pages/sign-in/SignInFormView.tsx.
 */
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiBaseUrlField } from "@/components/auth/ApiBaseUrlField";
import { AuthField } from "@/components/auth/AuthField";
import { authInputStyle } from "@/components/auth/authInputStyle";
import { AuthStatusLine } from "@/components/auth/AuthStatusLine";
import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { AuthWarning } from "@/components/auth/AuthWarning";
import {
  AuthMethodDivider,
  OAuthSignInButton,
} from "@/components/auth/OAuthSignInButton";
import { PasswordField } from "@/components/auth/PasswordField";
import { SignInFooterLinks } from "@/components/auth/SignInFooterLinks";
import { SignInHeader } from "@/components/auth/SignInHeader";
import { WorkspacePicker } from "@/components/auth/WorkspacePicker";
import { SegmentedControl } from "@/components/SegmentedControl";
import type { SignInController } from "@/hooks/useSignInController";
import { SIGN_IN_METHODS } from "@/lib/signInForm";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export interface SignInFormViewProps {
  controller: SignInController;
  onForgotPassword: () => void;
  onCreateAccount: () => void;
  onUseAnotherDevice: () => void;
  onUseApiKey: () => void;
}

export function SignInFormView({
  controller: c,
  onForgotPassword,
  onCreateAccount,
  onUseAnotherDevice,
  onUseApiKey,
}: SignInFormViewProps) {
  const { t } = useTheme();
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
          <SignInHeader
            title="Sign in to Moosewave"
            subtitle={
              c.magicMode
                ? "We'll email you a link that signs you in. No password needed."
                : "Use your workspace email and password."
            }
          />

          {c.authWarning ? (
            <AuthWarning
              message={c.authWarning}
              busy={c.busy}
              showRetry={c.localCleanupPending}
              onRetry={c.onRetryCleanup}
              onDismiss={c.onDismissWarning}
            />
          ) : null}

          <ApiBaseUrlField
            value={c.baseUrl}
            expanded={c.apiFieldExpanded}
            onToggle={c.onToggleApiField}
            onChange={c.onChangeBaseUrl}
          />

          <View style={{ marginBottom: 14 }}>
            <SegmentedControl
              options={SIGN_IN_METHODS}
              value={c.method}
              onChange={c.onChangeMethod}
              accessibilityLabel="Sign-in method"
            />
          </View>

          <AuthField label="Email" {...c.fieldError("email")}>
            <TextInput
              // Inputs scale with the OS text size but their height does not — cap it.
              {...typeCap("body")}
              ref={c.refs.email}
              value={c.email}
              onChangeText={c.onChangeEmail}
              placeholder="you@example.com"
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              style={authInputStyle(t, { invalid: Boolean(c.errors.email) })}
              // The invalid signal is the danger border PLUS AuthField's
              // caption; RN's accessibilityState has no `invalid` member, so
              // colour alone would be the only cue without that caption.
              accessibilityLabel="Email"
              testID="signin-email"
              autoFocus
              returnKeyType={c.magicMode ? "go" : "next"}
              blurOnSubmit={c.magicMode}
              onSubmitEditing={c.onEmailSubmitEditing}
            />
          </AuthField>

          {c.magicMode ? null : (
            <AuthField label="Password" {...c.fieldError("password")}>
              <PasswordField
                ref={c.refs.password}
                value={c.password}
                onChangeText={c.onChangePassword}
                placeholder="••••••••••••"
                placeholderTextColor={t.fgSubtle}
                autoComplete="password"
                textContentType="password"
                accessibilityLabel="Password"
                testID="signin-password"
                returnKeyType="go"
                onSubmitEditing={c.onSubmitPrimary}
                invalid={Boolean(c.errors.password)}
              />
            </AuthField>
          )}

          {c.needsWorkspace ? (
            <WorkspacePicker
              workspaces={c.needsWorkspace.workspaces}
              selected={c.pickedWorkspace}
              onSelect={c.onSelectWorkspace}
              headingRef={c.refs.pickerHeading}
            />
          ) : null}

          <AuthStatusLine
            error={c.error}
            offline={!c.online}
            offlineMessage="You're offline. Reconnect to sign in."
            testID="signin-error"
          />

          <AuthSubmitButton
            label={c.submit.label}
            accessibilityLabel={c.submit.accessibilityLabel}
            onPress={c.onSubmitPrimary}
            disabled={c.submit.disabled}
            busy={c.busy}
            testID="signin-submit"
          />

          {/* AUTH#2 — the workspace-picker step is a password submit in
              progress; offering a different identity mid-flow would discard it
              silently. Hidden once the server has said this deployment has no
              Google provider, so it is never a permanent dead end. */}
          {c.google.available && !c.needsWorkspace ? (
            <>
              <AuthMethodDivider />
              <OAuthSignInButton
                onPress={c.google.start}
                busy={c.google.busy}
                disabled={c.busy || c.localCleanupPending}
                testID="signin-google"
              />
            </>
          ) : null}

          <SignInFooterLinks
            onForgotPassword={onForgotPassword}
            onCreateAccount={onCreateAccount}
            onUseAnotherDevice={onUseAnotherDevice}
            onUseApiKey={onUseApiKey}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
