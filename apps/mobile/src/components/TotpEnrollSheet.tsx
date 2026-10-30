/**
 * TotpEnrollSheet — full-screen modal for two-factor enrollment.
 *
 * Replaces the prior `Alert.alert(otpauth_uri + recovery_codes)` pattern
 * (which dumped the URI as plain text). Renders a real QR code via
 * react-native-qrcode-svg so the user can scan straight from their
 * authenticator (1Password / Authy / Google Authenticator), then
 * confirms by entering the 6-digit code.
 *
 * Wire-up (in settings.tsx):
 *   const [enrollOpen, setEnrollOpen] = useState(false);
 *   const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
 *   ...
 *   onPress={async () => {
 *     const res = await api.totpEnroll();
 *     if (res.data) { setEnrollData(res.data); setEnrollOpen(true); }
 *   }}
 *   ...
 *   <TotpEnrollSheet
 *     visible={enrollOpen}
 *     enrollData={enrollData}
 *     onClose={() => setEnrollOpen(false)}
 *     onVerified={() => setEnrollOpen(false)}
 *   />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as ScreenCapture from "expo-screen-capture";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import type { ReturnFocusRef } from "@/components/KeyboardFormSheet";
import { focusOn } from "@/lib/a11y";
import { RecoveryCodesBlock } from "@/components/auth/RecoveryCodesBlock";
import { TotpSetupKeyBlock } from "@/components/auth/TotpSetupKeyBlock";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { RecoveryCodesAckRow } from "@/components/auth/RecoveryCodesAckRow";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { keyboardChain } from "@/lib/keyboardChain";

/** Matches the app-lock key convention in components/BiometricGate.tsx. */
const SCREEN_CAPTURE_KEY = "postwave-recovery-codes";

export interface TotpEnrollData {
  otpauth_uri: string;
  recovery_codes: string[];
}

interface TotpEnrollSheetProps {
  visible: boolean;
  enrollData: TotpEnrollData | null;
  /** Called with the verification code; should call /auth/totp/verify
   *  and resolve true on success, false on bad code. */
  onVerify: (
    code: string,
  ) => Promise<boolean | { ok: boolean; message?: string }>;
  onClose: () => void;
  onVerified: () => void | Promise<void>;
  closeLabel?: string;
  /**
   * The control that opened this sheet. On dismiss, screen-reader focus is
   * put back on it. Without this iOS hands focus to wherever UIKit chooses —
   * usually the top of Settings — so a VoiceOver user who cancels enrollment
   * has to navigate the whole security section again to try a second time.
   * Same contract and same reason as KeyboardFormSheet's `returnFocusRef`;
   * this sheet cannot use that chrome because it is a full-height flow with
   * its own screen-capture guard, not a form sheet.
   */
  returnFocusRef?: ReturnFocusRef | undefined;
}

/**
 * Return screen-reader focus to the control that opened the sheet.
 *
 * Its own hook rather than two inline effects: the ANDROID half has to run
 * from an effect (there is no dismissal callback on that platform) while the
 * iOS half has to run from `Modal.onDismiss`, and keeping the pair together
 * is the only way the platform split stays legible. Returns the iOS callback;
 * the Android path is already wired by the time you have it.
 *
 * Both halves are best-effort by construction — `focusOn` swallows a missing
 * node — because focus management must never be able to break enrollment.
 */
function useReturnFocusOnDismiss(
  visible: boolean,
  returnFocusRef: ReturnFocusRef | undefined,
): () => void {
  const restoreFocus = useCallback(() => {
    if (returnFocusRef) focusOn(returnFocusRef);
  }, [returnFocusRef]);
  const wasVisible = useRef(false);
  useEffect(() => {
    const closing = wasVisible.current && !visible;
    wasVisible.current = visible;
    // iOS restores from `onDismiss`; running here too would fire the request
    // into a sheet that is still sliding away, where it is dropped.
    if (!closing || !returnFocusRef || Platform.OS === "ios") return;
    const frame = requestAnimationFrame(restoreFocus);
    return () => cancelAnimationFrame(frame);
  }, [visible, returnFocusRef, restoreFocus]);
  return restoreFocus;
}

export function TotpEnrollSheet({
  visible,
  enrollData,
  onVerify,
  onClose,
  onVerified,
  closeLabel = "Cancel",
  returnFocusRef,
}: TotpEnrollSheetProps) {
  const { t } = useTheme();
  const restoreFocus = useReturnFocusOnDismiss(visible, returnFocusRef);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [acknowledgedCodes, setAcknowledgedCodes] = useState(false);
  const [savedCodes, setSavedCodes] = useState(false);
  const confirmDisabled = !acknowledgedCodes || code.length !== 6 || verifying;

  // Eight single-use account-recovery secrets should not land in the camera
  // roll or an app-switcher snapshot. Mirrors the app lock's protection, armed
  // only while the codes are actually on screen.
  useEffect(() => {
    if (!visible || !enrollData) return;
    void ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_KEY);
    if (Platform.OS === "ios") {
      void ScreenCapture.enableAppSwitcherProtectionAsync(1);
    }
    return () => {
      void ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY);
      if (Platform.OS === "ios") {
        void ScreenCapture.disableAppSwitcherProtectionAsync();
      }
    };
  }, [visible, enrollData]);

  /**
   * The sheet is a swipe-dismissible pageSheet and the server issues these
   * codes exactly once, so an accidental downward swipe used to destroy the
   * only copy silently. Alert (not the in-app ConfirmSheet) deliberately: an
   * OS alert is guaranteed to render above a presented modal.
   */
  function requestClose(): void {
    if (!enrollData || savedCodes) {
      onClose();
      return;
    }
    haptics.warning();
    Alert.alert(
      "Save your recovery codes first",
      "These codes are shown once and cannot be retrieved again. Close without saving them?",
      [
        { text: "Keep setting up", style: "cancel" },
        { text: "Close anyway", style: "destructive", onPress: onClose },
      ],
    );
  }

  async function submit() {
    if (code.length !== 6) {
      Alert.alert(
        "Invalid code",
        "Enter the 6-digit code from your authenticator.",
      );
      return;
    }
    setVerifying(true);
    try {
      const result = await onVerify(code);
      const ok = typeof result === "boolean" ? result : result.ok;
      if (ok) {
        haptics.success();
        if (typeof result === "object" && result.message) {
          Alert.alert("Verified — device save pending", result.message);
        }
        setCode("");
        setAcknowledgedCodes(false);
        setSavedCodes(false);
        await onVerified();
      } else {
        haptics.error();
        Alert.alert(
          "Couldn't verify",
          typeof result === "object" && result.message
            ? result.message
            : "That code didn't work. Try again.",
        );
      }
    } catch (error) {
      Alert.alert(
        "Couldn't finish setup",
        error instanceof Error
          ? error.message
          : "Two-factor setup could not be completed. Try again.",
      );
    } finally {
      setVerifying(false);
    }
  }

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={requestClose}
      // WHEN, not whether, is what decides if this works: `setAccessibilityFocus`
      // is silently dropped while the sheet is still on screen, and a page sheet
      // slides out over roughly a third of a second. `onDismiss` fires once the
      // dismissal has committed — the first moment the target is focusable. It
      // is iOS-only, so Android falls back to the frame-delayed effect above,
      // which is enough there because TalkBack re-resolves focus after the
      // window closes rather than dropping the request.
      onDismiss={restoreFocus}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Two-factor authentication setup"
      >
        {/* KeyboardAvoidingView: on a pageSheet modal iOS does not auto-shift
            content, so the keyboard covers the 6-digit input + Confirm button
            at the bottom of this long form. Wrap + keyboardShouldPersistTaps so
            the Confirm tap registers while the keyboard is up (matches StepEditor). */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={{ padding: 20, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
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
                Set up 2-step verification
              </Text>
              <Pressable
                onPress={requestClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <Text
                  {...typeCap("heading")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("heading"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {closeLabel}
                </Text>
              </Pressable>
            </View>

            {!enrollData ? (
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("callout"),
                  fontFamily: FONT.regular,
                }}
              >
                Loading…
              </Text>
            ) : (
              <>
                <TotpSetupKeyBlock otpauthUri={enrollData.otpauth_uri} />

                <RecoveryCodesBlock
                  codes={enrollData.recovery_codes}
                  onSaved={() => setSavedCodes(true)}
                />
                <RecoveryCodesAckRow
                  acknowledged={acknowledgedCodes}
                  savedCodes={savedCodes}
                  onToggle={() => setAcknowledgedCodes((v) => !v)}
                />

                {/* Verify */}
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("caption"),
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                    letterSpacing: 0.6,
                    textTransform: "uppercase",
                    marginBottom: 6,
                  }}
                >
                  Enter 6-digit code
                </Text>
                <TextInput
                  value={code}
                  onChangeText={(v) =>
                    setCode(v.replace(/\D/g, "").slice(0, 6))
                  }
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  placeholder="123456"
                  placeholderTextColor={t.fgSubtle}
                  accessibilityLabel="6-digit verification code"
                  accessibilityHint="Enter the code from your authenticator app to finish enrollment."
                  {...keyboardChain({
                    onSubmit: () => void submit(),
                    disabled: confirmDisabled,
                  })}
                  // Same contract as the CLI device-code field: a fixed-width
                  // code entry takes the `display` role's size and its tight
                  // ceiling instead of a hand-picked multiplier.
                  {...typeCap("display")}
                  style={{
                    backgroundColor: t.surface,
                    borderColor: t.border,
                    borderWidth: 1,
                    color: t.fg,
                    borderRadius: 10,
                    paddingHorizontal: 14,
                    paddingVertical: 14,
                    fontSize: fontSizeFor("display"),
                    letterSpacing: 6,
                    textAlign: "center",
                    fontVariant: ["tabular-nums"],
                    marginBottom: 16,
                  }}
                  editable={acknowledgedCodes && !verifying}
                />

                <Pressable
                  onPress={submit}
                  disabled={confirmDisabled}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm and enable two-factor authentication"
                  accessibilityState={{
                    disabled: confirmDisabled,
                    busy: verifying,
                  }}
                  style={{
                    backgroundColor: confirmDisabled
                      ? t.surfaceElevated
                      : t.accent,
                    opacity: confirmDisabled ? 0.5 : 1,
                    borderRadius: 10,
                    paddingVertical: 14,
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 44,
                  }}
                >
                  <Text
                    {...typeCap("body")}
                    style={{
                      color: confirmDisabled ? t.fgMuted : t.accentFg,
                      ...typeStyle("body"),
                      fontWeight: "600",
                      fontFamily: FONT.semibold,
                    }}
                  >
                    {verifying ? "Verifying…" : "Confirm and enable"}
                  </Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
