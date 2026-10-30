/**
 * Audit sinks — health AND remediation for outbound audit-log streaming.
 *
 * This screen used to carry a header comment saying mutations "require
 * endpoints the mobile SDK does not expose yet". That was not true: reset,
 * replay and test are all mounted, in the OpenAPI document, and wrapped by
 * the SDK. The consequence of believing the comment was that the one
 * genuinely urgent governance action in the product — closing a tripped
 * breaker so audit events stop dead-lettering — was desktop-only.
 *
 * The writes live here, each behind a ConfirmSheet and each reporting
 * through a toast rather than an OS Alert:
 *   - Reset circuit (only when the breaker is open or probing)
 *   - Send test event
 *   - Replay a dead-lettered batch (only when un-replayed)
 *   - Disable / enable delivery, and DELETE a sink (typed confirm) — the
 *     stopping halves mobile's own policy says to ship: a sink streaming
 *     evidence to a compromised destination must be stoppable from a phone
 *     (hooks/useSinkLifecycle)
 *   - Historical range replays with a cancel (AuditSinkReplaySheet — backfill
 *     an outage window by audit-id range, watch the job, stop a runaway one)
 *
 * What still needs a form of secrets — creating a sink, editing its config,
 * rotating a signing key — deliberately stays on desktop.
 *
 * TWO STRUCTURAL FIXES, both from the governance audit:
 *
 *   - THE SINK LIST IS BOUNDED. It was `sinkRows.map(...)` inside a plain
 *     ScrollView, so every sink a tenant owns mounted a full card whether or
 *     not it was ever scrolled to. It is now a FlatList carrying the app's
 *     shared windowing props; the header (counters, freshness) and the DLQ
 *     preview ride along as the list's header and footer.
 *   - THE DESIGN SYSTEM IS NOT RE-DECLARED HERE. The local `card(t)` and
 *     `sectionLabel(t)` factories — byte-identical to three other enterprise
 *     screens — are gone in favour of the real `Card` and `SectionLabel`
 *     components, and the counters live in components/audit/SinkMetrics.
 */
import { useIsFocused } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, type ListRenderItem, RefreshControl, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { isPausedFirstFetch, QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { AuditSinkReplaySheet } from "@/components/audit/AuditSinkReplaySheet";
import { DlqCard } from "@/components/audit/DlqCard";
import { SinkCard } from "@/components/audit/SinkCard";
import { SinkFreshness, SinkMetricStrip } from "@/components/audit/SinkMetrics";
import { oldestUpdatedAt } from "@/lib/auditGrouping";
import { EMDASH, num } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import { goBackOrMore } from "@/lib/nav";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useTickingNow } from "@/hooks/useTickingNow";
import {
  useMobileAuditSinkDlq,
  useMobileAuditSinks,
} from "@/hooks/useAuditSinkOps";
import {
  useReplayDlqEntry,
  useResetSinkCircuit,
  useTestSink,
} from "@/hooks/useGovernanceOps";
import { useSinkLifecycle } from "@/hooks/useSinkLifecycle";
import { governanceActionErrorMessage } from "@/lib/governanceActionPolicy";
import { useTheme } from "@/lib/theme";
import type {
  MobileAuditSink,
  MobileAuditSinkDlqEntry,
} from "@/api/client";
import { governanceEmptyCopy } from "@/lib/governanceEmptyStates";

export { AppErrorBoundary as ErrorBoundary };

const DLQ_PREVIEW_LIMIT = 10;

type BusyKey = { id: string; action: "reset" | "test" | "replay" } | null;

export default function AuditSinks() {
  const { t } = useTheme();
  useScreenViewed("audit-sinks");
  const { toast } = useToast();
  const confirm = useConfirm();
  const sinks = useMobileAuditSinks();
  const dlq = useMobileAuditSinkDlq();
  const resetCircuit = useResetSinkCircuit();
  const testSink = useTestSink();
  const replayDlq = useReplayDlqEntry();
  const lifecycle = useSinkLifecycle({ confirm, toast });
  const [busy, setBusy] = useState<BusyKey>(null);
  // Cooldown countdowns and "failed 4m ago" ages are read off a clock; a
  // screen left open must not keep claiming the same age.
  // Expo Router keeps unfocused tabs MOUNTED, so an ungated 1 Hz clock
  // re-renders this screen once a second forever in the background.
  const focused = useIsFocused();
  const now = useTickingNow(focused);

  const sinkRows = Array.isArray(sinks.data) ? sinks.data : [];
  const dlqRows = dlq.data?.entries ?? [];
  const dlqCount = dlq.data?.count ?? dlqRows.length;

  const counts = {
    open: sinkRows.filter((sink) => sink.circuit_state !== "closed").length,
    failing: sinkRows.filter((sink) => sink.consecutive_failures > 0).length,
  };

  // Both hooks are gated on `gate.enabled && gate.tenantId`, and in session
  // mode canUseOnlineServices() is true ONLY for "validated_online" — it is
  // false while the session is "offline_cached" or still "checking" on a cold
  // launch. A disabled TanStack query has data:undefined, isLoading:false,
  // isError:false, so without this guard the screen would fabricate a
  // "0 / 0 / 0 · No audit sinks" all-clear on a monitoring surface where
  // nothing was ever fetched. Treat that as unavailable, not as a clean zero —
  // and a first fetch TanStack PAUSED offline with the gate open, the same.
  const gate = useOnlineQueryGate();
  const queriesEnabled = gate.enabled && Boolean(gate.tenantId);

  // A failed fetch must never look like an empty success: prefer showing the
  // error state even if a prior (stale) cache exists, unless data is present.
  const sinksFailed = sinks.isError && sinkRows.length === 0;
  const dlqFailed = dlq.isError && dlqRows.length === 0;
  const sinksUnavailable =
    (!queriesEnabled || isPausedFirstFetch(sinks)) && sinkRows.length === 0;
  const dlqUnavailable =
    (!queriesEnabled || isPausedFirstFetch(dlq)) && dlqRows.length === 0;

  const refresh = useManualRefresh([sinks.refetch, dlq.refetch], {
    enabled: queriesEnabled,
  });

  const shareError = useCallback((message: string) => {
    void Share.share({ message }).catch(() => {
      /* the sheet was dismissed — that is not a failure worth reporting */
    });
  }, []);

  const onReset = useCallback(
    async (sink: MobileAuditSink) => {
      const ok = await confirm({
        title: `Reset the circuit for ${sink.name || "this sink"}?`,
        message:
          "Delivery resumes immediately. If the upstream is still broken the breaker will trip again and the failure count starts over.",
        confirmLabel: "Reset",
        consequence:
          "Queued audit events start flowing to this destination again.",
      });
      if (!ok) return;
      setBusy({ id: sink.id, action: "reset" });
      try {
        await resetCircuit.mutateAsync(sink.id);
        haptics.success();
        toast({ kind: "success", message: "Circuit reset — delivery resumed." });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message: governanceActionErrorMessage("reset_circuit", err),
        });
      } finally {
        setBusy(null);
      }
    },
    [confirm, resetCircuit, toast],
  );

  const onTest = useCallback(
    async (sink: MobileAuditSink) => {
      setBusy({ id: sink.id, action: "test" });
      try {
        await testSink.mutateAsync(sink.id);
        haptics.success();
        toast({
          kind: "success",
          message: `Test event delivered to ${sink.name || "the sink"}.`,
        });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message: governanceActionErrorMessage("test_sink", err),
        });
      } finally {
        setBusy(null);
      }
    },
    [testSink, toast],
  );

  const onReplay = useCallback(
    async (entry: MobileAuditSinkDlqEntry) => {
      const ok = await confirm({
        title: "Replay this batch?",
        message: `Audit rows ${num(entry.from_audit_id)}–${num(
          entry.to_audit_id,
        )} will be re-sent to the sink. Duplicate delivery is possible if the original attempt partially succeeded.`,
        confirmLabel: "Replay",
      });
      if (!ok) return;
      setBusy({ id: String(entry.id), action: "replay" });
      try {
        await replayDlq.mutateAsync(entry.id);
        haptics.success();
        toast({ kind: "success", message: "Batch queued for replay." });
      } catch (err) {
        haptics.error();
        toast({
          kind: "error",
          message: governanceActionErrorMessage("replay_dlq", err),
        });
      } finally {
        setBusy(null);
      }
    },
    [confirm, replayDlq, toast],
  );

  const sinkBusy = useCallback(
    (id: string): "reset" | "test" | "disable" | "delete" | null =>
      (busy && busy.id === id && busy.action !== "replay"
        ? busy.action
        : null) ?? lifecycle.busyFor(id),
    [busy, lifecycle],
  );

  const keyExtractor = useCallback((sink: MobileAuditSink) => sink.id, []);
  const renderSink = useCallback<ListRenderItem<MobileAuditSink>>(
    ({ item }) => (
      <SinkCard
        sink={item}
        now={now}
        busy={sinkBusy(item.id)}
        canAct={queriesEnabled}
        onReset={(row) => void onReset(row)}
        onTest={(row) => void onTest(row)}
        onSetEnabled={(row, enabled) => void lifecycle.onSetEnabled(row, enabled)}
        onDelete={(row) => void lifecycle.onDelete(row)}
        onOpenReplay={lifecycle.openReplay}
        onShareError={shareError}
      />
    ),
    [lifecycle, now, onReset, onTest, queriesEnabled, shareError, sinkBusy],
  );

  const countsUnknown = sinks.isLoading || sinksFailed || sinksUnavailable;
  const dlqUnknown = dlq.isLoading || dlqFailed || dlqUnavailable;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader title="Audit sinks" onBack={goBackOrMore} />
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        data={sinkRows}
        keyExtractor={keyExtractor}
        renderItem={renderSink}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={queriesEnabled}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
        ListHeaderComponent={
          <View>
            <MobileScopeNotice body="Monitor sink health, reset a tripped circuit, send a test event, replay dead-lettered batches or a historical range, disable or delete a sink. Creating a sink and editing its configuration stay on desktop." />
            {/* When a query has failed — or never ran because online services
                are unavailable — the count would be a misleading "0" (looks
                healthy). Show a dash instead so a failed/unfetched query is
                never rendered as a clean zero. */}
            <SinkMetricStrip
              open={countsUnknown ? EMDASH : counts.open}
              failing={countsUnknown ? EMDASH : counts.failing}
              dlq={dlqUnknown ? EMDASH : dlqCount}
            />
            {/* A compliance screen resumed from background after two hours
                looks identical to one fetched a second ago. The age shown is
                the OLDER of the two queries — see `oldestUpdatedAt`. */}
            <SinkFreshness
              updatedAt={oldestUpdatedAt([
                sinks.dataUpdatedAt,
                dlq.dataUpdatedAt,
              ])}
              now={now}
            />
            <SectionLabel topMargin={0}>
              {`Sinks${countsUnknown ? "" : ` (${num(sinkRows.length)})`}`}
            </SectionLabel>
          </View>
        }
        ListEmptyComponent={
          /* One ladder, shared with every other screen: error before empty,
             "the gate never let this run" as its own message rather than a
             fake all-clear, and a skeleton only on a FIRST load. */
          <QueryStates
            query={{
              isError: sinksFailed,
              isLoading: sinks.isLoading,
              isPending: sinks.isPending,
              isPaused: sinks.isPaused,
              error: sinks.error,
              refetch: sinks.refetch,
            }}
            gate={{ enabled: queriesEnabled }}
            isEmpty
            skeleton={
              <SkeletonList rows={2} lines={3} label="Loading audit sinks" />
            }
            offlineMessage="Connect to your workspace to load live sink health. Resetting a circuit is never queued for later — it has to reach the server now."
            // Shared governance copy (GOVERNANCE#30) — one voice across the
            // governance surfaces, and a first sentence that says what a sink
            // actually does rather than only that there are none.
            empty={governanceEmptyCopy("auditSinks")}
          >
            {null}
          </QueryStates>
        }
        ListFooterComponent={
          <DlqSection
            entries={dlqRows}
            count={dlqCount}
            unknown={dlqUnknown}
            failed={dlqFailed}
            loading={dlq.isLoading}
            pending={dlq.isPending}
            paused={dlq.isPaused}
            error={dlq.error}
            refetch={dlq.refetch}
            enabled={queriesEnabled}
            now={now}
            busy={busy}
            onReplay={(row) => void onReplay(row)}
            onShareError={shareError}
          />
        }
      />
      <AuditSinkReplaySheet
        sink={lifecycle.replaySink}
        onClose={lifecycle.closeReplay}
      />
    </SafeAreaView>
  );
}

/**
 * The dead-letter preview. Already capped at DLQ_PREVIEW_LIMIT, and the cap is
 * DISCLOSED rather than silently applied — a truncated queue that looks
 * complete is how an operator concludes the backlog is cleared.
 */
function DlqSection({
  entries,
  count,
  unknown,
  failed,
  loading,
  pending,
  paused,
  error,
  refetch,
  enabled,
  now,
  busy,
  onReplay,
  onShareError,
}: {
  entries: readonly MobileAuditSinkDlqEntry[];
  count: number;
  unknown: boolean;
  failed: boolean;
  loading: boolean;
  /** The DLQ query's isPending/isPaused: a paused first fetch is offline. */
  pending: boolean;
  paused: boolean;
  error: unknown;
  refetch: () => unknown;
  enabled: boolean;
  now: number;
  busy: BusyKey;
  onReplay: (entry: MobileAuditSinkDlqEntry) => void;
  onShareError: (message: string) => void;
}) {
  return (
    <View>
      <SectionLabel
        {...(!unknown && count > DLQ_PREVIEW_LIMIT
          ? {
              subtitle: `Showing the ${DLQ_PREVIEW_LIMIT} most recent of ${num(
                count,
              )}. Use the web admin's bulk replay for the rest.`,
            }
          : {})}
      >
        {`Dead letter queue${!unknown && count > 0 ? ` (${num(count)})` : ""}`}
      </SectionLabel>
      <QueryStates
        query={{
          isError: failed,
          isLoading: loading,
          isPending: pending,
          isPaused: paused,
          error,
          refetch,
        }}
        gate={{ enabled }}
        isEmpty={entries.length === 0}
        skeleton={
          <SkeletonList rows={2} lines={3} label="Loading the dead letter queue" />
        }
        offlineMessage="Connect to your workspace to load the dead letter queue."
        empty={{
          title: "DLQ is clear",
          description: "Failed audit batches will appear here for replay.",
        }}
      >
        {entries.slice(0, DLQ_PREVIEW_LIMIT).map((entry) => (
          <DlqCard
            key={entry.id}
            entry={entry}
            now={now}
            busy={busy?.action === "replay" && busy.id === String(entry.id)}
            canAct={enabled}
            onReplay={onReplay}
            onShareError={onShareError}
          />
        ))}
      </QueryStates>
    </View>
  );
}
