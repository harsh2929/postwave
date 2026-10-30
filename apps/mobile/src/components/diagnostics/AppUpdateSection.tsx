/**
 * AppUpdateSection — the permanent home of the update control (SHELL#29).
 *
 * The toast in `useAppUpdatePrompt` states an update once and disappears;
 * this is where a user who missed it, or a support agent walking someone
 * through "are you on the current build", can always look. It answers three
 * questions the app previously could not answer at all: which channel this
 * binary polls, which bundle it is running, and whether that bundle got there
 * by falling back from one that crashed.
 *
 * NativeWind v4 gotcha: STATIC Pressable styles only.
 */
import { useCallback, useMemo, useState } from "react";
import { I18nManager, Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill, type PillTone } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { useAppUpdate } from "@/hooks/useAppUpdate";
import { useGuardedRestart, useRestartSafety } from "@/hooks/useRestartSafety";
import {
  appUpdateOriginRows,
  describeAppUpdate,
  type AppUpdateTone,
} from "@/lib/appUpdatePolicy";
import { appUpdateOrigin } from "@/lib/appUpdates";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { restartSafetyLines } from "@/lib/restartSafetyScan";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export const RESTART_SAFE_LINE =
  "Registered work is restart-safe: no unsaved edit, queued change or open share reported a risk.";

const TONE_TO_PILL: Record<AppUpdateTone, PillTone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
};

export function AppUpdateSection() {
  const { t } = useTheme();
  const { state, check } = useAppUpdate();
  const [restarting, setRestarting] = useState(false);
  // Desktop's pre-restart safety scan: what a relaunch would interrupt, read
  // live while an update is staged, and the one guarded restart path every
  // surface shares (hooks/useRestartSafety).
  const ready = state.phase === "ready";
  const scan = useRestartSafety(ready);
  const guardedRestart = useGuardedRestart();
  const safetyLines = ready ? restartSafetyLines(scan) : [];
  const blocked = ready && scan.blocking.length > 0;

  // Native constants; they cannot change without the process restarting, so
  // reading them once per mount is both correct and free.
  const origin = useMemo(() => appUpdateOrigin(), []);
  const rows = useMemo(() => appUpdateOriginRows(origin), [origin]);
  const description = describeAppUpdate(state);

  const onPress = useCallback(() => {
    haptics.tap();
    if (description.action === "restart") {
      setRestarting(true);
      void guardedRestart().finally(() => setRestarting(false));
      return;
    }
    check();
  }, [check, description.action, guardedRestart]);

  const busy =
    restarting || state.phase === "checking" || state.phase === "downloading";

  return (
    <Card>
      <SectionLabel topMargin={0}>App updates</SectionLabel>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {description.headline}
        </Text>
        {state.phase === "ready" ? (
          <Pill
            label="Ready"
            tone={TONE_TO_PILL[description.tone]}
            size="sm"
            accessibilityLabel="An update is downloaded and waiting for a restart"
          />
        ) : null}
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {description.detail}
      </Text>
      {ready ? (
        <View style={{ marginTop: 8, gap: 4 }} accessibilityRole="list">
          {safetyLines.length === 0 ? (
            <Text
              {...typeCap("label")}
              style={{ color: t.fgMuted, ...typeStyle("label"), fontFamily: FONT.regular }}
            >
              {RESTART_SAFE_LINE}
            </Text>
          ) : (
            safetyLines.map((line) => (
              <Text
                key={line}
                {...typeCap("label")}
                style={{
                  color: line.startsWith("Blocking") ? t.danger : t.warning,
                  ...typeStyle("label"),
                  fontFamily: FONT.semibold,
                }}
              >
                {line}
              </Text>
            ))
          )}
        </View>
      ) : null}

      <View style={{ marginTop: 8 }}>
        {rows.map((row) => (
          <View
            key={row.label}
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "flex-start",
              paddingVertical: 6,
              gap: 12,
            }}
            accessible
            accessibilityLabel={`${row.label}: ${row.value}`}
          >
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {row.label}
            </Text>
            <Text
              selectable
              {...typeCap("mono")}
              style={{
                color: t.fg,
                ...typeStyle("mono"),
                flexShrink: 1,
                // Trailing-edge alignment; `textAlign` has no logical `end`.
                textAlign: I18nManager.isRTL ? "left" : "right",
                fontFamily: FONT.regular,
              }}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>

      {description.action && description.actionLabel ? (
        <Pressable
          onPress={onPress}
          disabled={busy || blocked}
          accessibilityRole="button"
          accessibilityLabel={
            description.action === "restart"
              ? blocked
                ? "Restart is blocked until the work above finishes"
                : "Restart Moosewave to finish installing the update"
              : "Check for a Moosewave update"
          }
          accessibilityState={{ disabled: busy || blocked, busy }}
          style={{
            marginTop: 12,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: description.action === "restart" ? t.accent : t.border,
            opacity: busy || blocked ? 0.6 : 1,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: description.action === "restart" ? t.accent : t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {restarting
              ? "Restarting…"
              : blocked
                ? "Restart blocked"
                : safetyLines.length > 0 && description.action === "restart"
                  ? "Restart anyway"
                  : description.actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}
