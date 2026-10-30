/**
 * SubscriberImportRow — one import job in the list.
 *
 * The row has to answer, before any tap: what file is this, where has it got to,
 * and is it going to touch people who already exist. Everything else — the
 * per-outcome counters, the preflight verdict, the two verbs — is behind the tap.
 *
 * ABSENCE IS NOT ZERO, AND IT MATTERS MORE HERE THAN ANYWHERE.
 * `importProgressCounts` returns null when either counter is missing, and this
 * row renders that as an em-dash. Substituting 0 would render "0 of 0 rows"
 * beside "Running", which reads as a stalled import — a false alarm about a job
 * that is fine. Likewise the bar is only DETERMINATE when
 * `importProgressFraction` is a number; a `preview` row, which the worker has
 * processed nothing of by definition, gets no bar at all rather than a 0%-wide
 * one claiming measured progress.
 *
 * STATE IS NEVER COLOUR-ALONE. The pill carries the word ("Running",
 * "Stopping", "Failed") and the row's accessibility label carries the whole
 * sentence, including the exact spoken counts, because the "12.4k / 50k" line
 * is compacted and the compaction is exactly what a screen-reader user cannot
 * recover.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { EMDASH, compactNum, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  importProgressCounts,
  importProgressFraction,
  importStatusPresentation,
  isTerminalImport,
  onExistingDescription,
  type SubscriberImportJob,
} from "@/lib/subscriberImportJobs";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface SubscriberImportRowProps {
  job: SubscriberImportJob;
  onPress: (job: SubscriberImportJob) => void;
  /** Dims the row while one of its verbs is in flight. */
  busy?: boolean | undefined;
  /** `Date.now()` from the screen's ticker so "started 4m ago" stays honest. */
  now?: number | undefined;
}

function SubscriberImportRowImpl({
  job,
  onPress,
  busy,
  now,
}: SubscriberImportRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const status = importStatusPresentation(job.status, job.cancelRequested);
  const fraction = importProgressFraction(job);
  const counts = importProgressCounts(job);
  const strategy = onExistingDescription(job.onExisting);
  const created = job.createdAt
    ? relativeTime(job.createdAt, now === undefined ? {} : { now })
    : null;

  const progressLine =
    counts === null
      ? EMDASH
      : `${compactNum(counts.processed)} / ${compactNum(counts.total)} rows`;
  const progressSpoken =
    counts === null
      ? "Row progress unavailable"
      : `${num(counts.processed)} of ${num(counts.total)} rows processed`;
  const failedSpoken =
    isTerminalImport(job.status) && job.rowsFailed !== null && job.rowsFailed > 0
      ? ` ${num(job.rowsFailed)} rows failed.`
      : "";

  return (
    <Pressable
      onPress={() => onPress(job)}
      disabled={busy === true}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      accessibilityLabel={`${job.filename}. ${status.label}: ${status.description} ${progressSpoken}.${failedSpoken}${
        strategy ? ` ${strategy}` : ""
      }${created ? ` Created ${created}.` : ""}`}
      accessibilityHint="Opens the import to see its counts and confirm or stop it"
      style={{
        backgroundColor: t.surface,
        borderColor: job.status === "failed" ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // 44pt touch-target floor; the row is taller in practice.
        minHeight: 44,
        opacity: busy === true ? 0.55 : 1,
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
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {job.filename}
        </Text>
        <Pill label={status.label} tone={status.tone} />
      </View>

      <ProgressBar fraction={fraction} tone={status.tone} />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          // Dense: a compacted count pinned beside its neighbours.
          {...typeCap("numeric")}
          style={{
            color: t.fgMuted,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
          }}
        >
          {progressLine}
        </Text>
        {created ? (
          <Text
            numberOfLines={maxLinesAtScale(1, fontScale)}
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("numeric"),
              fontFamily: FONT.regular,
              flexShrink: 1,
            }}
          >
            · {created}
          </Text>
        ) : null}
      </View>

      {job.status === "failed" && job.errorMessage ? (
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {job.errorMessage}
        </Text>
      ) : strategy ? (
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {strategy}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A determinate bar ONLY when there is a measurement. `fraction === null` means
 * the server did not send enough to compute one (or the job has not started),
 * and an empty track is the honest rendering of that — it is not a 0% claim
 * because nothing is painted on it at all.
 */
function ProgressBar({
  fraction,
  tone,
}: {
  fraction: number | null;
  tone: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
}) {
  const { t } = useTheme();
  if (fraction === null) return null;
  const color =
    tone === "danger"
      ? t.danger
      : tone === "success"
        ? t.success
        : tone === "warning"
          ? t.warning
          : t.accent;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: t.bgSubtle,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${Math.round(fraction * 100)}%`,
          height: "100%",
          backgroundColor: color,
        }}
      />
    </View>
  );
}

export const SubscriberImportRow = memo(SubscriberImportRowImpl);
