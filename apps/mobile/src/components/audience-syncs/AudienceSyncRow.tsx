/**
 * AudienceSyncRow — one reverse-ETL connection, triaged before any tap.
 *
 * The row answers the 9pm question in one glance: is this destination getting
 * the audience, and if not, is it because the last run BROKE or because the
 * platform never ran it. Both facts are on the list wire —
 * `syncSelectColumns` carries `last_run_status` beside `last_run_at` — so
 * unlike the agent-routines row, this one does NOT have to send the reader
 * into a detail sheet to learn whether anything is wrong.
 *
 * TIME IS SHOWN TWICE, DIFFERENTLY. Sighted users get the compacted relative
 * form ("2h ago"); the accessibility label carries the absolute date and time,
 * because "2h ago" is exactly the part a compaction throws away and a screen
 * reader cannot recover. Same rule as every compacted figure in this app.
 *
 * THE HEALTH PILL IS NEVER COLOUR-ALONE. It carries a word ("Failing",
 * "Overdue", "Paused") and a full spoken sentence, and the row's border colour
 * is a second channel rather than the only one.
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
  healthPresentation,
  nextRunPrefix,
  syncHealthState,
  syncScheduleState,
} from "@/lib/audienceSyncHealth";
import {
  destinationTypeLabel,
  scheduleLabel,
  sourceLabel,
  type AudienceSync,
} from "@/lib/audienceSyncs";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AudienceSyncRowProps {
  sync: AudienceSync;
  onPress: (sync: AudienceSync) => void;
  /** `Date.now()` from the screen's ticker, so "2h ago" stays honest. */
  now: number;
  /** Dims the row while a run it started is in flight. */
  busy?: boolean | undefined;
}

function AudienceSyncRowImpl({ sync, onPress, now, busy }: AudienceSyncRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const health = healthPresentation(syncHealthState(sync, now));
  const schedule = syncScheduleState(sync, now);
  const prefix = nextRunPrefix(schedule.reason);

  // An absent instant is an em-dash, never "now" and never a date invented from
  // a null. `at === null` is the normal case for paused, manual and never-run
  // syncs, where there IS no next instant to name.
  const nextRelative =
    schedule.at === null ? "" : relativeTime(schedule.at, { now });
  const nextLine = nextRelative ? `${prefix} ${nextRelative}` : prefix;
  const nextSpoken =
    schedule.at === null ? prefix : `${prefix} ${dateTime(schedule.at)}`;

  const lastLine = sync.lastRunAt
    ? `Last run ${relativeTime(sync.lastRunAt, { now })}`
    : "Never run";
  const lastSpoken = sync.lastRunAt
    ? `Last completed run ${dateTime(sync.lastRunAt)}.`
    : "It has never completed a run.";

  const alarming = health.tone === "danger" || health.tone === "warning";

  return (
    <Pressable
      onPress={() => onPress(sync)}
      disabled={busy === true}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      accessibilityLabel={`${sync.name || "Untitled sync"}. ${health.spoken} ${sourceLabel(
        sync,
      )} to ${destinationTypeLabel(sync.destination.type)}. ${scheduleLabel(
        sync.schedule,
      )}. ${nextSpoken}. ${lastSpoken}`}
      accessibilityHint="Opens this sync's run history, where you can also run it now"
      style={{
        backgroundColor: t.surface,
        borderColor: alarming
          ? health.tone === "danger"
            ? t.danger
            : t.warning
          : t.borderSubtle,
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
          {sync.name || "Untitled sync"}
        </Text>
        <Pill
          label={health.label}
          tone={health.tone}
          accessibilityLabel={health.spoken}
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
        {sourceLabel(sync)} {EMDASH}{" "}
        {destinationTypeLabel(sync.destination.type)} ·{" "}
        {scheduleLabel(sync.schedule)}
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
    </Pressable>
  );
}

export const AudienceSyncRow = memo(AudienceSyncRowImpl);
