import { type ReactElement, useId } from "react";

import type { MCPExecution } from "../../lib/api-client";
import { InlineHelp } from "../InlineHelp";
import { Notice } from "../Notice";
import {
  formatMcpAbsoluteTime,
  formatMcpLatency,
  formatMcpRelativeTime,
  MCP_WINDOW_HOURS,
  mcpStatusBadge,
  type McpHistorySource,
  type McpHistoryWindow,
} from "./mcp-display";
import {
  safeMcpMethod,
  safeMcpPath,
  safeMcpToolName,
} from "./mcp-execution-security";
import { MAX_RETAINED_MCP_EXECUTIONS } from "./mcp-telemetry-validation";

export interface McpHistoryFiltersProps {
  window: McpHistoryWindow;
  include: McpHistorySource;
  toolFilter: string;
  autoRefresh: boolean;
  refreshing: boolean;
  refreshReason: string | null;
  onWindowChange: (window: McpHistoryWindow) => void;
  onIncludeChange: (include: McpHistorySource) => void;
  onToolFilterChange: (tool: string) => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => void;
}

export function McpHistoryFilters({
  window,
  include,
  toolFilter,
  autoRefresh,
  refreshing,
  refreshReason,
  onWindowChange,
  onIncludeChange,
  onToolFilterChange,
  onAutoRefreshChange,
  onRefresh,
}: McpHistoryFiltersProps): ReactElement {
  const windowId = useId();
  const sourceId = useId();
  const toolId = useId();
  const liveId = useId();
  const refreshHelpId = useId();
  const refreshUnavailable = refreshing || refreshReason !== null;
  return (
    <fieldset className="mcp-filter-row">
      <legend className="sr-only">
        Recorded telemetry filters and actions
      </legend>
      <div className="mcp-filter-control">
        <label className="mcp-field-label" htmlFor={windowId}>
          Window
        </label>
        <select
          id={windowId}
          value={window}
          onChange={(event) =>
            onWindowChange(event.target.value as McpHistoryWindow)
          }
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
      </div>
      <div className="mcp-filter-control">
        <div className="mcp-field-label-row">
          <label className="mcp-field-label" htmlFor={sourceId}>
            Source
          </label>
          <InlineHelp
            text="Self-identified npm proxy matches a caller-controlled user-agent prefix and is not proof of origin. All API-key telemetry is the broader best-effort api_key_calls source. Native MCP RPC has a separate call log that is not shown here."
            ariaLabel="About the source filter"
          />
        </div>
        <select
          id={sourceId}
          value={include}
          onChange={(event) =>
            onIncludeChange(event.target.value as McpHistorySource)
          }
        >
          <option value="mcp">Self-identified npm proxy</option>
          <option value="all">All recorded API-key telemetry</option>
        </select>
      </div>
      <div className="mcp-filter-control grow">
        <label className="mcp-field-label" htmlFor={toolId}>
          Exact tool identifier
        </label>
        <input
          id={toolId}
          type="search"
          placeholder="e.g. subscribers_list"
          maxLength={96}
          autoComplete="off"
          spellCheck={false}
          value={toolFilter}
          onChange={(event) => onToolFilterChange(event.target.value)}
        />
      </div>
      {toolFilter ? (
        <button
          type="button"
          className="btn ghost"
          onClick={() => onToolFilterChange("")}
        >
          Clear tool filter
        </button>
      ) : null}
      <div className="mcp-auto-refresh">
        <input
          id={liveId}
          type="checkbox"
          checked={autoRefresh}
          onChange={(event) => onAutoRefreshChange(event.target.checked)}
        />
        <label htmlFor={liveId}>Live table updates</label>
        <InlineHelp
          text="New response-validated rows are prepended from the authenticated stream. This is not a complete audit source; summary cards update only on refresh."
          ariaLabel="About live table updates"
        />
      </div>
      <button
        type="button"
        className="btn ghost"
        aria-disabled={refreshUnavailable || undefined}
        aria-describedby={refreshHelpId}
        onClick={() => {
          if (!refreshUnavailable) onRefresh();
        }}
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <p id={refreshHelpId} className="mcp-action-reason">
        {refreshing
          ? "A telemetry refresh is already in progress."
          : (refreshReason ??
            "Refreshes statistics, quota usage, the chart, and the first execution page.")}
      </p>
    </fieldset>
  );
}

function ExecutionTime({ value }: { value: string }): ReactElement {
  const valid = Number.isFinite(new Date(value).getTime());
  return (
    <time dateTime={valid ? value : undefined} className="mcp-time-pair">
      <span>{formatMcpRelativeTime(value)}</span>
      <span className="muted small">{formatMcpAbsoluteTime(value)}</span>
    </time>
  );
}

export interface McpExecutionLogProps {
  error: string | null;
  rows: MCPExecution[] | null;
  stale: boolean;
  window: McpHistoryWindow;
  include: McpHistorySource;
  nextBeforeId: number | undefined;
  retentionCapped: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onSelect: (execution: MCPExecution) => void;
  onLoadMore: () => void;
}

export function McpExecutionLog({
  error,
  rows,
  stale,
  window,
  include,
  nextBeforeId,
  retentionCapped,
  loadingMore,
  loadMoreError,
  onSelect,
  onLoadMore,
}: McpExecutionLogProps): ReactElement {
  const loadMoreHelpId = useId();
  if (!rows && error) {
    return (
      <Notice tone="danger" title="Execution history unavailable">
        {error}
      </Notice>
    );
  }
  if (!rows)
    return (
      <div className="muted" role="status">
        Loading and validating recorded telemetry rows…
      </div>
    );

  return (
    <div className="mcp-execution-log">
      {error ? (
        <Notice
          tone={stale ? "warning" : "danger"}
          title={
            stale
              ? "Showing previously response-validated rows"
              : "Execution history unavailable"
          }
        >
          {error}
        </Notice>
      ) : null}
      {rows.length === 0 ? (
        <div className="mcp-empty" role="status">
          <h3>No recorded rows in the last {window}</h3>
          <p>
            {include === "mcp"
              ? "No self-identified npm-proxy row was returned for this loaded window."
              : "No API-key telemetry row was returned for this loaded window."}
          </p>
          <p className="muted small">
            Requested scope: the previous {MCP_WINDOW_HOURS[window]} hours.
            Best-effort observability can be incomplete.
          </p>
        </div>
      ) : (
        <div
          className="mcp-table-scroll"
          role="region"
          aria-label="MCP executions table"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focus lets keyboard users pan the responsive overflow region
          tabIndex={0}
        >
          <table className="mcp-exec-table">
            <caption>
              Recorded telemetry rows in descending recorder-ID order. Retained
              identifiers and times are shown in full; raw request values and
              remote IPs are removed before rows enter retained UI state.
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Execution ID</th>
                <th scope="col">Tool identifier</th>
                <th scope="col">Method · path</th>
                <th scope="col">API key</th>
                <th scope="col">Latency</th>
                <th scope="col">Status</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const badge = mcpStatusBadge(row.statusCode);
                return (
                  <tr key={row.id} className="mcp-exec-row">
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        When
                      </span>
                      <ExecutionTime value={row.calledAt} />
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Execution ID
                      </span>
                      <code>{String(row.id)}</code>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Tool identifier
                      </span>
                      <code>
                        {row.toolName
                          ? safeMcpToolName(row.toolName)
                          : "Not recorded"}
                      </code>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Method · path
                      </span>
                      <code className="muted mcp-wrap">
                        {safeMcpMethod(row.method)} {safeMcpPath(row.path)}
                      </code>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        API key
                      </span>
                      <span className="mcp-key-identity">
                        <code>{row.apiKeyId || "ID not retained"}</code>
                        <span className="muted small">
                          Prefix {row.apiKeyPrefix || "not retained"}
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Latency
                      </span>
                      <span>{formatMcpLatency(row.latencyMs)}</span>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Status
                      </span>
                      <span className={"badge " + badge.tone}>
                        {badge.label}
                      </span>
                    </td>
                    <td>
                      <span className="mcp-mobile-label" aria-hidden="true">
                        Details
                      </span>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => onSelect(row)}
                        aria-label={
                          "View execution " + String(row.id) + " details"
                        }
                      >
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loadMoreError ? (
        <Notice tone="warning" title="Older executions were not added">
          {loadMoreError}
        </Notice>
      ) : null}
      {retentionCapped ? (
        <Notice tone="neutral" title="Local inspection limit reached">
          {MAX_RETAINED_MCP_EXECUTIONS.toLocaleString()} response-validated rows
          are retained in this view. Older rows are not requested again; narrow
          the filters or refresh to start a new bounded traversal.
        </Notice>
      ) : nextBeforeId ? (
        <div className="mcp-load-more">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              if (!loadingMore) onLoadMore();
            }}
            aria-disabled={loadingMore || undefined}
            aria-describedby={loadMoreHelpId}
          >
            {loadingMore ? "Loading older executions…" : "Load older"}
          </button>
          <span id={loadMoreHelpId} className="muted small">
            {loadingMore
              ? "One page request is already in progress."
              : "Next cursor begins before execution " +
                String(nextBeforeId) +
                "."}
          </span>
        </div>
      ) : rows.length > 0 ? (
        <p className="muted small">
          No older matching rows were returned in this traversal. The recorder
          may still be incomplete.
        </p>
      ) : null}
    </div>
  );
}
