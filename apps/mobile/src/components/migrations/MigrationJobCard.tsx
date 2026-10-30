/**
 * MigrationJobCard — one provider import, and the one control that can stop
 * it.
 *
 * A migration writes to the live subscriber table. When one goes wrong the
 * useful window is minutes, and the screen's answer was "cancels stay on
 * desktop" — for an idempotent DELETE /api/v1/migrations/{job_id} that the
 * desktop client itself calls a plain "idempotent cancel". Cancel is now
 * here, offered only for statuses where it can succeed (canCancelMigration)
 * and gated behind typing the source name. Rollback stays on desktop: it
 * needs the verification report read first, which does not fit a phone.
 *
 * Two smaller honesty fixes travel with it:
 *   - A job whose provider reports no totals no longer renders as a card
 *     with no progress affordance at all; it says so.
 *   - The job-id affordance no longer announces "Copy" while opening a
 *     share sheet, and no longer reads a whole UUID to VoiceOver.
 */
import { Pressable, Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { MigrationResourceProgress } from "@/components/migrations/MigrationResourceProgress";
import type { MobileMigrationJob } from "@/api/ops";
import { dateTime, truncateMiddle } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { canCancelMigration } from "@/lib/governanceActionPolicy";
import {
  isMobileMigrationFailure,
  mobileMigrationPercent,
  mobileMigrationResourceProgress,
} from "@/lib/migrationProgress";
import { mobileMigrationCutoverNote } from "@/lib/migrationSources";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface MigrationJobCardProps {
  job: MobileMigrationJob;
  statusTone: (status: string) => PillTone;
  imported: string | null;
  rollbackText: string | null;
  busy: boolean;
  canAct: boolean;
  onCancel: (job: MobileMigrationJob) => void;
  onShareId: (job: MobileMigrationJob) => void;
  /** Opens the verification report. Always available: reading the report needs
   *  the same owner/admin session the job list already required. */
  onOpenReport: (job: MobileMigrationJob) => void;
}

export function MigrationJobCard({
  job,
  statusTone,
  imported,
  rollbackText,
  busy,
  canAct,
  onCancel,
  onShareId,
  onOpenReport,
}: MigrationJobCardProps) {
  const { t } = useTheme();
  const status = String(job.status ?? "unknown");
  const percent = mobileMigrationPercent(job);
  const resourceRows = mobileMigrationResourceProgress(job.progress, job.source);
  const started = dateTime(job.started_at, "");
  const cutoverNote = mobileMigrationCutoverNote(job);
  const cancellable = canCancelMigration(status) && canAct;
  const sourceName = titleCase(String(job.source ?? "migration"));
  // Every read of `job.id` goes through this. It is a WIRE field, and the
  // screen red-screened with "Cannot read property 'slice' of undefined" when
  // it was absent -- /api/v1/migrations answered 200 text/html (an SPA
  // fallback for an absent upstream), so every field on every job was
  // undefined. Observed in-app on 2026-08-19.
  const jobId = typeof job.id === "string" ? job.id : "";

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            numberOfLines={1}
            {...typeCap("heading")}
            style={{
              color: t.fg,
              ...typeStyle("heading"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            {sourceName}
          </Text>
          <Pressable
            onPress={() => onShareId(job)}
            accessibilityRole="button"
            // Never read a 36-character UUID aloud: the shortened form is
            // enough to recognise the row, and the share sheet carries the
            // full value.
            accessibilityLabel={`Share job id, ending ${jobId.slice(-6)}`}
            accessibilityHint="Opens the system share sheet with the full job id"
            hitSlop={{ top: 16, bottom: 16, left: 8, right: 8 }}
            style={{ paddingVertical: 6, alignSelf: "flex-start" }}
          >
            <Text
              numberOfLines={1}
              {...typeCap("mono")}
              style={{
                color: t.fgMuted,
                ...typeStyle("mono"),
                marginTop: 2,
                fontFamily: "Menlo",
              }}
            >
              {truncateMiddle(jobId, 22)}
            </Text>
          </Pressable>
        </View>
        <Pill label={status} tone={statusTone(status)} />
      </View>

      <ProgressBlock
        percent={percent}
        failed={isMobileMigrationFailure(status)}
        source={sourceName}
        hasResourceRows={resourceRows.length > 0}
      />

      <MigrationResourceProgress rows={resourceRows} />

      {imported ? (
        <View style={{ marginTop: 10 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Subscribers
          </Text>
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fg,
              ...typeStyle("numeric"),
              fontWeight: "600",
              fontVariant: ["tabular-nums"],
              marginTop: 1,
              fontFamily: FONT.semibold,
            }}
          >
            {imported}
          </Text>
        </View>
      ) : null}

      {job.error ? (
        // Selectable and un-clamped: a truncated provider error with no way
        // to read the rest is the reason someone gives up and opens a laptop.
        <Text
          selectable
          {...typeCap("label")}
          style={{
            color: t.danger,
            ...typeStyle("label"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {job.error}
        </Text>
      ) : null}

      {cutoverNote ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.warning,
            ...typeStyle("label"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {cutoverNote}
        </Text>
      ) : null}

      {started || rollbackText ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            marginTop: 10,
          }}
        >
          {started ? (
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("numeric"),
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.regular,
              }}
            >
              {`Started ${started}`}
            </Text>
          ) : null}
          {rollbackText ? <Pill label={rollbackText} tone="warning" /> : null}
        </View>
      ) : null}

      {/* GOVERNANCE#7: the report was unreachable from a phone, so a six-hour
          import that "completed" with an estimated data loss looked exactly
          like a clean one. The read is offered for EVERY status — a running
          job answers "no report yet", which is itself the thing the operator
          wanted to know. */}
      <Pressable
        onPress={() => onOpenReport(job)}
        accessibilityRole="button"
        accessibilityLabel={`Open the verification report for the ${sourceName} import`}
        accessibilityHint="Shows what came across, what needs a human, and per-resource completeness"
        style={{
          marginTop: 12,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.bgSubtle,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.accent,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          Verification report
        </Text>
      </Pressable>

      {canCancelMigration(status) ? (
        <Pressable
          onPress={() => onCancel(job)}
          disabled={!cancellable || busy}
          accessibilityRole="button"
          accessibilityLabel={busy ? "Cancelling" : `Cancel the ${sourceName} import`}
          accessibilityHint="Stops this migration. Already-imported records are left in place."
          accessibilityState={{ disabled: !cancellable || busy, busy }}
          style={{
            marginTop: 12,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            borderWidth: 1,
            borderColor: t.danger,
            opacity: !cancellable || busy ? 0.45 : 1,
          }}
        >
          <Text
            {...typeCap("callout")}
            style={{
              color: t.danger,
              ...typeStyle("callout"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            {busy ? "Cancelling…" : "Cancel import"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A job whose provider reports no totals used to render with the progress
 * block simply absent — indistinguishable from a job that has not started.
 * Say which it is.
 */
function ProgressBlock({
  percent,
  failed,
  source,
  hasResourceRows,
}: {
  percent: number | null;
  failed: boolean;
  source: string;
  hasResourceRows: boolean;
}) {
  const { t } = useTheme();
  if (percent == null) {
    if (hasResourceRows) return null;
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 12,
          fontFamily: FONT.regular,
        }}
      >
        {`${source} doesn't report totals, so there is no percentage to show. Watch the per-resource counts and the status badge instead.`}
      </Text>
    );
  }
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <View
      style={{ marginTop: 12 }}
      accessible
      accessibilityLabel={`${clamped} percent complete`}
    >
      <View
        style={{
          height: 6,
          borderRadius: 999,
          overflow: "hidden",
          backgroundColor: t.bgSubtle,
        }}
      >
        <View
          style={{
            width: `${clamped}%`,
            height: "100%",
            backgroundColor: failed ? t.danger : t.accent,
          }}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          marginTop: 6,
          fontFamily: FONT.regular,
        }}
      >
        {`${clamped}% complete`}
      </Text>
    </View>
  );
}

function titleCase(value: string): string {
  if (!value) return "";
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
