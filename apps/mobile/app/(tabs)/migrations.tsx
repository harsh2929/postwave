/**
 * Migrations — mobile operator view for provider migration jobs.
 *
 * The desktop app owns OAuth/API-key starts and rollback. Mobile focuses on
 * status, source capability visibility, failure triage — and, new here,
 * CANCEL.
 *
 * Cancel is the one migration write that belongs on a phone: an import
 * writes to the live subscriber table, so the useful window for stopping a
 * runaway one is minutes, not "until I'm back at a desk". It is idempotent
 * server-side (DELETE /api/v1/migrations/{job_id}) and offered only for
 * statuses where it can succeed. Rollback stays on desktop because it
 * should not be run without reading the verification report first.
 *
 * Parity with desktop (apps/desktop/src/pages/Migrations.tsx): status
 * filter chips with live counts, started/rollback-window timestamps, a
 * subscribers-imported readout, and a per-resource progress breakdown.
 */
import { useMemo, useState } from "react";
import {
  SectionList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Card } from "@/components/Card";
import { Pill, type PillTone } from "@/components/Pill";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { StaleDataBanner } from "@/components/StaleDataBanner";
import { MigrationDetailSheet } from "@/components/migrations/MigrationDetailSheet";
import { MigrationJobCard } from "@/components/migrations/MigrationJobCard";
import { MigrationParityCard } from "@/components/migrations/MigrationParityCard";
import { useMigrationJobActions } from "@/components/migrations/useMigrationJobActions";
import { EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { MOBILE_SECTION_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import {
  useMobileMailchimpParity,
  useMobileMigrationSources,
  useMobileMigrations,
} from "@/hooks/useMigrations";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  migrationSourceAutomationNote,
  migrationSourceAuthLabel,
  supportedMigrationCapabilityLabels,
} from "@/lib/migrationSources";
import {
  filterMobileMigrations,
  isMobileMigrationDone,
  isMobileMigrationFailure,
  isMobileMigrationRunning,
  mobileMigrationStatusCounts,
  type MobileMigrationStatusFilter,
} from "@/lib/migrationProgress";
import {
  governanceMetricsUnavailable,
  governanceOfflineNotice,
} from "@/lib/governanceOfflineStates";
import {
  buildMigrationJobItems,
  buildMigrationSourceItems,
  type MigrationListItem,
} from "@/lib/migrationListItems";
import type {
  MobileMigrationJob,
  MobileMigrationSource,
} from "@/api/client";

type MigrationSection = {
  key: "jobs" | "sources" | "parity";
  title: string;
  showFilters?: boolean;
  data: MigrationListItem[];
};

/** A malformed migration payload degrades this screen, not the whole app. */
export { AppErrorBoundary as ErrorBoundary };

const FILTERS: readonly { key: MobileMigrationStatusFilter; label: string }[] =
  [
    { key: "all", label: "All" },
    { key: "running", label: "In-flight" },
    { key: "failed", label: "Failed" },
    { key: "done", label: "Done" },
  ];

export default function Migrations() {
  const { t } = useTheme();
  useScreenViewed("migrations");
  const gate = useOnlineQueryGate();
  const jobs = useMobileMigrations();
  const sources = useMobileMigrationSources();
  const jobActions = useMigrationJobActions();
  const jobsError = jobs.error;
  const jobsIsError = jobs.isError;
  const jobsIsLoading = jobs.isLoading;
  const refetchJobs = jobs.refetch;
  const sourcesError = sources.error;
  const sourcesIsError = sources.isError;
  const sourcesIsLoading = sources.isLoading;
  const refetchSources = sources.refetch;
  // Stabilise the `[]` fallback identity so the counts/filteredRows memos
  // below don't recompute on every render while data is absent.
  const rows = useMemo(() => (Array.isArray(jobs.data) ? jobs.data : []), [jobs.data]);
  const sourceRows = useMemo(() => (Array.isArray(sources.data) ? sources.data : []), [sources.data]);
  const [filter, setFilter] = useState<MobileMigrationStatusFilter>("all");
  // The open report, held by ID rather than by object so the 5s poll's fresh
  // row identity does not tear the sheet down and rebuild it mid-read.
  const [reportJobId, setReportJobId] = useState<string | null>(null);

  // GOVERNANCE#33. Offline, both queries are DISABLED — neither loading nor
  // errored, `data` undefined — so every branch below used to fall through to
  // "No migration jobs / Start migrations from desktop", telling an operator
  // on a train that the import they kicked off an hour ago does not exist.
  // A disabled query has not learned there are no jobs; it has not asked.
  const jobsOffline = governanceOfflineNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "migrationJobs",
  });
  const sourcesOffline = governanceOfflineNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    surface: "migrationSources",
  });
  // When the jobs fetch failed — or never ran — and we have no cached rows to
  // summarize, the count strip would otherwise read a misleading "0 / 0 / 0"
  // (an absent measurement rendered as a successful zero). Show "—" instead,
  // matching the scim/audit-sinks operator surfaces.
  const metricsUnavailable = governanceMetricsUnavailable({
    failed: jobsIsError && jobs.data === undefined,
    offline: jobsOffline !== null,
    cachedRowCount: rows.length,
  });
  // A background poll failed — or we went offline — but we still hold cached
  // job rows: keep them on screen and show a slim banner rather than
  // flickering to a full ErrorState every failed 5s poll.
  const jobsStale = jobsIsError && rows.length > 0;
  const jobsOfflineStale = jobsOffline !== null && rows.length > 0;

  const reportJob = useMemo(
    () => rows.find((job) => job.id === reportJobId) ?? null,
    [rows, reportJobId],
  );

  const counts = useMemo(() => mobileMigrationStatusCounts(rows), [rows]);
  const filteredRows = useMemo(
    () => filterMobileMigrations(rows, filter),
    [rows, filter],
  );

  // A 5s poll flips `isFetching` constantly; binding the spinner to it made
  // the screen strobe during exactly the window it exists for. Only a real
  // pull shows the spinner.
  const parity = useMobileMailchimpParity();

  const refresh = useManualRefresh([refetchJobs, refetchSources], {
    enabled: gate.enabled,
  });


  const jobItems = useMemo<MigrationListItem[]>(
    () =>
      buildMigrationJobItems({
        rows,
        filteredRows,
        isLoading: jobsIsLoading,
        isError: jobsIsError,
        error: jobsError,
        offline: jobsOffline,
        onRetry: () => void refetchJobs(),
        onShowAll: () => setFilter("all"),
      }),
    [
      filteredRows,
      jobsError,
      jobsIsError,
      jobsIsLoading,
      jobsOffline,
      refetchJobs,
      rows,
    ],
  );

  const sourceItems = useMemo<MigrationListItem[]>(
    () =>
      buildMigrationSourceItems({
        rows: sourceRows,
        isLoading: sourcesIsLoading,
        isError: sourcesIsError,
        error: sourcesError,
        offline: sourcesOffline,
        onRetry: () => void refetchSources(),
      }),
    [
      refetchSources,
      sourceRows,
      sourcesError,
      sourcesIsError,
      sourcesIsLoading,
      sourcesOffline,
    ],
  );

  // Readiness is a SEPARATE section rather than a header block: it loads on its
  // own timing (four compat endpoints), and putting it in the header would make
  // the whole list wait to render behind the slowest of them.
  const paritySection = useMemo<MigrationSection[]>(() => {
    if (!parity.data) return [];
    return [
      {
        key: "parity",
        title: "Already on Moosewave",
        data: [
          {
            kind: "parity" as const,
            key: "parity-snapshot",
            snapshot: parity.data,
          },
        ],
      },
    ];
  }, [parity.data]);

  const sections = useMemo<MigrationSection[]>(
    () => [
      ...paritySection,
      {
        key: "jobs",
        title: "Recent jobs",
        // Not gated on jobsIsError: a failed background poll retains cached
        // rows (see jobItems), so keep the filter chips visible too instead of
        // collapsing the chip row on every flaky 5s poll.
        showFilters: !jobsIsLoading && rows.length > 1,
        data: jobItems,
      },
      {
        key: "sources",
        title: `Source coverage${sourceRows.length > 0 ? ` (${sourceRows.length})` : ""}`,
        data: sourceItems,
      },
    ],
    [jobItems, jobsIsLoading, paritySection, rows.length, sourceItems, sourceRows.length],
  );

  const renderItem = ({ item }: { item: MigrationListItem }) => {
    switch (item.kind) {
      case "job":
        return (
          <MigrationJobCard
            job={item.job}
            statusTone={statusTone}
            imported={subscribersImported(item.job)}
            rollbackText={rollbackWindow(item.job)}
            busy={jobActions.cancellingId === item.job.id}
            canAct={gate.enabled}
            onCancel={jobActions.cancel}
            onShareId={jobActions.shareId}
            onOpenReport={(job) => setReportJobId(job.id)}
          />
        );
      case "source":
        return <SourceCard source={item.source} />;
      case "parity":
        return <MigrationParityCard snapshot={item.snapshot} />;
      case "loading":
        return <SkeletonList rows={3} lines={3} label="Loading migrations" />;
      case "error":
        return <ErrorState error={item.error} onRetry={item.onRetry} />;
      case "empty":
        return (
          <EmptyState
            title={item.title}
            description={item.description}
            {...(item.cta ? { cta: item.cta } : {})}
          />
        );
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Migrations" onBack={goBackOrMore} />
      <SectionList
        {...MOBILE_SECTION_LIST_PERF_PROPS}
        sections={sections}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <>
            {jobsStale ? (
              <StaleDataBanner onRetry={() => void refetchJobs()} />
            ) : jobsOfflineStale ? (
              // Offline but holding cached job cards. No Retry: the query is
              // disabled, so the button could only fail silently — and no
              // "refresh failed" claim either, because nothing was attempted.
              <StaleDataBanner
                message={jobsOffline.staleMessage}
                accessibilityLabel={`${jobsOffline.title}. ${jobsOffline.staleMessage}`}
              />
            ) : null}
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
              <Metric
                label="Running"
                value={metricsUnavailable ? null : counts.running}
                tone="info"
              />
              <Metric
                label="Failed"
                value={metricsUnavailable ? null : counts.failed}
                tone="danger"
              />
              <Metric
                label="Done"
                value={metricsUnavailable ? null : counts.done}
                tone="success"
              />
            </View>
          </>
        }
        renderSectionHeader={({ section }) => (
          <View>
            {/* GOVERNANCE#55: the shared component, not a fourth local
                `sectionLabel(t)` factory. It brings accessibilityRole="header"
                and the one 11/600/0.6 definition with it, so a change to the
                shell's heading rhythm reaches this screen too. */}
            <SectionLabel topMargin={section.key === "sources" ? 18 : 0}>
              {section.title}
            </SectionLabel>
            {section.showFilters ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                {FILTERS.map((f) => (
                  <FilterChip
                    key={f.key}
                    label={f.label}
                    count={counts[f.key]}
                    active={filter === f.key}
                    onPress={() => setFilter(f.key)}
                  />
                ))}
              </View>
            ) : null}
          </View>
        )}
      />
      {/* Mounted unconditionally: `job === null` keeps the Modal invisible, and
          holding it here (not inside the card) means the 5s job poll cannot
          unmount an open report. */}
      <MigrationDetailSheet
        job={reportJob}
        onClose={() => setReportJobId(null)}
      />
    </SafeAreaView>
  );
}

function FilterChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Filter ${label}, ${count} ${count === 1 ? "job" : "jobs"}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? t.accent : t.borderSubtle,
        backgroundColor: active ? t.accent : t.surface,
      }}
    >
      <Text
        {...typeCap("badge")}
        style={{
          color: active ? t.accentFg : t.fg,
          ...typeStyle("badge"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("badgeSmall")}
        style={{
          color: active ? t.accentFg : t.fgSubtle,
          ...typeStyle("badgeSmall"),
          fontVariant: ["tabular-nums"],
          fontFamily: FONT.regular,
        }}
      >
        {num(count)}
      </Text>
    </Pressable>
  );
}

function SourceCard({ source }: { source: MobileMigrationSource }) {
  const { t } = useTheme();
  const supported = supportedMigrationCapabilityLabels(source);
  const authLabel = migrationSourceAuthLabel(source);
  const automationNote = migrationSourceAutomationNote(source);
  const extra = supported.length - 7;
  return (
    <Card variant="compact" style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            flex: 1,
            fontFamily: FONT.semibold,
          }}
          numberOfLines={1}
        >
          {titleCase(source.source)}
        </Text>
        {authLabel ? <Pill label={authLabel} tone="neutral" /> : null}
      </View>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 8,
          fontFamily: FONT.regular,
        }}
        numberOfLines={3}
      >
        {supported.length > 0
          ? supported.slice(0, 7).join(", ") +
            (extra > 0 ? ` +${extra} more` : "")
          : "No capabilities advertised"}
      </Text>
      {automationNote ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
          numberOfLines={3}
        >
          {automationNote}
        </Text>
      ) : null}
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: PillTone;
}) {
  const { t } = useTheme();
  const color =
    tone === "success" ? t.success : tone === "danger" ? t.danger : t.info;
  const display = value === null ? EMDASH : num(value);
  return (
    <Card
      variant="compact"
      style={{ flex: 1 }}
      accessible
      accessibilityLabel={
        value === null ? `${label} unavailable` : `${display} ${label}`
      }
    >
      {/* `figure` cap on a deliberately compact 22pt counter: this is a
          three-up strip, not a dashboard tile, and the tightest ceiling in
          the scale is what keeps three of them on one row. The label below
          is prose and wraps instead of truncating. */}
      <Text
        {...typeCap("figure")}
        style={{
          color,
          fontSize: 22,
          lineHeight: 26,
          fontWeight: "700",
          fontVariant: ["tabular-nums"],
          fontFamily: FONT.display,
        }}
        numberOfLines={1}
      >
        {display}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </Card>
  );
}

function statusTone(status: string): PillTone {
  const s = status.toLowerCase();
  if (isMobileMigrationDone(s)) return "success";
  if (isMobileMigrationFailure(s)) return "danger";
  if (isMobileMigrationRunning(s)) return "info";
  return "neutral";
}

/**
 * Subscribers imported readout, mirroring the desktop's preference for
 * the verification report's authoritative count, then the live progress
 * counter. Returns "done / total" when a total is known.
 */
function subscribersImported(job: MobileMigrationJob): string | null {
  // `verification_report` is the SDK's `VerificationReport` now, not an
  // untyped bag (GOVERNANCE#57), so the field is read directly. `numberish`
  // still guards it: the report is decoded from the wire, and a gateway that
  // omits the count must render an em-dash rather than 0.
  const reported = numberish(job.verification_report?.subscribers_imported);
  const done = reported ?? numberish(job.progress?.subscribers_done);
  if (done == null) return null;
  const total = numberish(job.progress?.subscribers_total);
  if (total != null && total > 0) {
    return `${num(done)} / ${num(total)}`;
  }
  return num(done);
}

/**
 * Rollback-window hint, mirroring the desktop's 7-day eligibility rule
 * (`canRollback` in apps/desktop/src/pages/Migrations.tsx): only jobs in
 * the `completed` state stay rollback-eligible — until `rollback_until`
 * (or 7 days after `completed_at`). Returns null once the window closes.
 *
 * Deliberately narrower than `isDone`: a `rolled_back` job has already
 * been reverted and a `committed` job is a dry-run commit, so neither is
 * rollback-eligible and showing the pill for them would be misleading.
 */
function rollbackWindow(job: MobileMigrationJob): string | null {
  const status = String(job.status ?? "").toLowerCase();
  if (status !== "completed") return null;
  const until = job.rollback_until
    ? new Date(job.rollback_until).getTime()
    : job.completed_at
      ? new Date(job.completed_at).getTime() + 7 * 24 * 60 * 60 * 1000
      : null;
  if (until == null || !Number.isFinite(until)) return null;
  const diff = until - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `Rollback ${days}d left`;
  const hours = Math.max(1, Math.floor(diff / 3_600_000));
  return `Rollback ${hours}h left`;
}

function numberish(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function titleCase(value: string): string {
  return value
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
