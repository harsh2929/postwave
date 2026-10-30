/**
 * ReportContentSheetViews — the two bodies `ReportContentSheet` can show.
 *
 * Split out of the sheet so the sheet itself stays a state machine (target →
 * ground → explanation → submit) and these stay presentational. Neither view
 * owns state or talks to the network: `ReportContentSheet` is still the only
 * module that calls `submitContentReport`, which is what the content-reporting
 * consistency guard checks.
 */
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  MAX_REPORT_EXPLANATION,
  REPORT_GROUNDS,
  type ReportGround,
} from "@/api/contentReports";
import { useAnnounceOnChange } from "@/lib/a11y";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

export type ReportSubmitState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; reference: string | null }
  | { status: "error"; message: string };

export function ReportSentView({
  reference,
  onDone,
}: {
  /** Null when the server's 2xx carried none — the report still landed, and
   * "Reference ." would read as though it had not. */
  reference: string | null;
  onDone: () => void;
}) {
  const { t } = useTheme();
  // The polite live region below is Android's; iOS hears only this. Truthy,
  // not `!== null`: no shape of a missing reference is read out as one.
  useAnnounceOnChange(
    reference ? `Report sent. Reference ${reference}.` : "Report sent.",
  );
  return (
    <View
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
      style={{ gap: 8 }}
    >
      <Text
        {...typeCap("heading")}
        style={{ color: t.fg, fontFamily: FONT.medium, fontSize: 15 }}
      >
        Report sent
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          fontSize: 13,
        }}
      >
        {reference !== null ? `Reference ${reference}. ` : null}A person
        reviews every report. We&apos;ll act on anything that breaks the rules.
      </Text>
      <Pressable
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel="Done"
        style={{
          marginTop: 8,
          backgroundColor: t.accent,
          borderRadius: 12,
          paddingVertical: 12,
          alignItems: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.accentFg,
            fontFamily: FONT.semibold,
            fontSize: 15,
          }}
        >
          Done
        </Text>
      </Pressable>
    </View>
  );
}

function ReportGroundPicker({
  ground,
  onChange,
}: {
  ground: ReportGround;
  onChange: (ground: ReportGround) => void;
}) {
  const { t } = useTheme();
  // React Native's iOS trait table maps `radio` to UIAccessibilityTraitNone,
  // so VoiceOver never said a chip could be tapped; `button` is the closest
  // true trait (SegmentedControl's `optionRole`). Android's `radio` is real.
  // Read at render time so a test can observe each platform.
  const chipRole = Platform.OS === "ios" ? "button" : "radio";
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabelledBy="report-ground-label"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
    >
      {REPORT_GROUNDS.map((g) => {
        const selected = g.value === ground;
        return (
          <Pressable
            key={g.value}
            onPress={() => {
              haptics.tap();
              onChange(g.value);
            }}
            accessibilityRole={chipRole}
            // `checked` is the only state RN turns into "checked"/"unchecked"
            // (iOS) or a checkable radio (Android). `selected` beside it would
            // make both platforms say "checked … selected" for one chip.
            accessibilityState={{ checked: selected }}
            accessibilityLabel={g.label}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: selected ? t.accent : t.border,
              backgroundColor: selected ? t.accentSubtle : "transparent",
              minHeight: 44,
              justifyContent: "center",
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: selected ? t.accent : t.fgMuted,
                fontFamily: selected ? FONT.medium : FONT.regular,
                fontSize: 13,
              }}
            >
              {g.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export interface ReportFormProps {
  ground: ReportGround;
  onGroundChange: (ground: ReportGround) => void;
  explanation: string;
  onExplanationChange: (explanation: string) => void;
  state: ReportSubmitState;
  /** `canSubmitContentReport(explanation)`, decided by the sheet. */
  ready: boolean;
  /** Characters still needed before `ready` flips; zero or negative once the
   * floor is met, which is also what an over-long explanation reports. */
  remaining: number;
  onSend: () => void;
  onCancel: () => void;
}

export function ReportForm({
  ground,
  onGroundChange,
  explanation,
  onExplanationChange,
  state,
  ready,
  remaining,
  onSend,
  onCancel,
}: ReportFormProps) {
  const { t } = useTheme();
  const sending = state.status === "sending";
  // The failure line is an Android live region; iOS hears only this.
  useAnnounceOnChange(state.status === "error" ? state.message : null);
  return (
    <>
      <Text
        {...typeCap("callout")}
        nativeID="report-ground-label"
        style={{ color: t.fg, fontFamily: FONT.medium, fontSize: 14 }}
      >
        What&apos;s wrong with it?
      </Text>
      <ReportGroundPicker ground={ground} onChange={onGroundChange} />

      <Text
        {...typeCap("callout")}
        nativeID="report-explanation-label"
        style={{ color: t.fg, fontFamily: FONT.medium, fontSize: 14 }}
      >
        Tell us more
      </Text>
      <TextInput
        {...typeCap("body")}
        value={explanation}
        onChangeText={onExplanationChange}
        // RN counts UTF-16 units, never fewer than the server's rune count, so
        // the field cannot hold more than the server accepts.
        maxLength={MAX_REPORT_EXPLANATION}
        multiline
        numberOfLines={5}
        accessibilityLabel="Tell us what is wrong with this content"
        accessibilityLabelledBy="report-explanation-label"
        placeholder="What makes this a problem?"
        placeholderTextColor={t.fgMuted}
        style={{
          color: t.fg,
          fontFamily: FONT.regular,
          fontSize: 15,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: 12,
          padding: 12,
          minHeight: 110,
          textAlignVertical: "top",
        }}
      />
      <Text
        {...typeCap("label")}
        accessibilityLiveRegion="polite"
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          fontSize: 12,
        }}
      >
        {ready
          ? "Ready to send."
          : remaining > 0
            ? `${remaining} more character${remaining === 1 ? "" : "s"} so we can act on it.`
            : "Keep it to 10,000 characters or fewer."}
      </Text>

      {state.status === "error" ? (
        <Text
          {...typeCap("bodySmall")}
          accessibilityLiveRegion="assertive"
          style={{
            color: t.danger,
            fontFamily: FONT.regular,
            fontSize: 13,
          }}
        >
          {state.message}
        </Text>
      ) : null}

      <Pressable
        onPress={onSend}
        disabled={!ready || sending}
        accessibilityRole="button"
        accessibilityLabel="Send report"
        accessibilityState={{ disabled: !ready || sending }}
        style={{
          marginTop: 4,
          backgroundColor: ready ? t.accent : t.bgSubtle,
          borderRadius: 12,
          paddingVertical: 12,
          alignItems: "center",
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        {sending ? (
          <ActivityIndicator color={t.accentFg} />
        ) : (
          <Text
            {...typeCap("control")}
            style={{
              color: ready ? t.accentFg : t.fgMuted,
              fontFamily: FONT.semibold,
              fontSize: 15,
            }}
          >
            Send report
          </Text>
        )}
      </Pressable>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{
          paddingVertical: 10,
          alignItems: "center",
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            fontSize: 14,
          }}
        >
          Cancel
        </Text>
      </Pressable>
    </>
  );
}
