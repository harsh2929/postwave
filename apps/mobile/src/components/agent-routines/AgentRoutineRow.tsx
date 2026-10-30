/**
 * AgentRoutineRow — one standing agent instruction in the list.
 *
 * The row answers, before any tap: what does this routine produce, when does
 * the platform run it, when did it last run, is a human still in the loop, and
 * is the platform LATE. It deliberately does not claim whether the last run
 * worked: `Repo.ListRoutines` selects `last_run_at` and nothing about the
 * outcome, so the only honest place for a status is the detail — see the
 * header of lib/agentRoutines.
 *
 * TIME IS SHOWN TWICE, DIFFERENTLY. Sighted users get the compacted relative
 * form ("in 4h"); the accessibility label carries the absolute date and time,
 * because "in 4h" is exactly the part a compaction throws away and a screen
 * reader cannot recover. Same rule as every compacted figure in this app.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, relativeTime } from "@/lib/format";
import {
  nextRunPrefix,
  routineScheduleState,
} from "@/lib/agentRoutineSchedule";
import {
  routineKindLabel,
  scheduleLabel,
  type AgentRoutine,
} from "@/lib/agentRoutines";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AgentRoutineRowProps {
  routine: AgentRoutine;
  onPress: (routine: AgentRoutine) => void;
  /** `Date.now()` from the screen's ticker, so "in 4h" stays honest. */
  now: number;
  /** Dims the row while a run it started is in flight. */
  busy?: boolean | undefined;
}

function AgentRoutineRowImpl({
  routine,
  onPress,
  now,
  busy,
}: AgentRoutineRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const schedule = routineScheduleState(routine, now);
  const prefix = nextRunPrefix(schedule.reason);

  // An absent instant is an em-dash, never "now" and never a date invented
  // from a null. `at === null` is the normal case for paused, manual and
  // never-run routines, where there IS no next instant to name.
  const nextRelative =
    schedule.at === null ? "" : relativeTime(schedule.at, { now });
  const nextLine = nextRelative ? `${prefix} ${nextRelative}` : prefix;
  const nextSpoken =
    schedule.at === null ? prefix : `${prefix} ${dateTime(schedule.at)}`;

  const lastLine = routine.lastRunAt
    ? `Last run ${relativeTime(routine.lastRunAt, { now })}`
    : "Never run";
  const lastSpoken = routine.lastRunAt
    ? `Last run ${dateTime(routine.lastRunAt)}`
    : "It has never run.";

  const gate = routine.requireApproval
    ? "A human approves every draft it makes."
    : "It has no approval gate, so its drafts are created directly.";

  return (
    <Pressable
      onPress={() => onPress(routine)}
      disabled={busy === true}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      accessibilityLabel={`${routine.name || "Untitled routine"}. ${routineKindLabel(
        routine.kind,
      )}. ${scheduleLabel(routine.schedule)}. ${nextSpoken}. ${lastSpoken} ${gate}`}
      accessibilityHint="Opens the routine's run history, where you can also run it now"
      style={{
        backgroundColor: t.surface,
        borderColor: schedule.overdue ? t.warning : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // 44pt is the touch-target floor; the content already exceeds it, and
        // stating it keeps a future compaction from dropping below.
        minHeight: 44,
        opacity: busy === true ? 0.55 : 1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {routine.name || "Untitled routine"}
        </Text>
        <RoutineStatePill
          overdue={schedule.overdue}
          reason={schedule.reason}
        />
      </View>

      <Text
        numberOfLines={maxLinesAtScale(1, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {routineKindLabel(routine.kind)} · {scheduleLabel(routine.schedule)}
      </Text>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: schedule.overdue ? t.warning : t.fgSubtle,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {nextLine} {EMDASH} {lastLine}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Pill
          label={routine.requireApproval ? "Approval gated" : "No approval gate"}
          tone={routine.requireApproval ? "info" : "warning"}
          accessibilityLabel={gate}
        />
      </View>
    </Pressable>
  );
}

/**
 * The state badge. Absent for the ordinary "on schedule" case: a pill on every
 * row teaches the eye to stop reading pills, and the one that matters here is
 * the routine the platform has MISSED.
 */
function RoutineStatePill({
  overdue,
  reason,
}: {
  overdue: boolean;
  reason: ReturnType<typeof routineScheduleState>["reason"];
}) {
  if (overdue) {
    return (
      <Pill
        label="Overdue"
        tone="warning"
        accessibilityLabel="Overdue: the platform has not run this when it was supposed to."
      />
    );
  }
  if (reason === "paused") {
    return (
      <Pill
        label="Paused"
        tone="neutral"
        accessibilityLabel="Paused: this routine never runs automatically."
      />
    );
  }
  if (reason === "unknown") {
    return (
      <Pill
        label="Unknown schedule"
        tone="neutral"
        accessibilityLabel="This routine's schedule is not one this app recognises, so its next run cannot be worked out here."
      />
    );
  }
  return null;
}

export const AgentRoutineRow = memo(AgentRoutineRowImpl);
