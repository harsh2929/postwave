/**
 * DestinationSyncJobRow — one row of an audience destination's sync history,
 * and the provider's own account of why it failed.
 *
 * DIAGNOSTICS `GET /{id}/jobs/{job_id}/diagnostics` — viewer. Tap-through from
 * a non-succeeded job row; refusals are rendered as their REASON
 * (`diagnosticsRefusalMessage`), because a 409 "no provider request id was
 * recorded" is a fact about the job and "couldn't load" would be a lie about
 * the network.
 *
 * PRESENTATIONAL ON PURPOSE, like the sheet that owns it: every query and
 * mutation is passed in, so a test can pin the failure-state sentences.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import type { QueryLike } from "@/components/QueryStates";
import type { JobDiagnostics } from "@/lib/audienceDestinationActions";
import {
  syncJobSummary,
  syncJobTone,
  type DestinationSyncJob,
} from "@/lib/audienceDestinationRows";
import { FONT } from "@/lib/fonts";
import { EMDASH, relativeTime } from "@/lib/format";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

/** The opened-job state and the diagnostics read, owned by the panel. */
export interface JobDiagnosticsControls {
  openJobId: string | null;
  onToggleJob: (jobId: string) => void;
  data: JobDiagnostics | null;
  query: QueryLike;
  /** The pre-built refusal/failure sentence for an errored read. */
  errorMessage: string | null;
}

/** A job whose outcome invites "why?" — terminal and not clean. */
export function jobIsDiagnosable(job: DestinationSyncJob): boolean {
  return (
    job.id !== "" && job.status !== "succeeded" && job.status !== "running"
  );
}

/**
 * One job. The whole summary row is one accessibility node because the status,
 * the time and the reason are a single fact. A terminal non-clean job gains a
 * tap-through that asks the provider for its own account of the failure.
 */
export function SyncJobRow({
  job,
  now,
  diagnostics,
}: {
  job: DestinationSyncJob;
  now: number;
  diagnostics: JobDiagnosticsControls;
}) {
  const { t } = useTheme();
  const summary = syncJobSummary(job);
  const started = job.startedAt ? relativeTime(job.startedAt, { now }) : EMDASH;
  const startedSpoken = job.startedAt
    ? `started ${started}`
    : "its start time was not recorded";
  const diagnosable = jobIsDiagnosable(job);
  const open = diagnosable && diagnostics.openJobId === job.id;

  return (
    <View
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
        accessible
        accessibilityLabel={`Sync ${job.status || "unknown"}, ${startedSpoken}. ${summary}`}
        style={{ gap: 6 }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Pill label={job.status || "unknown"} tone={syncJobTone(job.status)} />
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
            {started}
          </Text>
        </View>
        <Text
          {...typeCap("bodySmall")}
          style={{
            // The provider's own words are the operator's lead when they open a
            // support ticket with that provider, so the error is echoed verbatim
            // and in the danger colour rather than folded into grey prose.
            color: job.error ? t.danger : t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {summary}
        </Text>
      </View>
      {diagnosable ? (
        <Pressable
          onPress={() => diagnostics.onToggleJob(job.id)}
          accessibilityRole="button"
          accessibilityLabel={
            open ? "Hide provider diagnostics" : "Ask the provider why"
          }
          accessibilityState={{ expanded: open }}
          style={{ minHeight: 32, justifyContent: "center" }}
        >
          <Text
            {...typeCap("caption")}
            style={{
              color: t.accent,
              ...typeStyle("caption"),
              fontFamily: FONT.semibold,
            }}
          >
            {open ? "Hide provider diagnostics" : "Ask the provider why"}
          </Text>
        </Pressable>
      ) : null}
      {open ? <DiagnosticsBlock diagnostics={diagnostics} /> : null}
    </View>
  );
}

/**
 * The provider's answer for the opened job — or the REASON there isn't one.
 * A refusal code is a fact about the job, so the sentence states it plainly
 * instead of dressing it as a network failure.
 */
function DiagnosticsBlock({
  diagnostics,
}: {
  diagnostics: JobDiagnosticsControls;
}) {
  const { t } = useTheme();
  if (diagnostics.query.isError) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {diagnostics.errorMessage ??
          "The diagnostics read failed. The history above is still what was recorded locally."}
      </Text>
    );
  }
  const data = diagnostics.data;
  if (!data) {
    return (
      <Text
        {...typeCap("caption")}
        style={{ color: t.fgSubtle, ...typeStyle("caption") }}
      >
        Asking the provider…
      </Text>
    );
  }
  const lines: string[] = [];
  if (data.providerStatus) lines.push(`Provider status: ${data.providerStatus}`);
  if (data.providerMessage) lines.push(data.providerMessage);
  if (data.externalJobId) lines.push(`Provider job id: ${data.externalJobId}`);
  if (data.externalAudienceId) {
    lines.push(`Provider audience: ${data.externalAudienceId}`);
  }
  if (lines.length === 0) {
    lines.push(
      "The provider answered but reported nothing beyond what the row above already says.",
    );
  }
  return (
    <View style={{ gap: 2 }}>
      {lines.map((line) => (
        <Text
          key={line}
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}
