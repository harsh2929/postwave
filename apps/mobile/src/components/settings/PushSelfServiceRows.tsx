/**
 * PushSelfServiceRows — the do-not-disturb window, and proof the chain works.
 *
 * Both controls call endpoints that exist SOLELY for this app and had no caller on
 * any surface: POST /api/v1/mobile/push/devices/quiet-hours (SHELL#12, migration
 * 1814) and .../test (SHELL#13). Both findings are recorded `confirmed` in the
 * 2026-07-25 ledger because the SERVER half shipped — with Go tests — while the
 * client half never did.
 *
 * ── DESIGN NOTES ───────────────────────────────────────────────────────────
 * The window is stored server-side because APNs/FCM deliver from the API, so a local
 * switch would control nothing. The timezone is taken from THIS handset rather than
 * offered as a picker: the user's answer to "don't wake me at night" means their own
 * night, and a zone list is a desk affordance that would also let them pick a zone
 * they are not in.
 *
 * Times step in 30 minutes. A minute-accurate do-not-disturb boundary is a precision
 * nobody wants at 2am, and steppers avoid a keyboard and a parse error class
 * entirely. The stored value stays minute-precise, so a window set elsewhere is
 * displayed faithfully rather than being rounded on read.
 *
 * The test result renders the server's `note` verbatim. Expo accepting a ticket is
 * not proof of handset delivery — the receipt worker reconciles that later — and the
 * handler says so, so this must not upgrade "accepted" into "delivered".
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useToast } from "@/components/Toast";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  useSavePushQuietHours,
  useSendPushSelfTest,
  pushSelfServiceError,
  usePushSelfServiceAvailable,
} from "@/hooks/usePushSelfService";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  MINUTES_PER_DAY,
  PUSH_QUIET_HOURS_DEFAULT,
  pushQuietHoursSavable,
  pushQuietHoursSummary,
  type PushQuietHours,
} from "@/lib/pushQuietHours";
import { minuteLabel } from "@/lib/smsPolicies";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const STEP_MINUTES = 30;

/** This handset's IANA zone, or the server's fallback when the OS won't say. */
function deviceTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.trim() !== ""
      ? zone
      : PUSH_QUIET_HOURS_DEFAULT.timezone;
  } catch {
    return PUSH_QUIET_HOURS_DEFAULT.timezone;
  }
}

function step(minute: number, delta: number): number {
  // Wraps rather than clamps: a window may legitimately cross midnight, so 23:30
  // stepping forward should reach 00:00 and not stick at the end of the day.
  return (minute + delta + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function TimeStepper({
  label,
  minute,
  onChange,
  disabled,
}: {
  label: string;
  minute: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  const { t } = useTheme();
  const nudge = (delta: number) => () => {
    haptics.tap();
    onChange(step(minute, delta));
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginTop: 10,
      }}
    >
      <Text
        {...typeCap("body")}
        style={{ color: t.fg, ...typeStyle("body"), flex: 1 }}
      >
        {label}
      </Text>
      <Pressable
        onPress={nudge(-STEP_MINUTES)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Move ${label} 30 minutes earlier`}
        hitSlop={10}
        style={{ minWidth: 44, minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: disabled ? t.fgSubtle : t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
            textAlign: "center",
          }}
        >
          −30
        </Text>
      </Pressable>
      <Text
        {...typeCap("body")}
        accessibilityLabel={`${label} ${minuteLabel(minute)}`}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          fontFamily: FONT.semibold,
          minWidth: 56,
          textAlign: "center",
        }}
      >
        {minuteLabel(minute)}
      </Text>
      <Pressable
        onPress={nudge(STEP_MINUTES)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Move ${label} 30 minutes later`}
        hitSlop={10}
        style={{ minWidth: 44, minHeight: 44, justifyContent: "center" }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: disabled ? t.fgSubtle : t.accent,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
            textAlign: "center",
          }}
        >
          +30
        </Text>
      </Pressable>
    </View>
  );
}

export function PushSelfServiceRows({
  locallyEnabled,
  storedWindow,
}: {
  locallyEnabled: boolean;
  /** The server's current window, when a status read has produced one. */
  storedWindow?: PushQuietHours | null;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const available = usePushSelfServiceAvailable({ locallyEnabled });
  const save = useSavePushQuietHours();
  const test = useSendPushSelfTest();

  const [window, setWindow] = useState<PushQuietHours>(() => ({
    ...PUSH_QUIET_HOURS_DEFAULT,
    timezone: deviceTimezone(),
  }));

  // Adopt the server's window whenever a fresh one arrives, so the editor never
  // shows a stale local guess as though it were stored state.
  useEffect(() => {
    if (storedWindow) setWindow(storedWindow);
  }, [storedWindow]);

  if (!available) return null;

  const busy = save.isPending || test.isPending;
  const canSave = pushQuietHoursSavable(window) && !busy;

  const commit = (next: PushQuietHours) => {
    setWindow(next);
  };

  const onSave = () => {
    haptics.tap();
    save.mutate(window, {
      onSuccess: (stored) => {
        setWindow(stored);
        toast({ kind: "success", message: "Quiet hours saved." });
      },
      onError: (err) =>
        toast({
          kind: "error",
          message: pushSelfServiceError(err, "Couldn't save quiet hours."),
        }),
    });
  };

  const onTest = () => {
    haptics.tap();
    test.mutate(undefined, {
      onSuccess: (outcome) =>
        toast({
          kind: outcome.accepted ? "success" : "warning",
          message: outcome.accepted
            ? `Test sent — ${outcome.note}.`
            : "The push service did not accept the test.",
        }),
      onError: (err) =>
        toast({
          kind: "error",
          message: pushSelfServiceError(
            err,
            "Couldn't send a test notification.",
          ),
        }),
    });
  };

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        marginTop: 12,
        paddingTop: 6,
      }}
    >
      <SettingsSwitchRow
        label="Quiet hours"
        hint="Held notifications are delivered after the window ends. The window is enforced by the server, so it applies even when the app isn't running."
        value={window.enabled}
        onValueChange={(next) => commit({ ...window, enabled: next })}
      />
      {window.enabled ? (
        <>
          <TimeStepper
            label="From"
            minute={window.startMinute}
            disabled={busy}
            onChange={(startMinute) => commit({ ...window, startMinute })}
          />
          <TimeStepper
            label="Until"
            minute={window.endMinute}
            disabled={busy}
            onChange={(endMinute) => commit({ ...window, endMinute })}
          />
        </>
      ) : null}
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 10,
          fontFamily: FONT.regular,
        }}
      >
        {pushQuietHoursSummary(window)}
      </Text>
      <View style={{ flexDirection: "row", gap: 18, marginTop: 12 }}>
        <Pressable
          onPress={onSave}
          disabled={!canSave}
          accessibilityRole="button"
          accessibilityLabel="Save quiet hours for this device"
          accessibilityState={{ disabled: !canSave }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: canSave ? t.accent : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {save.isPending ? "Saving…" : "Save quiet hours"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onTest}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Send a test notification to this device"
          accessibilityState={{ disabled: busy }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: busy ? t.fgSubtle : t.accent,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {test.isPending ? "Sending…" : "Send a test"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
