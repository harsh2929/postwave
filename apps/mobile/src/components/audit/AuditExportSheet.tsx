/**
 * AuditExportSheet — start an audit export from the filters on screen, and see
 * what has already been exported.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, and why:
 *
 *  - NO DOWNLOAD BUTTON. GET /api/v1/audit/export-jobs/{id}/download streams
 *    the CSV behind the session, so it cannot be handed to the OS browser or a
 *    share sheet as a URL — a "Download" control here could only ever produce a
 *    401 page. The sheet says where to collect the file instead.
 *  - NO "EMAIL IT TO ME" TOGGLE. The request body accepts `emailOnComplete`
 *    and the column is stored and echoed back, but nothing in the API sends
 *    that mail for an ad-hoc job — only the separate scheduled-export worker
 *    mails, on its own path. Offering the toggle would be a promise the server
 *    does not keep.
 *
 * What it DOES do is the half that genuinely belongs on a phone: capture the
 * evidence window you are looking at, right now, before the retention job or
 * the incident moves on — and be honest that the search box and the
 * Destructive toggle are not part of it.
 */
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Pill } from "@/components/Pill";
import { isPausedFirstFetch, QueryStates } from "@/components/QueryStates";
import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useTickingNow } from "@/hooks/useTickingNow";
import type { AuditExportSchedulesController } from "@/hooks/useAuditExport";
import {
  activeAuditExport,
  auditExportDetail,
  auditExportHeadline,
  auditExportKind,
  auditExportProgressPct,
  auditExportSpoken,
  auditExportTone,
  type AuditExportJob,
  type AuditExportScope,
} from "@/lib/auditExport";
import { AuditExportSchedules } from "./AuditExportSchedules";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { AuditAction } from "./AuditAction";
import { SheetHeader } from "./AuditSheetParts";

/**
 * The header trigger. Lives here rather than in the screen so the whole export
 * affordance — button, sheet, history — is one thing to read and one thing to
 * remove.
 *
 * `unread` marks an export the user has not looked at since it finished, which
 * is the only reason to draw attention to a header control on a log screen.
 */
export function AuditExportButton({
  onPress,
  busy,
}: {
  onPress: () => void;
  busy?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={busy ? "Export, in progress" : "Export the audit log"}
      accessibilityHint="Opens the export sheet for the filters currently applied"
      hitSlop={8}
      style={{
        minHeight: 44,
        minWidth: 44,
        paddingHorizontal: 6,
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.accent,
          fontWeight: "600",
          fontFamily: FONT.semibold,
          ...typeStyle("callout"),
        }}
      >
        {busy ? "Exporting…" : "Export"}
      </Text>
    </Pressable>
  );
}

export interface AuditExportSheetProps {
  visible: boolean;
  onClose: () => void;
  /** What the current filters will and will not export. */
  scope: AuditExportScope;
  jobs: readonly AuditExportJob[] | undefined;
  loading: boolean;
  /** The history query's isPending/isPaused: a paused first fetch is offline. */
  isPending: boolean;
  isPaused: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => unknown;
  /**
   * False with the auth gate closed or without a tenant. It is auth state,
   * not reachability: the sheet reads the connection itself.
   */
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  /** Recurring evidence-pack schedules (list for readers, CRUD for admins). */
  schedules: AuditExportSchedulesController;
}

export function AuditExportSheet({
  visible,
  onClose,
  scope,
  jobs,
  loading,
  isPending,
  isPaused,
  isError,
  error,
  refetch,
  canStart,
  starting,
  onStart,
  schedules,
}: AuditExportSheetProps) {
  const { t } = useTheme();
  // A queued job crosses into "not picked up" purely by the passage of time,
  // and a running one advances — so this sheet re-derives on a clock rather
  // than freezing whatever the last response happened to say.
  const now = useTickingNow(visible);
  const inFlight = activeAuditExport(jobs, now);
  // `canStart` is auth state, not reachability. Offline, the start mutation
  // (networkMode "always") fails at once into an error toast, and the copy
  // here says an export cannot be started offline. So when either signal says
  // offline, the button says it needs a connection and does not fire. The two
  // signals are the OS (NetInfo), which still applies once the history has
  // loaded, and TanStack's paused first fetch of the history.
  const online = useIsOnline();
  const reachable =
    online && canStart && !isPausedFirstFetch({ isPending, isPaused });

  return (
    <ReducedMotionModal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
        accessibilityViewIsModal
        accessibilityLabel="Export the audit log"
      >
        <SheetHeader title="Export" onClose={onClose} />
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontFamily: FONT.regular,
              ...typeStyle("bodySmall"),
            }}
          >
            {scope.applied}
          </Text>
          {scope.dropped ? (
            <Text
              {...typeCap("label")}
              accessibilityRole="alert"
              style={{
                color: t.warning,
                marginTop: 6,
                fontFamily: FONT.regular,
                ...typeStyle("label"),
              }}
            >
              {scope.dropped}
            </Text>
          ) : null}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              marginTop: 6,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            The export runs on the server and lands in the history below.
            Collect the CSV from the web admin — the download is session-bound
            and cannot be opened from this device.
          </Text>

          <View style={{ flexDirection: "row", marginTop: 14 }}>
            <AuditAction
              label={startLabel({ starting, inFlight, canStart: reachable })}
              hint="Queues a server-side CSV export of the audit log for the filters shown above"
              emphasis
              disabled={!reachable || starting || Boolean(inFlight)}
              onPress={onStart}
            />
          </View>

          <SectionLabel>Export history</SectionLabel>
          <QueryStates
            query={{
              isError,
              isLoading: loading,
              isPending,
              isPaused,
              error,
              ...(refetch ? { refetch } : {}),
            }}
            gate={{ enabled: canStart }}
            isEmpty={(jobs ?? []).length === 0}
            skeleton={<SkeletonList rows={2} lines={2} label="Loading export history" />}
            offlineMessage="Connect to your workspace to see previous exports. An export always runs on the server, so it cannot be started offline."
            empty={{
              title: "No exports yet",
              description:
                "Exports you start here — and any started from the web admin — appear in this list.",
            }}
          >
            {(jobs ?? []).map((job) => (
              <ExportJobRow key={job.id} job={job} now={now} />
            ))}
          </QueryStates>

          <AuditExportSchedules controller={schedules} />
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

/**
 * The button never claims an action it will not take: while a job is already
 * queued or running it names that job rather than offering a duplicate export
 * of identical rows.
 */
function startLabel({
  starting,
  inFlight,
  canStart,
}: {
  starting: boolean;
  inFlight: AuditExportJob | null;
  canStart: boolean;
}): string {
  if (starting) return "Starting…";
  if (inFlight) return "An export is already running";
  if (!canStart) return "Export needs a connection";
  return "Export this window";
}

function ExportJobRow({ job, now }: { job: AuditExportJob; now: number }) {
  const { t } = useTheme();
  const kind = auditExportKind(job, now);
  const pct = kind === "running" ? auditExportProgressPct(job) : null;
  return (
    <View
      accessible
      accessibilityLabel={auditExportSpoken(job, now)}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 8,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={2}
          style={{
            color: t.fg,
            flex: 1,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
          }}
        >
          {auditExportHeadline(job, now)}
        </Text>
        {/* The pill repeats the state as a WORD, so the status is never
            carried by colour alone. */}
        <Pill label={kind} tone={auditExportTone(kind)} />
      </View>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("bodySmall"),
        }}
      >
        {auditExportDetail(job, now)}
      </Text>
      {pct !== null ? (
        <View
          style={{
            height: 6,
            borderRadius: 3,
            backgroundColor: t.borderSubtle,
            overflow: "hidden",
            marginTop: 4,
          }}
        >
          <View
            style={{
              width: `${pct}%`,
              height: "100%",
              borderRadius: 3,
              backgroundColor: t.accent,
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
