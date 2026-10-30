/**
 * RoutineActions — the two verbs on a standing agent routine, plus the notice
 * that explains their absence.
 *
 * Carved out of `AgentRoutineDetailSheet`, which crossed its 450-line ceiling
 * the moment pause/resume shipped. The split is not arbitrary: everything here
 * is gated on the same editor floor for the same server reason
 * (`write:campaigns` on both `POST /{id}/run` and `PATCH /{id}`), so the role
 * notice and the two controls are one decision, and the sheet around them is
 * presentation of a routine's history.
 *
 * ── ORDER AND WEIGHT ───────────────────────────────────────────────────────
 * Run-now is the primary reason anyone opens this sheet, so it is the button.
 * Pause/resume is rarer and more consequential — it changes what happens
 * without anybody present — so it sits below as text rather than competing for
 * the same visual weight.
 *
 * ── NEITHER IS OFFERED OFFLINE ─────────────────────────────────────────────
 * A queued run would spend AI credit at a moment nobody chose; a queued pause
 * would tell the operator a schedule had stopped while it kept firing. Both are
 * worse than an honest "not now".
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import type { AgentRoutine } from "@/lib/agentRoutines";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RoutineActionsProps {
  routine: AgentRoutine | null;
  /** False for viewers: both routes are editor-minimum server-side. */
  canRun: boolean;
  online: boolean;
  running: boolean;
  togglingEnabled: boolean;
  onRunNow: (routine: AgentRoutine) => void;
  onToggleEnabled: (routine: AgentRoutine) => void;
}

export function RoutineActions(props: RoutineActionsProps) {
  const { t } = useTheme();
  const { routine } = props;

  if (!props.canRun) {
    return (
      <MobileScopeNotice
        title="Read-only for your role"
        body="Running or pausing a routine needs an editor role on this workspace, because a run spends AI credit and writes a draft."
      />
    );
  }
  if (!routine) return null;

  const toggleDisabled = props.togglingEnabled || !props.online;

  return (
    <>
      <RunNowButton
        disabled={props.running || !props.online}
        busy={props.running}
        hint={
          props.online
            ? undefined
            : "You're offline. A run is never queued for later — it would spend credit at a moment nobody chose."
        }
        onPress={() => props.onRunNow(routine)}
      />
      <Pressable
        onPress={() => props.onToggleEnabled(routine)}
        disabled={toggleDisabled}
        accessibilityRole="button"
        accessibilityLabel={
          routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`
        }
        accessibilityState={{ disabled: toggleDisabled }}
        style={{ minHeight: 44, justifyContent: "center", marginTop: 4 }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: toggleDisabled
              ? t.fgSubtle
              : routine.enabled
                ? t.danger
                : t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {routine.enabled ? "Pause this routine" : "Resume this routine"}
        </Text>
      </Pressable>
    </>
  );
}

function RunNowButton({
  disabled,
  busy,
  hint,
  onPress,
}: {
  disabled: boolean;
  busy: boolean;
  hint?: string | undefined;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={busy ? "Starting the routine" : "Run now"}
        accessibilityHint="Asks the agent to draft from this routine's brief straight away"
        accessibilityState={{ disabled, busy }}
        style={{
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: disabled ? t.surface : t.accent,
          borderWidth: 1,
          borderColor: disabled ? t.borderSubtle : t.accent,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: disabled ? t.fgSubtle : t.accentFg,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {busy ? "Starting…" : "Run now"}
        </Text>
      </Pressable>
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
