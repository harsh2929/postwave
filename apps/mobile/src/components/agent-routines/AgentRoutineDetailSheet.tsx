/**
 * AgentRoutineDetailSheet — what this routine is told to do, what it has
 * actually done, and the one button that makes it do it now.
 *
 * A SHEET RATHER THAN A ROUTE, for the same two reasons ReviewDetailSheet is:
 * the rhythm here is open → check → maybe run → close, and a pushed screen
 * charges a navigation animation each way; and it keeps this surface to ONE
 * route file, so it costs the tab layout one registration instead of two.
 *
 * IT IS WHERE THE OUTCOME LIVES. The routine list carries `last_run_at` and
 * nothing about whether that run worked (`routineColumns`, repo.go:40), so
 * "did it fail?" is answerable only here, from `GET /{id}/runs`. The run list
 * gets the full five-state ladder rather than a spinner-or-nothing, because a
 * failed FETCH of the history must never render as "this has never run".
 *
 * RUN NOW IS GATED ON ROLE, NOT ON A 403. `POST /{id}/run` is
 * `session_minimum_role: editor` in the generated policy manifest — it spends
 * LLM quota and writes drafts — so a viewer is told plainly rather than
 * discovering the boundary after typing through a confirm sheet.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { RoutineActions } from "@/components/agent-routines/RoutineActions";
import { Pill } from "@/components/Pill";
import { QueryStates, type QueryLike } from "@/components/QueryStates";
import { SkeletonList } from "@/components/Skeleton";
import { AgentRoutineRunRow } from "@/components/agent-routines/AgentRoutineRunRow";
import { FONT } from "@/lib/fonts";
import { dateTime, EMDASH, num, relativeTime } from "@/lib/format";
import {
  nextRunPrefix,
  routineScheduleState,
} from "@/lib/agentRoutineSchedule";
import {
  routineKindLabel,
  scheduleLabel,
  RUN_LIST_CAP,
  type AgentRoutine,
  type AgentRoutineRun,
} from "@/lib/agentRoutines";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AgentRoutineDetailSheetProps {
  routine: AgentRoutine | null;
  runs: readonly AgentRoutineRun[];
  runsQuery: QueryLike;
  /** The online/auth gate, so the history can say "offline" not "empty". */
  gate: { enabled: boolean };
  now: number;
  onClose: () => void;
  onRunNow: (routine: AgentRoutine) => void;
  running: boolean;
  /** Pause / resume. Same editor floor as run-now (PATCH is write:campaigns). */
  onToggleEnabled: (routine: AgentRoutine) => void;
  togglingEnabled: boolean;
  /** False for viewers: POST /{id}/run is editor-minimum server-side. */
  canRun: boolean;
  online: boolean;
  onOpenApproval: (approvalId: string) => void;
}

export function AgentRoutineDetailSheet(props: AgentRoutineDetailSheetProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const routine = props.routine;
  const schedule = routine
    ? routineScheduleState(routine, props.now)
    : null;

  return (
    <ReducedMotionModal
      visible={routine !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 8,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={maxLinesAtScale(2, fontScale)}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.display,
              flexShrink: 1,
            }}
          >
            {routine?.name || "Routine"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
            style={{
              minHeight: 44,
              minWidth: 44,
              alignItems: "flex-end",
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
              Close
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 32,
            gap: 12,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {routine && schedule ? (
            <RoutineSummary
              routine={routine}
              nextLabel={
                schedule.at === null
                  ? nextRunPrefix(schedule.reason)
                  : `${nextRunPrefix(schedule.reason)} ${relativeTime(schedule.at, {
                      now: props.now,
                    })}`
              }
              nextSpoken={
                schedule.at === null
                  ? nextRunPrefix(schedule.reason)
                  : `${nextRunPrefix(schedule.reason)} ${dateTime(schedule.at)}`
              }
              now={props.now}
            />
          ) : null}

          <RoutineActions
            routine={routine}
            canRun={props.canRun}
            online={props.online}
            running={props.running}
            togglingEnabled={props.togglingEnabled}
            onRunNow={props.onRunNow}
            onToggleEnabled={props.onToggleEnabled}
          />

          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              marginTop: 4,
            }}
          >
            Run history
          </Text>

          <QueryStates
            query={props.runsQuery}
            gate={props.gate}
            isEmpty={props.runs.length === 0}
            offlineMessage="You're offline, so this routine's run history can't be loaded. Reconnect and pull to refresh."
            skeleton={<SkeletonList rows={3} />}
            empty={{
              title: "No runs recorded",
              description:
                "Nothing has run yet — not on the schedule and not by hand. The outcome of the first run will show up here.",
            }}
          >
            <View style={{ gap: 10 }}>
              {props.runs.map((run) => (
                <AgentRoutineRunRow
                  key={run.id}
                  run={run}
                  now={props.now}
                  onOpenApproval={props.onOpenApproval}
                />
              ))}
              {props.runs.length >= RUN_LIST_CAP ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Showing the {num(RUN_LIST_CAP)} most recent runs — the server
                  caps this history and offers no further pages.
                </Text>
              ) : null}
            </View>
          </QueryStates>
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/** The standing brief and the facts derived from it. */
function RoutineSummary({
  routine,
  nextLabel,
  nextSpoken,
  now,
}: {
  routine: AgentRoutine;
  nextLabel: string;
  nextSpoken: string;
  now: number;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Pill label={routineKindLabel(routine.kind)} tone="accent" />
        <Pill label={scheduleLabel(routine.schedule)} tone="neutral" />
        <Pill
          label={routine.enabled ? "Enabled" : "Paused"}
          tone={routine.enabled ? "success" : "neutral"}
          accessibilityLabel={
            routine.enabled
              ? "Enabled: the platform runs this on its schedule."
              : "Paused: the platform never runs this automatically."
          }
        />
        <Pill
          label={routine.requireApproval ? "Approval gated" : "No approval gate"}
          tone={routine.requireApproval ? "info" : "warning"}
          accessibilityLabel={
            routine.requireApproval
              ? "A human approves every draft this routine makes."
              : "This routine has no approval gate, so its drafts are created directly."
          }
        />
      </View>

      <SummaryLine label="Next run" value={nextLabel} spoken={nextSpoken} />
      <SummaryLine
        label="Last run"
        value={
          routine.lastRunAt ? relativeTime(routine.lastRunAt, { now }) : EMDASH
        }
        spoken={
          routine.lastRunAt
            ? dateTime(routine.lastRunAt)
            : "It has never run."
        }
      />
      {routine.createdBy ? (
        <SummaryLine
          label="Created by"
          value={routine.createdBy}
          spoken={routine.createdBy}
        />
      ) : null}

      {routine.prompt ? (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            gap: 4,
          }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
            }}
          >
            The brief the agent is given
          </Text>
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              fontFamily: FONT.regular,
            }}
          >
            {routine.prompt}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function SummaryLine({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${spoken}`}
      style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.medium,
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
