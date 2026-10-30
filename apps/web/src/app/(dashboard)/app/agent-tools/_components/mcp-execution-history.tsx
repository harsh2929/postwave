// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Recorded MCP execution history — window, source, exact-tool filter, summary
 * stats, hourly trend, top tools, a paged table, and an optional live tail.
 *
 * THE EVIDENCE CLASS LEADS, and that is the whole design.
 * `GET /api/v1/mcp/executions` returns `evidenceClass:
 * "best_effort_observability"`: the recorder is asynchronous and may omit
 * calls, and the "MCP" source is a caller-controlled user-agent prefix, not a
 * verified origin. An operator who reads this table as "everything the agent
 * did" would act on a claim the server never made — so the scope sentence sits
 * above the rows, not in a tooltip.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *  - No CSV export. `/api/v1/mcp/executions.csv` answers 503
 *    `mcp_execution_export_release_held`, so the control would always fail.
 *  - No replay. See the detail dialog.
 *  - Summary cards do NOT move when a live row arrives: stats and trend are
 *    server aggregates over the window, and incrementing them client-side
 *    would invent a number the server never computed. The table says so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, History, Radio, RefreshCw } from "lucide-react";

import { Sparkline } from "@/components/dashboard/sparkline";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  subscribeMcpExecutions,
  type StreamStatus,
} from "@/lib/live-streams-api";
import {
  formatMcpLatency,
  formatMcpMicrosUsd,
  formatMcpTimestamp,
  getMcpStats,
  getMcpTrend,
  isCanonicalMcpToolToken,
  listMcpExecutions,
  MAX_RETAINED_MCP_EXECUTIONS,
  MCP_WINDOW_LABELS,
  mcpStatusClassLabel,
  mcpStatusTone,
  mergeMcpExecutions,
  projectSafeMcpExecution,
  type McpExecution,
  type McpExecutionPage,
  type McpHistorySource,
  type McpHistoryWindow,
} from "@/lib/mcp-api";
import { base, STALE } from "@/lib/query-keys";
import { McpExecutionDetailDialog } from "./mcp-execution-detail-dialog";

const WINDOWS: readonly McpHistoryWindow[] = ["24h", "7d", "30d"];

/**
 * The three history reads are gated by `RequireExactTenantAdmin`
 * (internal/server/identity_api.go). Requesting them as a member or in viewer
 * mode buys nothing but a 403, so the reason is rendered instead.
 */
export function canReadMcpHistory(identity: MeResponse | undefined): boolean {
  if (!identity) return false;
  if (identity.viewer_mode === true) return false;
  const role = effectiveAuthRole(identity);
  return role === "owner" || role === "admin";
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function McpExecutionHistory({
  identity,
  onRefreshQuotas,
}: {
  identity: MeResponse | undefined;
  /** Desktop's Refresh reloads quotas alongside the history. So does this. */
  onRefreshQuotas: () => void;
}) {
  const [historyWindow, setHistoryWindow] = useState<McpHistoryWindow>("24h");
  const [include, setInclude] = useState<McpHistorySource>("mcp");
  const [toolInput, setToolInput] = useState("");
  const [live, setLive] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("closed");
  const [liveRows, setLiveRows] = useState<McpExecution[]>([]);
  const [olderPages, setOlderPages] = useState<McpExecutionPage[]>([]);
  const [selected, setSelected] = useState<McpExecution | null>(null);

  const allowed = canReadMcpHistory(identity);
  const trimmedTool = toolInput.trim();
  const toolIsCanonical =
    trimmedTool === "" || isCanonicalMcpToolToken(trimmedTool);
  // A non-canonical token is a guaranteed 400, so it is never sent.
  const appliedTool = toolIsCanonical ? trimmedTool : "";
  const scopeKey = `${historyWindow}|${include}|${appliedTool}`;

  const keyBase = useMemo(
    () =>
      base(
        "mcp-history",
        identity?.tenant_id ?? "anon",
        identity?.role ?? null,
      ),
    [identity?.role, identity?.tenant_id],
  );

  const stats = useQuery({
    queryKey: [...keyBase, "stats", historyWindow, include],
    queryFn: ({ signal }) =>
      getMcpStats({ window: historyWindow, include }, signal),
    enabled: allowed,
    staleTime: STALE.detail,
  });
  const trend = useQuery({
    queryKey: [...keyBase, "trend", historyWindow, include],
    queryFn: ({ signal }) =>
      getMcpTrend({ window: historyWindow, include }, signal),
    enabled: allowed,
    staleTime: STALE.detail,
  });
  const firstPage = useQuery({
    queryKey: [...keyBase, "executions", historyWindow, include, appliedTool],
    queryFn: ({ signal }) =>
      listMcpExecutions(
        { window: historyWindow, include, tool: appliedTool || undefined },
        signal,
      ),
    enabled: allowed,
    staleTime: STALE.detail,
  });

  // Changing the scope invalidates every accumulated row: an older page and a
  // live row were both admitted under the PREVIOUS filter, and leaving them on
  // screen would show rows the current filter excludes.
  const lastScopeRef = useRef(scopeKey);
  useEffect(() => {
    if (lastScopeRef.current === scopeKey) return;
    lastScopeRef.current = scopeKey;
    setOlderPages([]);
    setLiveRows([]);
  }, [scopeKey]);

  const rows = useMemo(
    () =>
      mergeMcpExecutions(liveRows, [
        ...(Array.isArray(firstPage.data?.rows) ? firstPage.data.rows : []),
        ...olderPages.flatMap((page) => page.rows),
      ]),
    [firstPage.data?.rows, liveRows, olderPages],
  );

  const cursor =
    olderPages.length > 0
      ? olderPages[olderPages.length - 1].nextBeforeId
      : firstPage.data?.nextBeforeId;
  const retentionCapped = rows.length >= MAX_RETAINED_MCP_EXECUTIONS;

  const loadOlder = useMutation({
    mutationFn: () =>
      listMcpExecutions({
        window: historyWindow,
        include,
        tool: appliedTool || undefined,
        beforeId: cursor,
      }),
    onSuccess: (page) => setOlderPages((pages) => [...pages, page]),
  });

  const refresh = useCallback(() => {
    setOlderPages([]);
    setLiveRows([]);
    loadOlder.reset();
    onRefreshQuotas();
    void stats.refetch();
    void trend.refetch();
    void firstPage.refetch();
  }, [firstPage, loadOlder, onRefreshQuotas, stats, trend]);

  useEffect(() => {
    if (!allowed || !live) {
      setStreamStatus("closed");
      return;
    }
    return subscribeMcpExecutions(
      {
        onStatus: setStreamStatus,
        onEvent: (data) => {
          const row = projectSafeMcpExecution(data);
          if (!row) return;
          // The server already filters by tool, but a reconnect can deliver a
          // frame opened under the previous filter.
          if (appliedTool && row.toolName !== appliedTool) return;
          setLiveRows((previous) => mergeMcpExecutions([row], previous));
        },
      },
      { include, tool: appliedTool || undefined },
    );
    // reconnectNonce is a deliberate dependency: bumping it tears the old
    // EventSource down and opens a new one.
  }, [allowed, live, include, appliedTool, reconnectNonce]);

  if (!allowed) {
    return (
      <GovernanceSection
        icon={History}
        title="Execution history"
        description="Recorded API-key telemetry for agent calls."
      >
        <GovernanceEmpty>
          Execution telemetry is restricted to an effective owner or admin role
          in this workspace, so nothing was requested. Your effective role is{" "}
          {identity ? effectiveAuthRole(identity) : "not resolved"}
          {identity?.viewer_mode === true ? " (viewer mode is on)" : ""}.
        </GovernanceEmpty>
      </GovernanceSection>
    );
  }

  const failure = stats.error ?? trend.error ?? firstPage.error;
  const loading = stats.isPending || trend.isPending || firstPage.isPending;
  const refreshing =
    stats.isFetching || trend.isFetching || firstPage.isFetching;
  const summary = stats.data;
  const points = Array.isArray(trend.data) ? trend.data : [];
  const peak = points.reduce((max, point) => Math.max(max, point.calls), 0);

  return (
    <GovernanceSection
      icon={History}
      title="Execution history"
      description="Recorded API-key telemetry. Best-effort observability: the recorder is asynchronous, may omit calls, and “MCP” is a self-declared user agent — not a verified origin."
    >
      <fieldset className="min-w-0 rounded-xl border bg-muted/20 p-3.5">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Filters and actions
        </legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <Label htmlFor="mcp-history-window">Window</Label>
            <Select
              id="mcp-history-window"
              className="mt-1"
              value={historyWindow}
              onChange={(event) =>
                setHistoryWindow(event.target.value as McpHistoryWindow)
              }
            >
              {WINDOWS.map((option) => (
                <option key={option} value={option}>
                  {MCP_WINDOW_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-0">
            <Label htmlFor="mcp-history-source">Source</Label>
            <Select
              id="mcp-history-source"
              className="mt-1"
              value={include}
              onChange={(event) =>
                setInclude(event.target.value as McpHistorySource)
              }
            >
              <option value="mcp">Self-identified npm proxy</option>
              <option value="all">All recorded API-key telemetry</option>
            </Select>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {include === "mcp"
                ? "Matches a caller-controlled user-agent prefix. That is not proof of origin."
                : "Every recorded API-key call, whatever made it."}
            </p>
          </div>
          <div className="min-w-0">
            <Label htmlFor="mcp-history-tool">Exact tool identifier</Label>
            <Input
              id="mcp-history-tool"
              type="search"
              className="mt-1"
              maxLength={96}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. subscribers_list"
              value={toolInput}
              onChange={(event) => setToolInput(event.target.value)}
              aria-invalid={!toolIsCanonical || undefined}
              aria-describedby="mcp-history-tool-help"
            />
            <p
              id="mcp-history-tool-help"
              className="mt-1 text-xs leading-5 text-muted-foreground"
            >
              {toolIsCanonical
                ? "An exact match, not a search. Pick one from Top tools below to fill it in."
                : "Not a canonical tool token, so the filter was not sent. Use letters, digits, dot, colon, underscore or hyphen, starting with a letter."}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {trimmedTool ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setToolInput("")}
            >
              Clear tool filter
            </Button>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={live}
              onChange={(event) => setLive(event.target.checked)}
            />
            Live table updates
          </label>
          {live ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setReconnectNonce((nonce) => nonce + 1)}
            >
              <Radio aria-hidden="true" />
              Reconnect live stream
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            loading={refreshing}
            onClick={refresh}
          >
            {!refreshing ? <RefreshCw aria-hidden="true" /> : null}
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <p
          role="status"
          className="mt-2 text-xs leading-5 text-muted-foreground"
        >
          {live
            ? streamStatus === "open"
              ? `Live: new rows are prepended as they arrive. ${liveRows.length.toLocaleString()} arrived since the tail opened. Summary cards do not move — they refresh only on Refresh.`
              : streamStatus === "connecting"
                ? "Connecting or reconnecting to the execution stream…"
                : "The execution stream is closed. Reconnect to reopen it."
            : "Refresh reloads the statistics, quota configuration, hourly trend, and the first execution page."}
        </p>
      </fieldset>

      {failure ? (
        <div className="mt-4">
          <GovernanceError
            message={apiErrorMessage(
              failure,
              "Execution telemetry could not be read. Nothing here should be read as an absence of agent activity.",
            )}
            retrying={refreshing}
            onRetry={refresh}
          />
        </div>
      ) : null}

      {loading ? (
        <div className="mt-4">
          <GovernanceLoading
            label="Loading recorded execution telemetry…"
            rows={4}
          />
        </div>
      ) : (
        <>
          {summary ? (
            <div className="mt-4">
              <GovernanceMetrics
                columns={4}
                items={[
                  {
                    label: "Recorded calls",
                    value: summary.totalCalls.toLocaleString(),
                    detail: `Over the previous ${summary.windowHours.toLocaleString()} hours`,
                  },
                  {
                    label: "Success rate",
                    value:
                      summary.totalCalls > 0
                        ? percent(summary.successRate)
                        : "—",
                    detail:
                      summary.totalCalls > 0
                        ? `${summary.successfulCalls.toLocaleString()} of ${summary.totalCalls.toLocaleString()} recorded 2xx/3xx`
                        : "No recorded calls to measure",
                  },
                  {
                    label: "p95 latency",
                    value:
                      summary.totalCalls > 0
                        ? formatMcpLatency(summary.p95LatencyMs)
                        : "—",
                    detail:
                      summary.totalCalls > 0
                        ? `Mean ${formatMcpLatency(summary.averageLatencyMs)}`
                        : "No latency sample in this window",
                  },
                  {
                    label: "Estimated cost",
                    value: formatMcpMicrosUsd(summary.totalCostMicros),
                    detail: "Recorder estimate, not a bill",
                  },
                ]}
              />
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Last recorded call: {formatMcpTimestamp(summary.lastCallAt)}.
              </p>
            </div>
          ) : null}

          {points.length > 1 ? (
            <div className="mt-4 min-w-0 rounded-xl border bg-muted/20 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Activity className="size-4" aria-hidden="true" />
                    Hourly call trend
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {points.length.toLocaleString()} hourly buckets. Peak{" "}
                    {peak.toLocaleString()} call{peak === 1 ? "" : "s"} in one
                    hour;{" "}
                    {points
                      .reduce((total, point) => total + point.calls, 0)
                      .toLocaleString()}{" "}
                    across the window.
                  </p>
                </div>
                <Sparkline
                  data={points.map((point) => point.calls)}
                  width={220}
                  height={40}
                  className="shrink-0"
                />
              </div>
            </div>
          ) : null}

          {summary && summary.statusBreakdown?.length > 0 ? (
            <ul className="mt-4 flex flex-wrap gap-2">
              {summary.statusBreakdown.map((bucket) => (
                <li key={bucket.statusClass}>
                  <Badge variant={mcpStatusTone(bucket.statusClass * 100)}>
                    {mcpStatusClassLabel(bucket.statusClass)} ·{" "}
                    {bucket.calls.toLocaleString()}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}

          {summary && summary.topTools?.length > 0 ? (
            <div className="mt-4 min-w-0">
              <h3 className="text-sm font-medium">Top tools</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Select one to filter the rows below to that exact identifier.
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {summary.topTools.slice(0, 12).map((tool) => (
                  <li key={tool.toolName}>
                    <Button
                      type="button"
                      variant={
                        appliedTool === tool.toolName ? "default" : "outline"
                      }
                      size="sm"
                      aria-pressed={appliedTool === tool.toolName}
                      onClick={() =>
                        setToolInput(
                          appliedTool === tool.toolName ? "" : tool.toolName,
                        )
                      }
                    >
                      <span className="font-mono">{tool.toolName}</span>
                      <span className="text-muted-foreground">
                        {tool.calls.toLocaleString()}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* A failed page read must never render as an empty table: "no rows
              returned" and "we could not ask" look identical on screen and
              mean opposite things. The alert above is the whole answer. */}
          {rows.length === 0 && firstPage.isError ? null : rows.length === 0 ? (
            <div className="mt-4">
              <GovernanceEmpty>
                No recorded row was returned for the{" "}
                {MCP_WINDOW_LABELS[historyWindow].toLocaleLowerCase()}{" "}
                {include === "mcp"
                  ? "from the self-identified npm proxy"
                  : "across all API-key telemetry"}
                {appliedTool ? ` for ${appliedTool}` : ""}. Best-effort
                observability can be incomplete, so this is not evidence that
                nothing ran.
              </GovernanceEmpty>
            </div>
          ) : (
            <div className="mt-4 min-w-0">
              <TableContainer aria-label="Recorded MCP executions">
                <Table>
                  <caption className="px-4 py-2 text-left text-xs leading-5 text-muted-foreground">
                    {rows.length.toLocaleString()} row
                    {rows.length === 1 ? "" : "s"} in descending recorder-ID
                    order. Raw request values and remote IPs are removed before
                    a row enters this page.
                  </caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Tool</TableHead>
                      <TableHead>Method · path</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatMcpTimestamp(row.calledAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {row.toolName ?? "Not recorded"}
                        </TableCell>
                        <TableCell className="break-all font-mono text-xs text-muted-foreground">
                          {row.method} {row.path}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatMcpLatency(row.latencyMs)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={mcpStatusTone(row.statusCode)}>
                            {row.statusCode || "—"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`View execution ${row.id} details`}
                            onClick={() => setSelected(row)}
                          >
                            View
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>

              {loadOlder.isError ? (
                <p
                  role="status"
                  className="mt-2 text-xs leading-5 text-warning-emphasis"
                >
                  Older executions were not added.{" "}
                  {apiErrorMessage(
                    loadOlder.error,
                    "The page request did not complete.",
                  )}
                </p>
              ) : null}

              {retentionCapped ? (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {MAX_RETAINED_MCP_EXECUTIONS.toLocaleString()} rows are
                  retained in this view. Older rows are not requested again;
                  narrow the filters or refresh to start a new traversal.
                </p>
              ) : cursor ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={loadOlder.isPending}
                    onClick={() => loadOlder.mutate()}
                  >
                    {loadOlder.isPending
                      ? "Loading older executions…"
                      : "Load older"}
                  </Button>
                  <span className="text-xs leading-5 text-muted-foreground">
                    The next page begins before execution {cursor}.
                  </span>
                </div>
              ) : (
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  No older matching row was returned in this traversal. The
                  recorder may still be incomplete.
                </p>
              )}
            </div>
          )}
        </>
      )}

      <McpExecutionDetailDialog
        execution={selected}
        onClose={() => setSelected(null)}
      />
    </GovernanceSection>
  );
}
