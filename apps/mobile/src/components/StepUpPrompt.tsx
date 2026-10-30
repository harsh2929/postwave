/**
 * StepUpPrompt — the sheet a step-up challenge raises INSTEAD OF a sign-out.
 *
 * Mounted once in the root layout. It subscribes to `onStepUpPrompt`, claims
 * the prompt (an unclaimed challenge is abandoned by the transport rather than
 * left hanging), takes a live authenticator code, and reports back so the SDK
 * transport can retry the original request with its original method, body and
 * Idempotency-Key.
 *
 * It shows the SERVER's sentence. `Requirement.Reason` is written for the
 * person and lives next to the policy it explains ("Confirm it's you before
 * exporting subscriber data."); re-deriving copy from the action id here would
 * be the second, drifting half of a rule that exists once on purpose.
 *
 * THE VERB IS totpVerify, NOT totpChallenge. `/totp/challenge` short-circuits
 * with 200 `{already:true}` whenever the session is already MFA-satisfied —
 * which is exactly the state a step-up challenge describes (satisfied, but
 * `mfa_satisfied_at` is stale). It would report success without moving the
 * clock and the retry would be challenged again. `/totp/verify` calls
 * MarkSessionMFASatisfied unconditionally. The visible consequence is that a
 * recovery code cannot refresh a step-up proof, so this sheet does not offer
 * one and says so.
 *
 * NATIVEWIND TRAP, AVOIDED ON PURPOSE: every `Pressable` here uses a STATIC
 * style object. A function-style `style={({pressed}) => …}` silently drops
 * layout under NativeWind v4 and has broken this app before.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createAuthClient } from "@/api/auth";
import { pathLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  formatStepUpAction,
  onStepUpPrompt,
  type StepUpChallenge,
  type StepUpPromptDetail,
} from "@/lib/stepUp";
import { useAuthStore } from "@/store/auth";
import { keyboardChain } from "@/lib/keyboardChain";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const OTP_LEN = 6;

/** The house monospace for codes and identifiers (see DnsRecordCard, MigrationJobCard). */
const MONO = "Menlo";

interface OpenPrompt {
  challenge: StepUpChallenge;
  settle: (proved: boolean) => void;
}

export function StepUpPrompt() {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const [prompt, setPrompt] = useState<OpenPrompt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onStepUpPrompt((detail: StepUpPromptDetail) => {
      if (!detail.claim()) return;
      setCode("");
      setError(null);
      setBusy(false);
      setPrompt({ challenge: detail.challenge, settle: detail.settle });
    });
  }, []);

  // A prompt left unsettled is a request that never resolves. Unmounting
  // mid-prompt must answer "no" rather than silently drop the question.
  const promptRef = useRef<OpenPrompt | null>(null);
  promptRef.current = prompt;
  useEffect(() => {
    return () => promptRef.current?.settle(false);
  }, []);

  const dismiss = useCallback(() => {
    setPrompt((current) => {
      current?.settle(false);
      return null;
    });
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    if (!prompt || busy) return;
    if (code.length !== OTP_LEN) {
      setError(`Enter all ${OTP_LEN} digits`);
      return;
    }
    const baseUrl = useAuthStore.getState().baseUrl;
    if (!baseUrl) {
      // No configured API means nothing to re-prove against. Answer "no" so the
      // transport throws the server's own 401 instead of holding the sheet open.
      dismiss();
      return;
    }
    setError(null);
    setBusy(true);
    const res = await createAuthClient(baseUrl).totpVerify(code);
    setBusy(false);
    if (res.error) {
      haptics.error();
      // Clear the field: the code that just failed has usually rotated away by
      // the time the user looks back at their authenticator.
      setCode("");
      setError(
        res.error.code === "not_enrolled"
          ? `This action needs two-factor authentication, which isn't set up on your account. Add an authenticator in ${pathLabel(["Settings", "Security"])}, then try again.`
          : "That code didn't work. Try again.",
      );
      return;
    }
    haptics.success();
    setCode("");
    setPrompt(null);
    prompt.settle(true);
  }, [busy, code, dismiss, prompt]);

  if (!prompt) return null;
  const actionLabel = formatStepUpAction(prompt.challenge.action);
  const confirmDisabled = busy || code.length !== OTP_LEN;

  return (
    <Modal
      visible
      animationType={reduceMotion ? "none" : "slide"}
      presentationStyle="pageSheet"
      onRequestClose={dismiss}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Confirm it's you"
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            automaticallyAdjustKeyboardInsets
            contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 16 }}
          >
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontWeight: "700",
                fontFamily: FONT.display,
                letterSpacing: -0.4,
              }}
            >
              Confirm it&apos;s you
            </Text>

            <Text
              {...typeCap("callout")}
              style={{
                color: t.fgMuted,
                ...typeStyle("callout"),
                fontFamily: FONT.regular,
              }}
            >
              {prompt.challenge.reason}
            </Text>

            {actionLabel ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("caption"),
                  fontFamily: MONO,
                }}
              >
                {actionLabel}
              </Text>
            ) : null}

            <TextInput
              value={code}
              onChangeText={(next) => {
                setCode(next.replace(/\D/g, "").slice(0, OTP_LEN));
                if (error) setError(null);
              }}
              {...typeCap("heading")}
              // The last (and only) field in this form, so the return key
              // submits the proof rather than doing nothing.
              {...keyboardChain({
                onSubmit: () => void submit(),
                disabled: busy,
              })}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoFocus
              editable={!busy}
              maxLength={OTP_LEN}
              accessibilityLabel="Authentication code"
              placeholder="000000"
              placeholderTextColor={t.fgMuted}
              style={{
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.surface,
                borderRadius: 10,
                paddingVertical: 14,
                paddingHorizontal: 16,
                color: t.fg,
                fontFamily: MONO,
                letterSpacing: 6,
                textAlign: "center",
                ...typeStyle("heading"),
              }}
            />

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Enter the 6-digit code from your authenticator app. Recovery codes
              can&apos;t be used to confirm a sensitive action.
            </Text>

            {error ? (
              <Text
                accessibilityLiveRegion="polite"
                {...typeCap("caption")}
                style={{
                  color: t.danger,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                }}
              >
                {error}
              </Text>
            ) : null}

            <View style={{ flexDirection: "row", gap: 12, marginTop: 4 }}>
              {/* STATIC style — see the NativeWind note in this file's header. */}
              <Pressable
                onPress={dismiss}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                accessibilityState={{ disabled: busy }}
                hitSlop={8}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: t.border,
                  borderRadius: 10,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.fg,
                    ...typeStyle("callout"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void submit()}
                disabled={confirmDisabled}
                accessibilityRole="button"
                accessibilityLabel="Confirm"
                accessibilityState={{ disabled: confirmDisabled }}
                hitSlop={8}
                style={{
                  flex: 1,
                  backgroundColor: t.accent,
                  borderRadius: 10,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: confirmDisabled ? 0.5 : 1,
                }}
              >
                <Text
                  {...typeCap("callout")}
                  style={{
                    color: t.accentFg,
                    ...typeStyle("callout"),
                    fontFamily: FONT.regular,
                    fontWeight: "600",
                  }}
                >
                  {busy ? "Confirming…" : "Confirm"}
                </Text>
              </Pressable>
            </View>

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              You&apos;re still signed in. This only confirms you&apos;re still
              here before a sensitive action.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
