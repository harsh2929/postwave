/**
 * SequenceContextCard — the read-only header block above the canvas.
 *
 * A journey preview that starts at "step 1" is an incomplete read: the
 * operator can see every step and still not know WHO enters, what counts as
 * success, or whether stuck detection is on. Desktop shows all three
 * (SequenceTriggerCard + SequenceSettingsCard); mobile dropped the trigger at
 * the type boundary and never modelled the rest.
 *
 * Read-only by construction — editing stays behind
 * MOBILE_SEQUENCE_AUTHORING_AVAILABLE.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import type { SequenceGoalWire, SequenceTriggerWire } from "@/api/sequences";
import {
  goalSummary,
  stuckThresholdSummary,
  triggerSummary,
} from "@/lib/sequenceTrigger";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SequenceContextCard({
  trigger,
  goal,
  stuckAfterDays,
}: {
  trigger: SequenceTriggerWire | null | undefined;
  goal: SequenceGoalWire | null | undefined;
  stuckAfterDays: number | undefined;
}) {
  const { t } = useTheme();
  const entry = triggerSummary(trigger);
  const success = goalSummary(goal);
  const stuck = stuckThresholdSummary(stuckAfterDays);

  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 4,
        padding: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.surface,
        gap: 10,
      }}
    >
      <View
        accessible
        accessibilityLabel={`Entry trigger. ${entry.label}. ${entry.detail ?? ""}`}
        style={{ gap: 4 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              letterSpacing: 0.4,
              textTransform: "uppercase",
              fontWeight: "600",
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            Entry trigger
          </Text>
          {/* `known: false` means the RESPONSE omitted the field. That is a
              gap in what we were told, not a claim about the workspace, so it
              gets a neutral "not reported" pill rather than a warning. */}
          {!entry.known ? (
            <Pill label="Not reported" tone="neutral" />
          ) : entry.incomplete ? (
            <Pill label="Incomplete" tone="warning" />
          ) : null}
        </View>
        <Text
          {...typeCap("callout")}
          style={{
            color: entry.known ? t.fg : t.fgMuted,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {entry.label}
        </Text>
        {entry.detail ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {entry.detail}
          </Text>
        ) : null}
      </View>

      {success ? (
        <View
          accessible
          accessibilityLabel={`${success.label}. ${success.detail}`}
          style={{ gap: 2 }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {success.label}
          </Text>
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
            }}
          >
            {success.detail}
          </Text>
        </View>
      ) : null}

      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {stuck}
      </Text>
    </View>
  );
}
