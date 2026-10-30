/**
 * McpActivityScreen — advisory observations retained by the API-key recorder.
 *
 * WHY THIS IS THE ONLY MCP SURFACE ON A PHONE. The desktop's `MCP.tsx` has
 * three tabs. SETUP mints scoped API keys and renders the client config block —
 * it must never port, because a phone is the wrong place to display a plaintext
 * credential and the output's only destination is a config file on a developer
 * machine. TOOLS is a static bundled catalogue, a document. HISTORY is a
 * dashboard. This phone view can surface retained failures for investigation,
 * but recorder loss and caller-controlled attribution prevent completeness or
 * origin claims.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT OFFER: minting a key, editing a
 * per-tool quota, or exporting the CSV. The first is credential authoring. The
 * second is a spend control whose blast radius is every agent in the workspace
 * — setting one wrong stops production traffic, and that decision wants the
 * configuration in front of you. The third is a file download with nowhere to
 * go on a phone.
 *
 * THE ROLE GATE IS REAL AND IT IS NOT READ OFF THE GENERATED MANIFEST. Every
 * /api/v1/mcp/* route is mounted behind `apikeys.RequireScope(ScopeAdmin)`
 * (apps/api/internal/server/identity_api.go:111-120), which on the session path
 * admits owner and admin only. The routeauth manifest agrees today
 * (`session_minimum_role: admin`, `review_status: reviewed`, re-read
 * 2026-09-03) but is generated, and for these same reads it once said `viewer`
 * under a `safe-default:read` guess. So the screen gates on the handler's rule
 * — admin BEFORE issuing a request — and still treats a live 403 as its own
 * state, because a role can change while the app is open.
 *
 * INVESTIGATION STAYS BOUNDED. The log opens on the newest page; a tool chip
 * narrows it on the SERVER (`?tool=`), and "Load older" walks the before-id
 * cursor one tap at a time (hooks/useMcpExecutionLog) — never on mount, never
 * on focus, capped, and reset whenever the first page changes. Every rule is
 * in lib/mcpExecutionLog; the footer says which state the traversal is in.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isMcpRoleDenied, MCP_EXECUTIONS_PAGE_SIZE } from "@/api/mcpActivity";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { QueryStates, type QueryEmptyState } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SkeletonList } from "@/components/Skeleton";
import { McpExecutionDetailSheet } from "@/components/mcp/McpExecutionDetailSheet";
import {
  McpLoadOlderFooter,
  McpToolFilterChips,
} from "@/components/mcp/McpExecutionLogControls";
import { McpExecutionRow } from "@/components/mcp/McpExecutionRow";
import { McpQuotasCard } from "@/components/mcp/McpQuotasCard";
import { McpToolBreakdown } from "@/components/mcp/McpToolBreakdown";
import { McpToolCatalogueSection } from "@/components/mcp/McpToolCatalogueSection";
import { McpTrendCard } from "@/components/mcp/McpTrendCard";
import { McpVerdictCard } from "@/components/mcp/McpVerdictCard";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import {
  useMcpExecutions,
  useMcpStats,
  useMcpTrend,
} from "@/hooks/useMcpActivity";
import { useMcpOlderExecutions } from "@/hooks/useMcpExecutionLog";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { plural } from "@/lib/format";
import {
  filterMcpExecutions,
  mcpActivityVerdict,
  mcpExecutionCounts,
  mcpWindowLabel,
  type McpExecution,
  type McpExecutionFilter,
  type McpWindow,
} from "@/lib/mcpActivity";
import { mcpToolChipNames } from "@/lib/mcpExecutionLog";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { useAuthStore } from "@/store/auth";

/**
 * `include=all` widens past the MCP User-Agent filter. It is a two-option
 * control rather than a switch because the two options are two different
 * SUBJECTS — "MCP-labelled rows" and "all recorder rows" — and a switch labelled
 * "include all" reads as a display preference rather than a change of what the
 * numbers are about.
 */
type McpScope = "mcp" | "all";

export function McpActivityScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Read off the store rather than off the gate: the store is where the role
  // and the auth MODE both live, and an api_key session must be denied here
  // (these routes want the `admin` SCOPE, which mobile never receives).
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("agent-activity");

  const allowed = canAccessMinimumRole("admin", role, mode);
  const [window, setWindow] = useState<McpWindow>("24h");
  const [scope, setScope] = useState<McpScope>("mcp");
  const [filter, setFilter] = useState<McpExecutionFilter>("all");
  // Exact tool identifier sent to the server as `?tool=`; "" for every tool.
  const [tool, setTool] = useState("");
  // Every tool identifier seen in this session's loaded rows, so a chosen
  // chip does not hide the way back (lib/mcpExecutionLog.mcpToolChipNames).
  const [seenTools, setSeenTools] = useState<readonly string[]>([]);
  // The row whose detail sheet is open; one sheet for the whole log.
  const [selected, setSelected] = useState<McpExecution | null>(null);
  const includeAll = scope === "all";

  const stats = useMcpStats(window, includeAll, allowed);
  const trend = useMcpTrend(window, includeAll, allowed);
  const executions = useMcpExecutions(includeAll, allowed, tool);

  // The newest page, from the cached query; the older pages the operator
  // asked for by tapping "Load older" sit below it and reset when it changes.
  const rows = useMemo(
    () => (Array.isArray(executions.data) ? executions.data : []),
    [executions.data],
  );
  const older = useMcpOlderExecutions(includeAll, allowed, tool, rows);
  const loaded = useMemo(
    () => [...rows, ...(Array.isArray(older.data) ? older.data : [])],
    [rows, older.data],
  );
  const counts = useMemo(() => mcpExecutionCounts(loaded), [loaded]);
  const filtered = useMemo(
    () => filterMcpExecutions(loaded, filter),
    [loaded, filter],
  );
  const toolChips = useMemo(
    () => mcpToolChipNames(seenTools, loaded, tool),
    [seenTools, loaded, tool],
  );
  useEffect(() => {
    // The union only ever grows, so a length change is the whole test.
    if (toolChips.length !== seenTools.length) setSeenTools(toolChips);
  }, [toolChips, seenTools]);

  const refresh = useManualRefresh(
    [stats.refetch, trend.refetch, executions.refetch],
    { enabled: gate.enabled && allowed },
  );

  const onWindow = useCallback((next: McpWindow) => setWindow(next), []);
  const onScope = useCallback((next: McpScope) => setScope(next), []);
  const onTool = useCallback((next: string) => setTool(next), []);
  const clearTool = useCallback(() => setTool(""), []);

  const verdict = useMemo(
    () => mcpActivityVerdict(stats.data ?? null, window, includeAll),
    [stats.data, window, includeAll],
  );
  const roleDenied =
    isMcpRoleDenied(stats.error) || isMcpRoleDenied(executions.error);

  const subtitle = stats.data?.hasCalls
    ? `${plural(stats.data.totalCalls, "retained row")} · ${plural(stats.data.failedCalls, "recorded failure")}`
    : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Agent activity"
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
          <RoleGateNotice
            title="Needs an owner or admin session"
            body="Every MCP route — including read-only execution history — is mounted behind the admin scope on this server, because per-key call cadence is operator-grade information. Ask an owner, or open the MCP page on the web admin."
            live={roleDenied}
          />
        ) : (
          <>
            <MobileScopeNotice
              title="Monitor only"
              body="Advisory observations only: recording is best-effort and droppable, MCP attribution uses a caller-controlled User-Agent, and cost is a non-billing estimate. Missing rows do not prove no calls occurred. Minting a scoped key and changing quotas remain in the web admin."
            />

            <SegmentedControl<McpWindow>
              options={[
                {
                  value: "24h",
                  label: "24h",
                  accessibilityLabel: "Last 24 hours",
                },
                { value: "7d", label: "7d", accessibilityLabel: "Last 7 days" },
                {
                  value: "30d",
                  label: "30d",
                  accessibilityLabel: "Last 30 days",
                },
              ]}
              value={window}
              onChange={onWindow}
              accessibilityLabel="Window"
            />
            <View style={{ height: 8 }} />
            <SegmentedControl<McpScope>
              options={[
                {
                  value: "mcp",
                  label: "MCP-labelled",
                  accessibilityLabel:
                    "Recorder rows with a caller-asserted MCP User-Agent; origin is not verified",
                },
                {
                  value: "all",
                  label: "All recorded",
                  accessibilityLabel:
                    "All retained API-key recorder rows; the recorder can drop rows",
                },
              ]}
              value={scope}
              onChange={onScope}
              accessibilityLabel="Which calls to count"
            />

            <View style={{ height: 12 }} />
            <QueryStates
              query={stats}
              gate={gate}
              isEmpty={stats.data === undefined}
              offlineMessage="Agent activity needs a connection. Reconnect and pull to refresh — this is not the same as nothing having run."
              skeleton={
                <SkeletonList
                  rows={2}
                  lines={4}
                  label="Loading agent activity"
                />
              }
              empty={{
                title: "No reading yet",
                description: `Nothing came back for the last ${mcpWindowLabel(window)}.`,
              }}
            >
              <McpVerdictCard verdict={verdict} stats={stats.data ?? null} />
              {stats.data ? <McpToolBreakdown stats={stats.data} /> : null}
            </QueryStates>

            {trend.data && !trend.isError ? (
              <McpTrendCard trend={trend.data} window={window} />
            ) : null}

            <McpQuotasCard allowed={allowed} gate={gate} />

            <SectionLabel
              subtitle={`Newest first, ${MCP_EXECUTIONS_PAGE_SIZE} recorder rows a page. The endpoint has no window parameter and this is not a complete traffic ledger.`}
            >
              Recent calls
            </SectionLabel>
            <SegmentedControl<McpExecutionFilter>
              options={[
                {
                  value: "all",
                  label: "All",
                  badge: counts.all,
                  accessibilityLabel: `All calls, ${plural(counts.all, "call")}`,
                },
                {
                  value: "failed",
                  label: "Failed",
                  badge: counts.failed,
                  accessibilityLabel: `Calls that failed, ${plural(counts.failed, "call")}`,
                },
              ]}
              value={filter}
              onChange={setFilter}
              accessibilityLabel="Call filter"
            />
            <McpToolFilterChips
              tools={toolChips}
              active={tool}
              loaded={loaded.length}
              onChange={onTool}
            />
            <View style={{ height: 8 }} />
            <QueryStates
              query={executions}
              gate={gate}
              isEmpty={filtered.length === 0}
              offlineMessage="The call log needs a connection. Reconnect and pull to refresh."
              skeleton={
                <SkeletonList rows={4} lines={3} label="Loading recent calls" />
              }
              empty={emptyLogCopy(loaded.length, tool, includeAll, clearTool)}
            >
              {filtered.map((call) => (
                <McpExecutionRow key={call.id} call={call} onPress={setSelected} />
              ))}
            </QueryStates>
            {executions.isError ? null : (
              <McpLoadOlderFooter
                online={gate.enabled}
                loaded={loaded.length}
                hasNextPage={older.hasNextPage}
                nextBeforeId={older.nextBeforeId}
                isFetchingNextPage={older.isFetchingNextPage}
                error={older.error}
                retentionCapped={older.retentionCapped}
                onLoadMore={older.fetchNextPage}
              />
            )}

            <McpToolCatalogueSection allowed={allowed} gate={gate} />
          </>
        )}
      </ScrollView>
      <McpExecutionDetailSheet
        call={selected}
        allowed={allowed}
        gate={gate}
        onClose={() => setSelected(null)}
      />
    </SafeAreaView>
  );
}

/**
 * What an empty log SAYS depends on why it is empty. Under a tool filter the
 * server returned nothing for that identifier (and the way out is offered);
 * with no rows at all the sentence names the scope it is a claim about; with
 * rows but no failures it is a statement about the loaded rows only.
 */
function emptyLogCopy(
  loaded: number,
  tool: string,
  includeAll: boolean,
  clearTool: () => void,
): QueryEmptyState {
  if (loaded === 0 && tool !== "") {
    return {
      title: `No loaded rows for ${tool}`,
      description:
        "The server returned no retained row under this tool identifier. Best-effort recording means this is not proof the tool was never called.",
      cta: { label: "Clear tool filter", onPress: clearTool },
    };
  }
  if (loaded === 0) {
    return {
      title: includeAll
        ? "No API-key recorder rows loaded"
        : "No MCP-labelled recorder rows loaded",
      description: includeAll
        ? "No retained row is visible on this page. The best-effort recorder can drop rows, so this is not proof of zero API-key traffic."
        : "No retained row on this page carries the caller-asserted MCP User-Agent. The label is forgeable and absence is not proof of zero MCP traffic.",
    };
  }
  return {
    title: "Nothing failed in this page",
    description: `No failure appears among the ${plural(loaded, "loaded row")}. Best-effort recording means this is not proof that every call succeeded.`,
  };
}
