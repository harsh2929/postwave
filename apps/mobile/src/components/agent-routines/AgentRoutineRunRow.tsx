/**
 * AgentRoutineRunRow — one entry in a routine's run history.
 *
 * This is the trust record. `FinishRun` writes the model's own `reasoning`
 * beside the terminal status, and the package header calls those fields "the
 * honest record… so a reviewer can see what the agent was told, the model's own
 * rationale, and exactly what it drafted — before approving". They are empty on
 * runs that predate the feature and on runs that failed before drafting, and
 * they are NEVER fabricated — so every block below is conditional on the field
 * actually being present rather than on a placeholder.
 *
 * A RUN THAT OPENED AN APPROVAL LINKS STRAIGHT TO IT. `runColumns` selects
 * `approval_id`, so the hand-off costs no request: this is the seam between
 * "the agent proposed something" and "a human decides", and making the reader
 * go and find it in the Approvals queue is where that thread gets dropped.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, duration, EMDASH, relativeTime } from "@/lib/format";
import {
  runDurationMs,
  runStatusPresentation,
  type AgentRoutineRun,
} from "@/lib/agentRoutines";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AgentRoutineRunRowProps {
  run: AgentRoutineRun;
  now: number;
  /** Non-null only when the run carries an approval id. */
  onOpenApproval?: ((approvalId: string) => void) | undefined;
}

export function AgentRoutineRunRow({
  run,
  now,
  onOpenApproval,
}: AgentRoutineRunRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const status = runStatusPresentation(run, now);
  const elapsed = runDurationMs(run, now);
  // A run with no parsable start has no duration to state; an em-dash says so.
  // "0ms" would be a measurement, and there is none.
  const took = elapsed === null ? EMDASH : duration(elapsed);
  const started = run.startedAt ? relativeTime(run.startedAt, { now }) : EMDASH;
  const startedSpoken = run.startedAt
    ? `Started ${dateTime(run.startedAt)}`
    : "Its start time was not recorded";

  return (
    <View
      accessible
      accessibilityLabel={`${status.spoken} ${startedSpoken}. ${
        elapsed === null
          ? "Duration unknown."
          : `${run.finishedAt ? "Took" : "Running for"} ${took}.`
      }${run.error ? ` Error: ${run.error}` : ""}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 6,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Pill
          label={status.label}
          tone={status.tone}
          accessibilityLabel={status.spoken}
        />
        <Text
          numberOfLines={1}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {started} · {took}
        </Text>
      </View>

      {run.outputKind ? (
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          Drafted a {run.outputKind}
        </Text>
      ) : null}

      {run.reasoning ? (
        <Text
          numberOfLines={maxLinesAtScale(4, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {run.reasoning}
        </Text>
      ) : null}

      {run.error ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {run.error}
        </Text>
      ) : null}

      {run.approvalId && onOpenApproval ? (
        <Pressable
          onPress={() => onOpenApproval(run.approvalId)}
          accessibilityRole="link"
          accessibilityLabel="Open the approval this run opened"
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.accent,
              ...typeStyle("callout"),
              fontFamily: FONT.semibold,
            }}
          >
            Review the approval it opened
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
