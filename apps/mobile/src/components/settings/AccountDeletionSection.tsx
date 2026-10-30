import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  accountDeletionErrorCode,
  buildAccountDeletionInput,
  canSubmitAccountDeletion,
  deleteOwnAccount,
} from "@/api/accountDeletion";
import { PasswordField } from "@/components/auth/PasswordField";
import { useDoneAccessory } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { redactAuthError } from "@/api/auth";
import { FONT } from "@/lib/fonts";
import { unregisterPushThenSignOut } from "@/lib/push";
import { runSignOut } from "@/lib/signOutFlow";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";
import { keyboardChain, keyboardDismiss } from "@/lib/keyboardChain";

export function AccountDeletionSection() {
  const { t } = useTheme();
  const mode = useAuthStore((state) => state.mode);
  const session = useAuthStore((state) => state.session);
  const signOut = useAuthStore((state) => state.signOut);
  const [expanded, setExpanded] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Declared above the early return so the hook order is stable. The TOTP
  // field is a number pad inside an expanded panel; with no accessory bar the
  // only way to dismiss that keyboard is to tap away, which collapses the
  // panel and discards the confirmation phrase typed above it.
  const mfaDone = useDoneAccessory("number-pad");
  // Confirmation phrase → password → authenticator code. The chain only
  // ADVANCES; the delete itself stays behind the button (see below).
  const passwordRef = useRef<TextInput>(null);
  const mfaRef = useRef<TextInput>(null);

  if (mode !== "session" || !session) return null;

  const complete = canSubmitAccountDeletion({
    confirmation,
    authProvider: session.authProvider,
    password,
    hasTotp: session.hasTotp,
    mfaCode,
  });

  /**
   * Both post-deletion exits tear the session down. They used to call
   * `unregisterPushThenSignOut` directly, which took no in-flight guard — so a
   * sign-out started here could run concurrently with one started from
   * Settings over the same SecureStore keys and push-revocation journal — and
   * showed no progress at all: the Alert dismissed and the card sat there,
   * fully interactive, through two networked revokes.
   */
  function tearDownSession(): void {
    void runSignOut({
      performSignOut: () => unregisterPushThenSignOut(signOut),
      onBusyChange: setSigningOut,
      navigateToSignIn: () => router.replace("/(auth)/sign-in"),
    });
  }

  async function submit() {
    if (!session || busy || signingOut || !complete) return;
    setBusy(true);
    try {
      const response = await deleteOwnAccount(
        buildAccountDeletionInput({
          confirmation,
          authProvider: session.authProvider,
          password,
          hasTotp: session.hasTotp,
          mfaCode,
        }),
      );
      Alert.alert(
        "Account deletion queued",
        `Reference: ${response.request.request_id}. This removes only your personal account; shared workspace data remains.`,
        [{ text: "OK", onPress: tearDownSession }],
      );
    } catch (error) {
      if (accountDeletionErrorCode(error) === "fresh_authentication_required") {
        Alert.alert(
          "Sign in again required",
          "Sign out, sign in again with your identity provider, then return here within five minutes.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Sign out",
              style: "destructive",
              onPress: tearDownSession,
            },
          ],
        );
      } else {
        Alert.alert(
          "Couldn’t delete account",
          error instanceof Error
            ? redactAuthError(error.message)
            : "Check your connection and try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    color: t.fg,
    backgroundColor: t.bg,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    // Size only: an explicit lineHeight mis-centres a TextInput caret.
    fontSize: fontSizeFor("body"),
    fontFamily: FONT.regular,
  } as const;

  return (
    <>
      <SectionHeader
        anchor="account-deletion"
        title="Delete my account"
        subtitle="Permanently remove your personal Moosewave login and profile."
      />
      <Card>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          This deletes your credentials, linked identities, MFA secret,
          sessions, push registrations, and personal preferences. It does not
          delete shared campaigns, subscribers, content, billing, or other
          workspace members. Last owners must transfer ownership first. A legal
          hold can delay completion; limited legal, security, audit, and backup
          records follow their retention schedules.
        </Text>

        {!expanded ? (
          <Pressable
            onPress={() => setExpanded(true)}
            accessibilityRole="button"
            accessibilityLabel="Delete my account"
            style={{
              marginTop: 12,
              paddingVertical: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: t.danger,
              backgroundColor: `${t.danger}1a`,
              alignItems: "center",
            }}
          >
            <Text
              {...typeCap("body")}
              style={{
                color: t.danger,
                ...typeStyle("body"),
                fontFamily: FONT.bold,
              }}
            >
              Delete my account
            </Text>
          </Pressable>
        ) : (
          <View style={{ marginTop: 14, gap: 10 }}>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fg,
                ...typeStyle("label"),
                fontFamily: FONT.semibold,
              }}
            >
              Type {ACCOUNT_DELETION_CONFIRMATION} exactly
            </Text>
            <TextInput
              // Inputs scale with the OS text size but their height does not — cap it.
              {...typeCap("body")}
              value={confirmation}
              onChangeText={setConfirmation}
              placeholder={ACCOUNT_DELETION_CONFIRMATION}
              placeholderTextColor={t.fgSubtle}
              autoCapitalize="characters"
              autoCorrect={false}
              accessibilityLabel="Account deletion confirmation"
              // The chain advances; it never SUBMITS. An irreversible delete
              // is not something a stray return key gets to trigger — the
              // last field dismisses and the button stays the only trigger.
              {...keyboardChain({
                next:
                  session.authProvider === "password" ? passwordRef : mfaRef,
              })}
              style={inputStyle}
            />
            {session.authProvider === "password" ? (
              // Reveal toggle, not a bare secureTextEntry: this is the last
              // field standing between a typo and an irreversible delete, and
              // a mistyped password here reads as "wrong password" rather than
              // "you fat-fingered it". Visibility collapses on blur.
              <PasswordField
                ref={passwordRef}
                value={password}
                onChangeText={setPassword}
                {...(session.hasTotp
                  ? keyboardChain({ next: mfaRef })
                  : keyboardDismiss())}
                placeholder="Current password"
                placeholderTextColor={t.fgSubtle}
                textContentType="password"
                accessibilityLabel="Current password"
                inputStyle={inputStyle}
              />
            ) : (
              <Text
                {...typeCap("caption")}
                style={{ color: t.fgSubtle, ...typeStyle("caption") }}
              >
                Your {session.authProvider} sign-in must be less than five
                minutes old. You’ll be prompted to sign in again if needed.
              </Text>
            )}
            {session.hasTotp ? (
              <>
                <TextInput
                  // Inputs scale with the OS text size but their height does not — cap it.
                  {...typeCap("body")}
                  ref={mfaRef}
                  value={mfaCode}
                  onChangeText={(value) => setMfaCode(value.replace(/\D/g, ""))}
                  placeholder="6-digit authenticator code"
                  placeholderTextColor={t.fgSubtle}
                  keyboardType="number-pad"
                  maxLength={6}
                  textContentType="oneTimeCode"
                  accessibilityLabel="Authenticator code"
                  {...keyboardDismiss()}
                  {...mfaDone.inputProps}
                  style={inputStyle}
                />
                {mfaDone.accessory}
              </>
            ) : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                onPress={() => {
                  setExpanded(false);
                  setConfirmation("");
                  setPassword("");
                  setMfaCode("");
                }}
                disabled={busy || signingOut}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy || signingOut }}
                style={{ flex: 1, paddingVertical: 10, alignItems: "center" }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("body"),
                    fontFamily: FONT.semibold,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void submit()}
                disabled={!complete || busy || signingOut}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: !complete || busy || signingOut,
                  busy: busy || signingOut,
                }}
                style={{
                  flex: 2,
                  paddingVertical: 10,
                  borderRadius: 10,
                  backgroundColor: t.danger,
                  alignItems: "center",
                  opacity: !complete || busy || signingOut ? 0.5 : 1,
                }}
              >
                <Text
                  {...typeCap("body")}
                  style={{
                    // `danger` changes lightness with the theme. The page
                    // background is its contrast-safe inverse in both modes.
                    color: t.bg,
                    ...typeStyle("body"),
                    fontFamily: FONT.bold,
                  }}
                >
                  {signingOut
                    ? "Signing out…"
                    : busy
                      ? "Queueing…"
                      : "Permanently delete my account"}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </Card>
    </>
  );
}
