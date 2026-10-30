/**
 * WarehouseRunsScreen — "did last night's warehouse sync land, and if not,
 * what broke".
 *
 * WHY THIS IS THE ONLY WAREHOUSE SURFACE ON A PHONE. The desktop's
 * `DataPlatform.tsx` covers connections, a pre-save validator, import
 * mappings, custom object types and a CDP transform playground. Every one of
 * those is schema authoring — long strings, column pickers, JSON — and a phone
 * is the wrong device for all of it. The exception is sync-run health: a
 * nightly export that dies at 03:00 is an operations incident whose whole cost
 * is the hours between the failure and somebody noticing, and noticing is
 * exactly what a phone is for. Authoring stays on the desktop, deliberately.
 *
 * THE ROLE GATE IS REAL AND IT IS NOT WHAT THE PER-ROUTE SCOPE SAYS. Every
 * `/api/v1/warehouse/*` route — including the four reads this screen makes —
 * is `session_minimum_role: admin` in the generated policy manifest that
 * `routeauth.Middleware` enforces on the whole authenticated group, even
 * though the per-route middleware is `RequireScope(ScopeReadReports)` and
 * would admit any role on its own. Both guards run; the stricter one decides.
 * The screen therefore checks the role BEFORE issuing anything, because a
 * request that can only answer 403 is not worth a cellular round trip — and it
 * still treats a live 403 as its own state, because a role can change while
 * the app is open.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { QueryStates } from "@/components/QueryStates";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { ConnectionHealthCard } from "@/components/warehouse/ConnectionHealthCard";
import { RunDetailCard } from "@/components/warehouse/RunDetailCard";
import { RunErrorsSection } from "@/components/warehouse/RunErrorsSection";
import { RunRow } from "@/components/warehouse/RunRow";
import { SyncVerdictCard } from "@/components/warehouse/SyncVerdictCard";
import { isWarehouseRoleDenied, WAREHOUSE_RUNS_PAGE_SIZE } from "@/api/warehouseRuns";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  useWarehouseConnectionHealth,
  useWarehouseConnections,
  useWarehouseRunErrors,
  useWarehouseRuns,
} from "@/hooks/useWarehouseRuns";
import { num, plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { runEvidence } from "@/lib/warehouseRunErrors";
import {
  filterWarehouseRuns,
  runConnectionLabel,
  warehouseRunFilterCounts,
  type WarehouseRunFilter,
} from "@/lib/warehouseRuns";
import { warehouseSyncVerdict } from "@/lib/warehouseVerdict";
import { useAuthStore } from "@/store/auth";

export function WarehouseRunsScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Read off the store rather than off the gate: the store is where the role
  // and the auth MODE both live, and an api_key session must be denied here
  // (routeauth wants the `admin` SCOPE, which mobile never receives).
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("warehouse-runs");

  const allowed = canAccessMinimumRole("admin", role, mode);
  const runs = useWarehouseRuns(allowed);
  const connections = useWarehouseConnections(allowed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<WarehouseRunFilter>("all");

  const rows = useMemo(
    () => (Array.isArray(runs.data) ? runs.data : []),
    [runs.data],
  );
  const connectionRows = useMemo(
    () => (Array.isArray(connections.data) ? connections.data : []),
    [connections.data],
  );
  const counts = useMemo(() => warehouseRunFilterCounts(rows), [rows]);
  const filtered = useMemo(
    () => filterWarehouseRuns(rows, filter),
    [rows, filter],
  );

  // A selection the reader made survives a refetch as long as the run is still
  // in the window; otherwise the newest run in the CURRENT filter is shown, so
  // the detail below is never blank while a list is on screen.
  const activeId =
    selectedId && filtered.some((run) => run.id === selectedId)
      ? selectedId
      : (filtered[0]?.id ?? null);
  const activeRun = rows.find((run) => run.id === activeId) ?? null;

  const errors = useWarehouseRunErrors(activeId, allowed);
  const health = useWarehouseConnectionHealth(
    activeRun?.connectionId ? activeRun.connectionId : null,
    allowed,
  );

  // All four, so one pull refreshes everything on screen. `useManualRefresh`
  // rather than `isFetching`: a foreground resume refetches on its own and a
  // spinner nobody asked for reads as a malfunction.
  const refresh = useManualRefresh(
    [runs.refetch, connections.refetch, errors.refetch, health.refetch],
    { enabled: gate.enabled && allowed },
  );

  const onSelect = useCallback((id: string) => setSelectedId(id), []);

  const verdict = useMemo(
    () =>
      warehouseSyncVerdict(rows, connectionRows, WAREHOUSE_RUNS_PAGE_SIZE),
    [rows, connectionRows],
  );

  const roleDenied = isWarehouseRoleDenied(runs.error);
  const activeName = activeRun
    ? runConnectionLabel(activeRun, connectionRows)
    : "";
  const evidence = activeRun
    ? runEvidence(
        activeRun,
        Array.isArray(errors.data) ? errors.data.length : null,
      )
    : null;

  const subtitle =
    runs.data !== undefined && rows.length > 0
      ? `${plural(rows.length, "run")} · ${num(counts.failed)} not landed`
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Warehouse syncs"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled && allowed}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {!allowed || roleDenied ? (
          <RoleNotice live={roleDenied} />
        ) : (
          <>
            {/* The verdict is computed from BOTH reads, so it is only
                truthful once the connection roster has actually arrived. With
                an errored or unloaded roster `expected` is 0 and the card
                would announce "no connection is on a schedule" — a statement
                about the workspace derived from a failed request. */}
            {rows.length > 0 && connections.data !== undefined ? (
              <SyncVerdictCard verdict={verdict} />
            ) : null}

            <SegmentedControl<WarehouseRunFilter>
              options={[
                {
                  value: "all",
                  label: "All",
                  badge: counts.all,
                  accessibilityLabel: `All runs, ${plural(counts.all, "run")}`,
                },
                {
                  value: "failed",
                  label: "Not landed",
                  badge: counts.failed,
                  accessibilityLabel: `Runs that did not land, ${plural(counts.failed, "run")}`,
                },
                {
                  value: "running",
                  label: "In flight",
                  badge: counts.running,
                  accessibilityLabel: `Runs still in flight, ${plural(counts.running, "run")}`,
                },
              ]}
              value={filter}
              onChange={setFilter}
              accessibilityLabel="Run filter"
            />

            <SectionLabel
              subtitle={`The newest ${WAREHOUSE_RUNS_PAGE_SIZE} runs across every connection — not every run ever.`}
            >
              Runs
            </SectionLabel>
            <QueryStates
              query={runs}
              gate={gate}
              isEmpty={filtered.length === 0}
              offlineMessage="Sync history needs a connection. Reconnect and pull to refresh — this is not the same as nothing having run."
              skeleton={
                <SkeletonList rows={4} lines={3} label="Loading warehouse runs" />
              }
              empty={
                rows.length === 0
                  ? {
                      title: "No warehouse runs yet",
                      description:
                        "Nothing has exported or imported for this workspace. Connections and their schedules are configured on the web admin.",
                    }
                  : {
                      title: emptyFilterTitle(filter),
                      description: `Nothing matches this filter in the newest ${WAREHOUSE_RUNS_PAGE_SIZE} runs. That is a statement about this window, not about every run ever.`,
                    }
              }
            >
              {filtered.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  connectionName={runConnectionLabel(run, connectionRows)}
                  selected={run.id === activeId}
                  onSelect={onSelect}
                />
              ))}
            </QueryStates>

            {activeRun && evidence ? (
              <View style={{ marginTop: 16 }}>
                <SectionLabel topMargin={0}>{activeName}</SectionLabel>
                <RunDetailCard
                  run={activeRun}
                  connectionName={activeName}
                  evidence={evidence}
                />
                {/* Siblings, never nested: the row-error ledger and the
                    connection's health are two independent reads, and nesting
                    them would let one failing query hide the other. */}
                <RunErrorsSection
                  query={errors}
                  gate={gate}
                  evidence={evidence}
                />
                {activeRun.connectionId ? (
                  <ConnectionHealthCard
                    query={health}
                    gate={gate}
                    connectionName={activeName}
                  />
                ) : (
                  <OrphanNotice />
                )}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function emptyFilterTitle(filter: WarehouseRunFilter): string {
  if (filter === "failed") return "Every run in this window landed";
  if (filter === "running") return "Nothing is running right now";
  return "No runs in this window";
}

/**
 * The role branch.
 *
 * Two ways in, one message: either the client already knows the session is not
 * owner/admin, or the server said so with a 403. It never renders "no runs",
 * which would be a claim about the WORKSPACE when the true statement is about
 * the SESSION.
 */
function RoleNotice({ live }: { live: boolean }) {
  const { t } = useTheme();
  const body =
    "Every warehouse route — including read-only sync history — requires an owner or admin session on this server. Ask an owner to check the pipeline, or open Data Platform on the web admin.";
  return (
    <View
      accessible
      accessibilityLabel={`Warehouse syncs need an owner or admin session. ${body}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 16,
        gap: 8,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        Needs an owner or admin session
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {body}
      </Text>
      {live ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          The server refused this read just now, so the role may have changed
          since you signed in.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * `warehouse_sync_runs.connection_id` is `ON DELETE SET NULL`, so a run can
 * outlive its connection. There is nothing to health-check and no id to pause
 * — saying that is better than rendering a health card that can only 404.
 */
function OrphanNotice() {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 16 }}>
      <SectionLabel topMargin={0}>Connection health</SectionLabel>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        This run&apos;s connection has been deleted, so there is no health to
        read and nothing left to pause. The run itself is kept as a record.
      </Text>
    </View>
  );
}
