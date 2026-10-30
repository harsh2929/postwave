/**
 * Subscriber imports — where a CSV import job actually IS, and the two verbs a
 * phone genuinely needs on one.
 *
 * A complete import subsystem ships server-side (`internal/subscriber_import`:
 * a preview/mapping wizard, an exhaustive preflight, a chunked background
 * worker, cancellation, six statuses) and had zero mobile presence. So "did the
 * 80k import finish, and is it about to overwrite everyone?" was a laptop
 * question — asked at exactly the moment nobody is at a laptop.
 *
 * WHAT THIS SCREEN DOES, AND WHY THAT AND NOT MORE
 *
 *   READ every job with its live progress, CONFIRM a staged one, and STOP a
 *   running one. Those two verbs are the whole reason it is worth opening on a
 *   phone: confirming is the gate a whole import waits behind, and stopping one
 *   that is chewing through the wrong file is the archetypal away-from-desk
 *   emergency.
 *
 * Deliberately NOT here:
 *   - CSV UPLOAD (`POST /preview`, multipart). Picking a file, reading a 100-row
 *     sample, remapping columns and running the exhaustive preflight is a
 *     desktop job. A half-version of it on a phone would strand rows in
 *     `preview` that the phone then could not confirm. The header says so
 *     rather than shipping a dead affordance.
 *   - PATCH (mapping / on_existing / consent overrides). Same reason: every one
 *     of those edits invalidates the preflight, and only desktop can re-run it.
 *
 * ─── TWO SERVER FACTS THAT SHAPE THIS SCREEN ───
 *
 *  1. THE WHOLE SURFACE IS ADMIN-ONLY, READS INCLUDED, AND THE GENERATED
 *     MANIFEST SAYS OTHERWISE. `subscriber_import.go::MountRoutes` wraps every
 *     route — the GET list too — in `apikeys.RequireScope(apikeys.ScopeAdmin)`.
 *     `ScopeAdmin` is not in `readOnlyScopes`, so the session path requires
 *     owner|admin via `sessionRoleAllowsScopes`. Running that middleware per
 *     role: viewer / member / editor all get `403 insufficient_role` on the
 *     list. `routeauth/manifest.json` records that route as
 *     `session_minimum_role: "viewer"` and is simply wrong; a screen built to
 *     it would render an error for four of five roles. The read is therefore
 *     gated here, and a non-admin gets a sentence instead of a broken list.
 *
 *  2. `/{id}/progress` IS SSE, NOT A POLL. It sets `text/event-stream` and
 *     holds the connection open for up to 30 minutes while the worker runs, so
 *     fetching it against a running job returns no body at all. `GET /{id}`
 *     carries the identical counters plus the preflight state the Confirm gate
 *     needs, so the sheet polls that — and only while the job is `queued` or
 *     `running` AND the tab is focused (`importPollIntervalMs`). An
 *     unconditional interval is a battery bug: Expo Router keeps visited tabs
 *     mounted.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { useConfirm } from "@/components/ConfirmSheet";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { isPausedFirstFetch, QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { SubscriberImportDetailSheet } from "@/components/subscriber-imports/SubscriberImportDetailSheet";
import { SubscriberImportRow } from "@/components/subscriber-imports/SubscriberImportRow";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useCancelSubscriberImport,
  useConfirmSubscriberImport,
  useSubscriberImport,
  useSubscriberImports,
} from "@/hooks/useSubscriberImports";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { EMDASH, num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import {
  filterImportJobs,
  importFilterCounts,
  type ImportFilter,
  type SubscriberImportJob,
  type SubscriberImportJobDetail,
} from "@/lib/subscriberImportJobs";
import {
  cancelImportCopy,
  cancelSuccessMessage,
  confirmImportCopy,
  confirmSuccessMessage,
  subscriberImportAccess,
  subscriberImportErrorMessage,
} from "@/lib/subscriberImportVerbs";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export { AppErrorBoundary as ErrorBoundary };

const UPLOAD_NOTICE =
  "Uploading a CSV, mapping its columns and running the preflight stay on desktop — they need the whole file. Here you can watch every import, confirm a staged one and stop a running one.";

const FILTER_OPTIONS: readonly { value: ImportFilter; label: string }[] = [
  { value: "active", label: "Running" },
  { value: "staged", label: "Staged" },
  { value: "done", label: "Finished" },
];

export default function SubscriberImports() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  const focused = useIsFocused();
  const { toast } = useToast();
  const confirmSheet = useConfirm();
  useScreenViewed("subscriber-imports");

  const mode = useAuthStore((s) => s.mode);
  const isAdmin = canAccessMinimumRole("admin", gate.effectiveRole, mode);
  const queriesEnabled = gate.enabled && Boolean(gate.tenantId);
  const access = subscriberImportAccess({
    isAdmin,
    mode,
    online: online && queriesEnabled,
  });

  const [filter, setFilter] = useState<ImportFilter>("active");
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useSubscriberImports({ canRead: access.canRead, focused });
  // Array.isArray, not `?? []`: the nullish guard passes a truthy `{}` or
  // `{items: []}` straight into `.find` / `filterImportJobs`'s `.filter`. The
  // queryFn normalises a LIVE response, but a payload restored from a cache
  // written by an older build never passes through it (see the schema buster
  // in lib/secureQueryPersister — this exact route already shipped a crash on
  // api-keys). The guard has to be on the shape, not on nullishness.
  const jobs = useMemo(
    () => (Array.isArray(list.data?.jobs) ? list.data.jobs : []),
    [list.data],
  );
  const openJob = useMemo(
    () => jobs.find((job) => job.id === openId) ?? null,
    [jobs, openId],
  );
  const detail = useSubscriberImport(openId, {
    canRead: access.canRead,
    focused,
    knownStatus: openJob?.status ?? null,
  });
  const confirmImport = useConfirmSubscriberImport();
  const cancelImport = useCancelSubscriberImport();
  const refresh = useRefreshControl(list);
  // "started 4m ago" must not freeze at whatever it said on mount.
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * relativeTime ("started 4m ago"); the progress bar reads the JOB, not the
   * clock, so 59 of every 60 ticks used to re-render the whole screen — and
   * every row that takes `now` as a prop — to repaint an identical string.
   * Measured: 60 renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(focused, MINUTE_MS);

  const rows = useMemo(
    () => filterImportJobs(jobs, filter),
    [jobs, filter],
  );
  const counts = useMemo(() => importFilterCounts(jobs), [jobs]);

  // A failed fetch is never an empty list, and a read the gate never let run is
  // not a clean zero either — nor is a first fetch TanStack paused offline.
  // All make the counts unknowable, and an unknown count renders as a dash.
  const listFailed = list.isError && jobs.length === 0;
  const countsUnknown =
    !access.canRead ||
    list.isLoading ||
    listFailed ||
    !queriesEnabled ||
    isPausedFirstFetch(list);

  const runVerb = useCallback(
    async (
      copy: ReturnType<typeof cancelImportCopy>,
      run: () => Promise<void>,
      success: string,
    ) => {
      const ok = await confirmSheet({
        title: copy.title,
        message: copy.message,
        consequence: copy.consequence,
        confirmLabel: copy.confirmLabel,
        destructive: copy.destructive,
      });
      if (!ok) return;
      // Acknowledge the press now; the success thump waits for the server so a
      // failing network never feels like a success followed by an error.
      haptics.impact();
      try {
        await run();
        haptics.success();
        toast({ kind: "success", message: success });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: `${copy.confirmLabel} failed. ${subscriberImportErrorMessage(error)}`,
        });
      }
    },
    [confirmSheet, toast],
  );

  const onConfirm = useCallback(
    (job: SubscriberImportJobDetail) => {
      if (confirmImport.isPending) return;
      void runVerb(
        confirmImportCopy(job, (value) => num(value)),
        () => confirmImport.mutateAsync(job.id),
        confirmSuccessMessage(job),
      );
    },
    [confirmImport, runVerb],
  );

  const onCancel = useCallback(
    (job: SubscriberImportJob) => {
      if (cancelImport.isPending) return;
      void runVerb(
        cancelImportCopy(job, (value) => num(value)),
        () => cancelImport.mutateAsync(job.id),
        cancelSuccessMessage(job),
      );
    },
    [cancelImport, runVerb],
  );

  const openRow = useCallback(
    (job: SubscriberImportJob) => setOpenId(job.id),
    [],
  );
  const closeSheet = useCallback(() => setOpenId(null), []);
  const keyExtractor = useCallback((job: SubscriberImportJob) => job.id, []);

  // A fresh closure per render gives VirtualizedList a new cell identity every
  // time, so every mounted row re-renders on every tick of `now` — on a screen
  // whose whole job is watching a job progress. Memoised on what it actually
  // reads.
  const renderJob = useCallback(
    ({ item }: { item: SubscriberImportJob }) => (
      <SubscriberImportRow
        job={item}
        onPress={openRow}
        busy={
          (confirmImport.isPending && confirmImport.variables === item.id) ||
          (cancelImport.isPending && cancelImport.variables === item.id)
        }
        now={now}
      />
    ),
    [
      cancelImport.isPending,
      cancelImport.variables,
      confirmImport.isPending,
      confirmImport.variables,
      now,
      openRow,
    ],
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Subscriber imports"
        subtitle={
          countsUnknown
            ? `${EMDASH} running`
            : `${num(counts.active)} of ${plural(jobs.length, "import")} running`
        }
        onBack={goBackOrMore}
      />

      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={access.canRead && list.data !== undefined ? rows : []}
        keyExtractor={keyExtractor}
        contentContainerStyle={{
          padding: 16,
          paddingTop: 12,
          paddingBottom: 32,
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={queriesEnabled && access.canRead}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <MobileScopeNotice body={UPLOAD_NOTICE} />
            {access.notice ? (
              <MobileScopeNotice
                title={access.canRead ? "Read-only right now" : "Admins only"}
                body={access.notice}
              />
            ) : null}
            {access.canRead ? (
              <View style={{ marginBottom: 12 }}>
                <SegmentedControl
                  accessibilityLabel="Import status"
                  options={FILTER_OPTIONS.map((option) => ({
                    ...option,
                    ...(countsUnknown
                      ? {}
                      : { badge: counts[option.value] }),
                  }))}
                  value={filter}
                  onChange={setFilter}
                />
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          access.canRead ? (
            <QueryStates
              query={{
                isError: listFailed,
                isLoading: list.isLoading,
                isPending: list.isPending,
                isPaused: list.isPaused,
                error: list.error,
                refetch: list.refetch,
              }}
              gate={{ enabled: queriesEnabled }}
              isEmpty={rows.length === 0}
              skeleton={
                <SkeletonList rows={4} lines={3} label="Loading import jobs" />
              }
              offlineMessage="Connect to your workspace to load import jobs. They aren't cached — a stale answer to 'is it still running' is worse than none."
              empty={{
                title: emptyTitleFor(filter),
                description: emptyBodyFor(filter),
              }}
            >
              {null}
            </QueryStates>
          ) : (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              Import jobs aren&apos;t shown for your access level.
            </Text>
          )
        }
        renderItem={renderJob}
      />

      <SubscriberImportDetailSheet
        job={openJob}
        detail={detail.data ?? null}
        detailLoading={detail.isLoading}
        detailFailed={detail.isError}
        onClose={closeSheet}
        onConfirm={onConfirm}
        onCancel={onCancel}
        busy={confirmImport.isPending || cancelImport.isPending}
        canWrite={access.canWrite}
        accessNotice={access.notice}
        online={online && queriesEnabled}
        now={now}
      />
    </SafeAreaView>
  );
}

function emptyTitleFor(filter: ImportFilter): string {
  if (filter === "active") return "Nothing importing";
  if (filter === "staged") return "Nothing staged";
  return "No finished imports";
}

function emptyBodyFor(filter: ImportFilter): string {
  if (filter === "active") {
    return "No import is queued or running right now. Confirmed imports appear here while the worker writes them.";
  }
  if (filter === "staged") {
    return "A staged import is one that's been uploaded and mapped on desktop but not confirmed. Confirm it here and the worker starts immediately.";
  }
  return "Imports that finished, failed or were stopped land here with their final counts.";
}
