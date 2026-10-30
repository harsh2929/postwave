/**
 * ReportContentSheet — the in-app "report this" control.
 *
 * WHY IT EXISTS. Apple Guideline 1.2 requires an app that displays content from
 * third parties to offer a way to report it; Google Play requires the same
 * through its UGC policy, and again — separately — through its generative-AI
 * policy for anything a model produced. This app renders inbound replies,
 * helpdesk threads, archive comments and model output, and until now none of it
 * could be reported. Both requirements gate distribution, so this is not a
 * feature so much as the condition for shipping the ones already built.
 *
 * ONE SHEET FOR BOTH. UGC and AI output are different policies with different
 * audits, but they are the same interaction for the person using the app: they
 * are looking at something wrong and want to say so. Two components would have
 * meant two chances to leave one out of a screen, so there is one, and
 * `originForSubject` decides which bucket the report lands in.
 *
 * WHAT IT DOES NOT DO. It does not moderate, hide or block anything locally. A
 * report that only greyed out a row on one device would satisfy nobody: the
 * point is that a human at Moosewave sees it, in the same queue as a public DSA
 * Art. 16 notice.
 */
import { useCallback, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  MIN_REPORT_EXPLANATION,
  canSubmitContentReport,
  originForSubject,
  reportExplanationLength,
  reportFailureMessage,
  submitContentReport,
  trimReportExplanation,
  type ReportGround,
  type ReportSubjectKind,
} from "@/api/contentReports";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import {
  ReportForm,
  ReportSentView,
  type ReportSubmitState,
} from "@/components/ReportContentSheetViews";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export interface ReportTarget {
  /** What is being reported, in the server's vocabulary. */
  kind: ReportSubjectKind;
  /** The row id, so an operator can find it. */
  ref?: string | undefined;
  /** A public URL when one exists. */
  url?: string | undefined;
  /** Shown to the user so they can confirm they are reporting the right thing. */
  label: string;
}

export interface ReportContentSheetProps {
  target: ReportTarget | null;
  onClose: () => void;
}

/** The default ground depends on what is being reported: someone opening this
 * on a model draft is almost always reporting the model, and pre-selecting the
 * likely answer is the difference between a report and an abandoned form. */
function defaultGround(kind: ReportSubjectKind): ReportGround {
  return kind === "ai_output" ? "ai_output_harmful" : "harassment_or_hate";
}

export function ReportContentSheet({
  target,
  onClose,
}: ReportContentSheetProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [ground, setGround] = useState<ReportGround>("other");
  const [explanation, setExplanation] = useState("");
  const [state, setState] = useState<ReportSubmitState>({ status: "idle" });
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Reset when the sheet opens for a different target, without a useEffect:
  // deriving it during render keeps the sheet from briefly showing the previous
  // report's success message under a new target's heading.
  const targetKey = target
    ? `${target.kind}:${target.ref ?? target.label}`
    : null;
  if (targetKey !== openedFor) {
    setOpenedFor(targetKey);
    setGround(target ? defaultGround(target.kind) : "other");
    setExplanation("");
    setState({ status: "idle" });
  }

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  const send = useCallback(async () => {
    if (!target || state.status === "sending") return;
    if (!canSubmitContentReport(explanation)) return;
    haptics.tap();
    setState({ status: "sending" });
    try {
      const receipt = await submitContentReport({
        origin: originForSubject(target.kind),
        subject_kind: target.kind,
        ...(target.ref ? { subject_ref: target.ref } : {}),
        ...(target.url ? { subject_url: target.url } : {}),
        reason_category: ground,
        explanation: trimReportExplanation(explanation),
      });
      haptics.success();
      setState({ status: "sent", reference: receipt.reference });
    } catch (error) {
      haptics.error();
      // Nothing typed is discarded. Someone who has just described a threat
      // should not have to describe it again because a request timed out.
      // The sentence depends on WHY: "try again" on a refusal no retry can
      // clear left the reporter retrying forever.
      setState({ status: "error", message: reportFailureMessage(error) });
    }
  }, [target, state.status, explanation, ground]);

  if (!target) return null;

  const remaining = MIN_REPORT_EXPLANATION - reportExplanationLength(explanation);
  const ready = canSubmitContentReport(explanation);

  return (
    <ReducedMotionModal
      visible
      transparent
      animationType="fade"
      onRequestClose={close}
      accessibilityViewIsModal
    >
      {/* The keyboard would otherwise cover the explanation, its counter and
          Send. Wrapping the whole bottom-anchored stack lifts the card itself;
          the KeyboardFormSheet pattern. */}
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: "flex-end" }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: t.overlay,
          }}
        />
        <View
          style={{
            backgroundColor: t.surfaceElevated,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderColor: t.border,
            borderWidth: 1,
            paddingBottom: insets.bottom + 16,
            maxHeight: "88%",
          }}
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, gap: 14 }}
          >
            <Text
              {...typeCap("title")}
              accessibilityRole="header"
              style={{ color: t.fg, fontFamily: FONT.semibold, fontSize: 18 }}
            >
              Report this content
            </Text>
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                fontSize: 13,
              }}
            >
              {target.label}
            </Text>

            {state.status === "sent" ? (
              <ReportSentView reference={state.reference} onDone={close} />
            ) : (
              <ReportForm
                ground={ground}
                onGroundChange={setGround}
                explanation={explanation}
                onExplanationChange={setExplanation}
                state={state}
                ready={ready}
                remaining={remaining}
                onSend={() => void send()}
                onCancel={close}
              />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </ReducedMotionModal>
  );
}
