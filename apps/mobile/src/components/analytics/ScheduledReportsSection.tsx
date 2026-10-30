/**
 * ScheduledReportsSection — the phone-shaped slice of recurring digest emails.
 *
 * WHAT THIS IS NOT. Desktop's ScheduledReportsSection is 1,310 lines of
 * AUTHORING: name, template picker, timezone-aware recurrence builder,
 * recipient editor, validation. Composing a cron-like rule on a phone is a bad
 * idea and this does not attempt it — there is no create, no edit, no delete.
 *
 * WHAT IT IS. The four things you need when a report is misbehaving and you
 * are not at a desk:
 *
 *   1. WHAT IS SCHEDULED — every report, ordered by what is broken, then by
 *      what fires soonest, then what is switched off (`sortScheduledReports`).
 *      The server orders by authoring date, which is never why you are here.
 *   2. WHEN IT NEXT FIRES — relative ("in 4 hours") with the absolute
 *      timestamp beside it, because "in 4 hours" is not actionable when you
 *      are deciding whether you have time to stop it.
 *   3. PAUSE / RESUME — the one control that stops a report emailing the exec
 *      team at the wrong hour. Behind a confirm sheet stating the consequence
 *      in terms of RECIPIENTS, not of a boolean.
 *   4. SEND NOW — verify the schedule and the email body look right, without
 *      waiting a week for the next occurrence.
 *
 * AUTHORIZATION. Every route is `RequireScope(ScopeAdmin)`
 * (scheduled_reports.go MountRoutes). Read from the handler, not the manifest:
 * on a SESSION that is enforced as owner|admin (apikeys/middleware.go), and on
 * an API-key session the key itself must carry `admin` — which mobile models
 * as "api_key sessions get viewer only" (canAccessMinimumRole). A viewer never
 * sees the section rather than seeing it render a 403.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  useScheduledReports,
  useSendScheduledReportNow,
  useSetScheduledReportEnabled,
} from "@/hooks/useScheduledReports";
import { FONT } from "@/lib/fonts";
import { EMDASH, dateTime, relativeTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  pauseConfirmCopy,
  recipientsSummary,
  reportHealth,
  reportStatusLine,
  scheduleLabel,
  scheduledReportSpoken,
  sendNowConfirmCopy,
  sortScheduledReports,
  type ScheduledReportHealth,
  type ScheduledReportRow,
} from "@/lib/scheduledReports";
import { useAuthStore } from "@/store/auth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** State is never colour alone — the pill carries the word too. */
const HEALTH_PILL: Readonly<
  Record<
    ScheduledReportHealth,
    { label: string; tone: "danger" | "warning" | "success" | "neutral" }
  >
> = {
  failing: { label: "failing", tone: "danger" },
  due: { label: "due now", tone: "warning" },
  paused: { label: "paused", tone: "neutral" },
  scheduled: { label: "scheduled", tone: "success" },
};

export function ScheduledReportsSection({ now }: { now: number }) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const confirm = useConfirm();
  const { toast } = useToast();

  const allowed = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const query = useScheduledReports(allowed);
  const setEnabled = useSetScheduledReportEnabled();
  const sendNow = useSendScheduledReportNow();
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = sortScheduledReports(query.data ?? [], now);

  const onTogglePause = useCallback(
    async (row: ScheduledReportRow) => {
      const copy = pauseConfirmCopy(row);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
        consequence: copy.consequence,
      });
      if (!ok) return;
      setBusyId(row.id);
      try {
        await setEnabled.mutateAsync({ id: row.id, enabled: !row.enabled });
        haptics.success();
        toast({
          kind: "success",
          message: row.enabled ? "Report paused" : "Report resumed",
        });
      } catch (error) {
        haptics.error();
        toast({ kind: "error", message: writeFailed(error, row.enabled) });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, setEnabled, toast],
  );

  const onSendNow = useCallback(
    async (row: ScheduledReportRow) => {
      const copy = sendNowConfirmCopy(row);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: copy.confirmLabel,
        consequence: copy.consequence,
      });
      if (!ok) return;
      setBusyId(row.id);
      try {
        await sendNow.mutateAsync(row.id);
        haptics.success();
        toast({ kind: "success", message: "Queued one run" });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Couldn't queue a run right now.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [confirm, sendNow, toast],
  );

  // Not an empty state and not an error: this operator is not allowed to see
  // it, which is a fact about the workspace rather than about the data.
  if (!allowed) return null;

  return (
    <View>
      <SectionLabel
        topMargin={20}
        subtitle="Recurring digests this workspace emails on a schedule."
      >
        Scheduled reports
      </SectionLabel>
      <QueryStates
        query={query}
        isEmpty={rows.length === 0}
        gate={gate}
        skeleton={<SkeletonList rows={2} lines={3} />}
        empty={{
          title: "No scheduled reports",
          description:
            "Recurring digests are created in the web app; once one exists you can pause it or send it early from here.",
        }}
      >
        <View style={{ gap: 10 }}>
          {rows.map((row) => (
            <ReportCard
              key={row.id}
              row={row}
              now={now}
              busy={busyId === row.id}
              online={gate.enabled}
              onTogglePause={onTogglePause}
              onSendNow={onSendNow}
            />
          ))}
        </View>
      </QueryStates>
      {!gate.enabled && rows.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          Offline — pausing and sending need a connection. Neither is queued for
          later: a schedule change that lands hours after you made it is not the
          change you made.
        </Text>
      ) : null}
    </View>
  );
}

function writeFailed(error: unknown, wasEnabled: boolean): string {
  const verb = wasEnabled ? "pause" : "resume";
  if (error instanceof Error && error.message) return error.message;
  return `Couldn't ${verb} that report.`;
}

function ReportCard({
  row,
  now,
  busy,
  online,
  onTogglePause,
  onSendNow,
}: {
  row: ScheduledReportRow;
  now: number;
  busy: boolean;
  online: boolean;
  onTogglePause: (row: ScheduledReportRow) => void;
  onSendNow: (row: ScheduledReportRow) => void;
}) {
  const { t } = useTheme();
  const health = reportHealth(row, now);
  const pill = HEALTH_PILL[health];
  // A paused report has no next run, and the server may not have computed one
  // yet. Neither is "now" — say nothing rather than inventing a time.
  const nextRelative = row.enabled
    ? relativeTime(row.nextDueAt, { now, fallback: EMDASH })
    : EMDASH;
  const nextAbsolute = row.enabled ? dateTime(row.nextDueAt) : EMDASH;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: health === "failing" ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {/* The INFORMATION is one accessibility element, so VoiceOver reads a
          coherent sentence instead of six detached fragments. The buttons are
          deliberately OUTSIDE it: `accessible` on a container that held them
          too would collapse the whole card into a single element on iOS and
          make Pause and Send now unreachable by VoiceOver. */}
      <View
        accessible
        accessibilityLabel={scheduledReportSpoken(row, now, nextRelative)}
        style={{ gap: 8 }}
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          importantForAccessibility="no-hide-descendants"
        >
          <Text
            {...typeCap("body")}
            numberOfLines={2}
            style={{
              color: t.fg,
              ...typeStyle("body"),
              flex: 1,
              fontFamily: FONT.semibold,
            }}
          >
            {row.name}
          </Text>
          <Pill label={pill.label} tone={pill.tone} />
        </View>

        <Text
          {...typeCap("bodySmall")}
          importantForAccessibility="no-hide-descendants"
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {scheduleLabel(row.schedule, row.timezone)}
        </Text>

        <View
          style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}
          importantForAccessibility="no-hide-descendants"
        >
          <Meta label="Next run" value={nextRelative} detail={nextAbsolute} />
          <Meta label="Sends to" value={recipientsSummary(row)} />
        </View>

        <Text
          {...typeCap("label")}
          importantForAccessibility="no-hide-descendants"
          style={{
            color: health === "failing" ? t.danger : t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {reportStatusLine(row, now)}
        </Text>
      </View>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
        <CardButton
          label={row.enabled ? "Pause" : "Resume"}
          a11y={row.enabled ? `Pause ${row.name}` : `Resume ${row.name}`}
          tone={row.enabled ? "danger" : "accent"}
          disabled={busy || !online}
          onPress={() => onTogglePause(row)}
        />
        <CardButton
          label="Send now"
          a11y={`Send ${row.name} now`}
          tone="neutral"
          disabled={busy || !online}
          onPress={() => onSendNow(row)}
        />
      </View>
    </View>
  );
}

function Meta({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  const { t } = useTheme();
  return (
    <View style={{ minWidth: 120 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          letterSpacing: 0.4,
          textTransform: "uppercase",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontFamily: FONT.medium,
        }}
      >
        {value}
      </Text>
      {detail && detail !== value ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontVariant: ["tabular-nums"],
            fontFamily: FONT.regular,
          }}
        >
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function CardButton({
  label,
  a11y,
  tone,
  disabled,
  onPress,
}: {
  label: string;
  a11y: string;
  tone: "danger" | "accent" | "neutral";
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const color =
    tone === "danger" ? t.danger : tone === "accent" ? t.accent : t.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      // Static object — NativeWind v4 silently drops the function form.
      style={{
        flex: 1,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: tone === "neutral" ? t.border : color,
        backgroundColor: t.bgSubtle,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        {...typeCap("control")}
        style={{ color, ...typeStyle("control"), fontFamily: FONT.semibold }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
