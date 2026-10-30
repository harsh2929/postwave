/**
 * RejectReasonModal — the mandatory "why" behind a rejection.
 *
 * A rejection without an explanation is a governance failure: the requester
 * is told no and given nothing to fix. An in-app sheet rather than
 * Alert.prompt because Alert.prompt is iOS-only, and this rule has to hold
 * on both platforms.
 */
import { useEffect, useRef } from "react";
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

import { focusOn } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";
import { rejectReasonModalState } from "./approvalPresentation";

export interface RejectReasonModalProps {
  visible: boolean;
  label: string;
  reason: string;
  busy?: boolean | undefined;
  /** Inline validation message, shown in place of a blocking Alert. */
  error?: string | null | undefined;
  /**
   * Copy overrides for the other server-side "reason is mandatory" flow this
   * sheet now serves: rejecting an AI investigation
   * (POST /api/v1/audit/investigations/{id}/reject answers 400
   * `reason_required` on an empty body, exactly as the approvals route does).
   * Defaulted so every existing call site is unchanged — and overridable
   * because telling an investigator to "tell the requester what to fix" would
   * be addressing somebody who does not exist.
   */
  subtitle?: string | undefined;
  submitAccessibilityLabel?: string | undefined;
  /**
   * Where to send SCREEN-READER focus once this sheet closes.
   *
   * React Native restores nothing: focus lands wherever the platform puts it,
   * so a VoiceOver user who opened this from a Reject button is returned to
   * the top of the screen rather than to the button they pressed. Pass that
   * button's ref. Optional — omitting it keeps the previous behaviour.
   */
  restoreFocusTo?: { current: unknown } | null | undefined;
  onChangeReason: (reason: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/** See ConfirmSheet: the dismissal has to commit before focus can move. */
const FOCUS_RESTORE_DELAY_MS = 350;

export function RejectReasonModal({
  visible,
  label,
  reason,
  busy,
  error,
  subtitle,
  submitAccessibilityLabel,
  restoreFocusTo,
  onChangeReason,
  onCancel,
  onSubmit,
}: RejectReasonModalProps) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const submitState = rejectReasonModalState(reason, busy);
  const inputRef = useRef<TextInput | null>(null);

  // Focus the reason field on open: the sheet exists only to collect it, so
  // making the user tap once more before typing is pure friction.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [visible]);

  // …and hand focus BACK on close. Tracked with a ref rather than keyed off
  // `visible` alone so the very first render (visible: false) does not fire a
  // restore for a sheet that was never opened.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible) {
      wasVisible.current = true;
      return;
    }
    if (!wasVisible.current) return;
    wasVisible.current = false;
    if (!restoreFocusTo) return;
    const timer = setTimeout(
      () => focusOn(restoreFocusTo),
      FOCUS_RESTORE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [visible, restoreFocusTo]);

  return (
    <Modal
      visible={visible}
      animationType={reduceMotion ? "none" : "slide"}
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        // The SHEET is named for what is being rejected; the submit button is
        // named for the action. They used to share one string, so VoiceOver
        // announced the container and its primary control identically and
        // "Reject approval" could mean either "you are in this sheet" or "this
        // button submits".
        accessibilityLabel={`Reject ${label}`}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ flexGrow: 1, padding: 20, gap: 14 }}
          >
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontWeight: "700",
                fontFamily: FONT.display,
              }}
            >
              Reject &quot;{label}&quot;?
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {subtitle ??
                "Tell the requester what to fix. This is final, recorded in the audit log, and shown on the approval."}
            </Text>
            <TextInput
              ref={inputRef}
              value={reason}
              onChangeText={onChangeReason}
              placeholder="Reason for rejection"
              accessibilityLabel="Reason for rejection"
              placeholderTextColor={t.fgSubtle}
              multiline
              textAlignVertical="top"
              style={{
                minHeight: 132,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: error ? t.danger : t.border,
                backgroundColor: t.surface,
                color: t.fg,
                padding: 12,
                // No explicit `lineHeight` on a TextInput — it mis-centres the
                // caret and clips descenders on Android (see SearchField).
                fontSize: fontSizeFor("callout"),
                fontFamily: FONT.regular,
              }}
              {...typeCap("callout")}
            />
            {error ? (
              <Text
                accessibilityRole="alert"
                {...typeCap("label")}
                style={{
                  color: t.danger,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {error}
              </Text>
            ) : null}
            <View
              style={{
                flexDirection: "row",
                justifyContent: "flex-end",
                gap: 10,
              }}
            >
              <Pressable
                onPress={onCancel}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel rejection"
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.border,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: t.fg,
                    ...typeStyle("control"),
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={onSubmit}
                disabled={submitState.submitDisabled}
                accessibilityRole="button"
                accessibilityLabel={
                  submitAccessibilityLabel ?? "Reject approval"
                }
                accessibilityState={{ disabled: submitState.submitDisabled }}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  borderRadius: 10,
                  backgroundColor: t.danger,
                  opacity: submitState.submitDisabled ? 0.55 : 1,
                }}
              >
                <Text
                  {...typeCap("control")}
                  style={{
                    color: t.bg,
                    ...typeStyle("control"),
                    fontWeight: "700",
                    fontFamily: FONT.bold,
                  }}
                >
                  {submitState.submitLabel}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
