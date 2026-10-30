/**
 * MCP inspection surface. Setup remains structurally release-held; Tools
 * presents the server-bundled source candidate (not published-artifact
 * parity); History presents bounded, mutable, best-effort API-key telemetry.
 * None of these planes proves transport qualification or authorization.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Card } from "../components/Card";
import { Notice } from "../components/Notice";
import { SectionHeader } from "../components/SectionHeader";
import { McpConnectionSetup } from "../components/mcp/McpConnectionSetup";
import { ExecutionSlideover } from "../components/mcp/McpExecutionDetail";
import {
  McpExecutionLog,
  McpHistoryFilters,
} from "../components/mcp/McpExecutionLog";
import { McpToolCatalog } from "../components/mcp/McpToolCatalog";
import { mcpFailureMessage } from "../components/mcp/mcp-display";
import {
  formatMcpAbsoluteTime as fmtAbsolute,
  formatMcpLatency as fmtLatency,
  formatMcpMicrosUsd as fmtMicrosUSD,
  formatMcpPercent as fmtPercent,
  formatMcpRelativeTime as fmtRelative,
  MCP_WINDOW_HOURS as WINDOW_HOURS,
  mcpStatusClassColor as classColor,
  mcpStatusClassLabel as classLabel,
  mcpWindowSinceISO as windowSinceISO,
  type McpHistoryWindow as Window,
} from "../components/mcp/mcp-display";
import { projectSafeMcpExecution } from "../components/mcp/mcp-execution-security";
import {
  MCP_EXECUTION_OVERLAY,
  mcpHistoryRouteView,
  routeWithMcpHistoryView,
  validMcpToolFilter,
} from "../components/mcp/mcp-route-state";
import {
  MAX_RETAINED_MCP_EXECUTIONS,
  mergeExecutions,
  validExecutionPage,
  validExecutionPageForScope,
  validLiveExecutionForScope,
  validQuotaEnvelopeForScope,
  validQuotas,
  validStats,
  validTrend,
  validTrendEnvelopeForScope,
} from "../components/mcp/mcp-telemetry-validation";
import { AccessibleChartData } from "../components/charts/AccessibleChartData";
import { CategoricalDistributionChart } from "../components/charts/CategoricalDistributionChart";
import { Sparkline as CompactSparkline } from "../components/charts/Sparkline";
import { dux025Provenance } from "../components/charts/dux-025-visual-manifest";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import {
  type MCPExecution,
  type MCPExecutionsResponse,
  type MCPStats,
  type MCPStatusFrequency,
  type MCPToolQuota,
  type MCPTrendPoint,
  api,
  buildStreamUrl,
  invalidateStreamCredential,
} from "../lib/api-client";
import { HERO } from "../lib/heroAssets";
import { onContextEpochObserved, readContextEpoch } from "../lib/context-epoch";
import {
  desktopRouteIdentityScope,
  navigateDesktopRoute,
  useDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../lib/remote-resource";
import { useMe, type Role } from "../lib/store";
import "../styles-mcp.css";

type Tab = "setup" | "tools" | "history";
const MCP_TABS = [
  { value: "setup" },
  { value: "tools" },
  { value: "history" },
] as const;

interface McpIdentity {
  scope: string;
  tenantId: string;
  effectiveRole: Role | null;
  ready: boolean;
}

/** Authorization-bound identity for every MCP remote projection. */
function useMcpIdentity(): McpIdentity {
  const me = useMe();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const durableScope =
    desktopRouteIdentityScope(me?.user, me?.tenant) ?? "unresolved";
  return {
    scope:
      durableScope +
      ":" +
      (me?.effectiveRole ?? "unknown") +
      ":" +
      (contextEpoch ?? "unobserved"),
    tenantId: me?.tenant ?? "",
    effectiveRole: me?.effectiveRole ?? null,
    ready: Boolean(me?.user && me.tenant && contextEpoch),
  };
}

function safeMcpFailure(
  error: RemoteApiError,
  fallback: string,
): { message: string; denied: boolean } {
  const failure = remoteFailureFromError(error);
  return {
    message: mcpFailureMessage(failure, fallback),
    denied: failure.access === "denied",
  };
}

export { ExecutionSlideover };

/* ----------------------------------------------------------------------
 * Top-level
 * -------------------------------------------------------------------- */

export function MCP(): ReactElement {
  const identity = useMcpIdentity();
  const route = useDesktopRoute();
  const [tab, setTab] = useDesktopRouteTab<Tab>(
    "mcp",
    ["setup", "tools", "history"],
    "setup",
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: MCP_TABS,
    onChange: setTab,
  });

  useEffect(() => {
    if (
      route.section !== "mcp" ||
      route.overlay?.name !== MCP_EXECUTION_OVERLAY ||
      (tab === "history" &&
        identity.ready &&
        identity.effectiveRole === "admin")
    ) {
      return;
    }
    const next = { ...route };
    delete next.overlay;
    navigateDesktopRoute(next, { replace: true, source: "navigation" });
  }, [identity.effectiveRole, identity.ready, route, tab]);

  return (
    <div className="page mcp-page">
      <header className="mcp-route-header">
        <div className="mcp-route-heading">
          <span className="mcp-kicker">Agent operations</span>
          <h1>Model Context Protocol</h1>
          <p>
            Inspect the server-bundled candidate catalogue and bounded API-key
            telemetry. Production client provisioning stays held until every
            transport shares enforceable tool scopes and mutation approvals.
          </p>
        </div>
        <aside className="mcp-route-posture" aria-label="MCP release posture">
          <div>
            <span className="mcp-posture-dot" aria-hidden="true" />
            <strong>Evidence mode</strong>
          </div>
          <p>
            Catalogue and telemetry are observable; credential setup is held.
          </p>
          <span className="badge warning">Provisioning release-held</span>
        </aside>
      </header>

      <div
        ref={tabs.listRef}
        className="tab-bar"
        {...tabs.listProps}
        aria-label="MCP sections"
      >
        <button
          type="button"
          {...tabs.getTabProps("setup")}
          data-index="01"
          data-caption="Transport review"
          className={`tab-button ${tab === "setup" ? "active" : ""}`}
        >
          Setup
        </button>
        <button
          type="button"
          {...tabs.getTabProps("tools")}
          data-index="02"
          data-caption="Candidate catalogue"
          className={`tab-button ${tab === "tools" ? "active" : ""}`}
        >
          Tools
        </button>
        <button
          type="button"
          {...tabs.getTabProps("history")}
          data-index="03"
          data-caption="Recorded telemetry"
          className={`tab-button ${tab === "history" ? "active" : ""}`}
        >
          History
        </button>
      </div>

      <section {...tabs.getPanelProps(tab)}>
        {tab === "setup" ? (
          <SetupTab identityScope={identity.scope} />
        ) : tab === "tools" ? (
          <ToolsTab identity={identity} />
        ) : (
          <HistoryTab identity={identity} />
        )}
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Setup tab — structurally held, non-runnable format review
 * -------------------------------------------------------------------- */

function SetupTab({ identityScope }: { identityScope: string }): ReactElement {
  return (
    <div className="mcp-section">
      <section className="mcp-setup-intro" aria-labelledby="mcp-setup-title">
        <div className="mcp-setup-intro-copy">
          <span className="mcp-kicker">Safe setup review</span>
          <h2 id="mcp-setup-title">
            Know which execution path you are enabling.
          </h2>
          <p>
            Preview a client-specific placeholder, inspect the response-
            validated candidate catalogue, then qualify authorization and
            approval behavior against the exact intended deployment artifact
            before any key is introduced.
          </p>
          <div className="mcp-governance-signals" aria-label="Setup posture">
            <span className="badge success">Credential excluded</span>
            <span className="badge neutral">Non-runnable outline</span>
            <span className="badge neutral">No secret persisted</span>
            <span className="badge warning">Production connect held</span>
          </div>
        </div>
        <figure className="mcp-setup-art">
          <img
            src={HERO.mcp}
            alt="Two brass connectors meeting through a teal thread"
          />
          <figcaption>Client ↔ proxy ↔ Moosewave API</figcaption>
        </figure>
      </section>

      <ol className="mcp-setup-path" aria-label="MCP setup qualification path">
        <li data-state="current">
          <span>01</span>
          <div>
            <strong>Inspect the transport</strong>
            <p>Confirm which runtime and API origin the client will reach.</p>
          </div>
          <em>Now</em>
        </li>
        <li data-state="ready">
          <span>02</span>
          <div>
            <strong>Review the format outline</strong>
            <p>Choose the exact client format without introducing a secret.</p>
          </div>
          <em>Available</em>
        </li>
        <li data-state="held">
          <span>03</span>
          <div>
            <strong>Qualify, then provision</strong>
            <p>Require scope, approval, origin, and audit evidence first.</p>
          </div>
          <em>Release-held</em>
        </li>
      </ol>
      <McpConnectionSetup identityScope={identityScope} />
      <details className="mcp-details">
        <summary>Understand the two MCP source planes</summary>
        <p>
          The advertised client templates launch the npm proxy (
          <code>@postwave/mcp-server</code>) and authenticate to REST with an
          API key. Requests may self-identify with{" "}
          <code>User-Agent: postwave-mcp-server/&lt;version&gt;</code> and{" "}
          <code>X-Postwave-MCP-Tool: &lt;tool-name&gt;</code>. Those headers are
          caller-controlled labels, not proof of origin or authorization.
        </p>
        <p>
          Moosewave also has a separate native read-only candidate/control path
          at <code>/api/v1/mcp/rpc</code>. It is not configured by these
          templates, and its transport lifecycle and tool input schemas have not
          been qualified as a standard production MCP transport. Write execution
          remains held. History below reads best-effort{" "}
          <code>api_key_calls</code> telemetry and is not a complete native MCP
          audit trail.
        </p>
      </details>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * Tools tab — searchable catalogue
 * -------------------------------------------------------------------- */

function ToolsTab({ identity }: { identity: McpIdentity }): ReactElement {
  if (!identity.ready) {
    return <McpResourceIdentityBoundary noun="tool catalogue" />;
  }
  if (identity.effectiveRole !== "admin") {
    return (
      <div className="mcp-section mcp-access-boundary">
        <span className="mcp-kicker">Protected evidence</span>
        <h2>Admin access required</h2>
        <p>
          The server-bundled candidate catalogue remains hidden outside the
          current workspace&apos;s effective admin role.
        </p>
      </div>
    );
  }
  return <McpToolCatalog identityScope={identity.scope} />;
}

function McpResourceIdentityBoundary({ noun }: { noun: string }): ReactElement {
  return (
    <div className="mcp-section mcp-access-boundary" role="status">
      <span className="mcp-kicker">Authorization context</span>
      <h2>Resolving this workspace</h2>
      <p>
        The {noun} stays hidden until the user, workspace, effective role, and
        server context epoch are all observed.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------
 * History tab — stats + trend + breakdowns + filterable log
 * -------------------------------------------------------------------- */

// AUTO_REFRESH_MS retained as historical reference — the polling
// loop was replaced by an EventSource live tail; kept here as a
// comment so anyone diffing the history understands the transition.
// const AUTO_REFRESH_MS = 15_000;

const MCP_PARSE_FAILURE: RemoteApiError = {
  kind: "parse",
  message: "The MCP response did not match its contract.",
};

interface HistorySlot<T> {
  data: T | null;
  error: string | null;
  stale: boolean;
  denied: boolean;
}

interface HistoryResources {
  stats: HistorySlot<MCPStats>;
  trend: HistorySlot<MCPTrendPoint[]>;
  quotas: HistorySlot<MCPToolQuota[]>;
  executions: HistorySlot<MCPExecutionsResponse>;
}

function emptyHistorySlot<T>(): HistorySlot<T> {
  return { data: null, error: null, stale: false, denied: false };
}

function emptyHistoryResources(): HistoryResources {
  return {
    stats: emptyHistorySlot<MCPStats>(),
    trend: emptyHistorySlot<MCPTrendPoint[]>(),
    quotas: emptyHistorySlot<MCPToolQuota[]>(),
    executions: emptyHistorySlot<MCPExecutionsResponse>(),
  };
}

function deniedHistoryResources(message: string): HistoryResources {
  const deniedSlot = <T,>(): HistorySlot<T> => ({
    data: null,
    error: message,
    stale: false,
    denied: true,
  });
  return {
    stats: deniedSlot<MCPStats>(),
    trend: deniedSlot<MCPTrendPoint[]>(),
    quotas: deniedSlot<MCPToolQuota[]>(),
    executions: deniedSlot<MCPExecutionsResponse>(),
  };
}

function resolveHistorySlot<T>(
  data: T | undefined,
  error: RemoteApiError | undefined,
  valid: (value: T | undefined) => boolean,
  previous: HistorySlot<T>,
  reset: boolean,
  fallback: string,
): HistorySlot<T> {
  if (!error && valid(data) && data !== undefined) {
    return { data, error: null, stale: false, denied: false };
  }
  const safe = safeMcpFailure(error ?? MCP_PARSE_FAILURE, fallback);
  const retained = reset || safe.denied ? null : previous.data;
  return {
    data: retained,
    error: safe.message,
    stale: retained !== null,
    denied: safe.denied,
  };
}

function validStatsForWindow(
  value: MCPStats | undefined,
  window: Window,
  since: string,
  tenantId: string,
): value is MCPStats {
  if (
    !validStats(value) ||
    value.tenantId !== tenantId ||
    value.windowHours !== WINDOW_HOURS[window]
  ) {
    return false;
  }
  if (!value.lastCallAt) return value.totalCalls === 0;
  const timestamp = new Date(value.lastCallAt).getTime();
  return (
    timestamp >= new Date(since).getTime() &&
    timestamp <= Date.now() + 5 * 60 * 1_000
  );
}

interface HistoryDataOptions {
  identityScope: string;
  tenantId: string;
  window: Window;
  include: "mcp" | "all";
  tool: string;
}

function useMcpHistoryData({
  identityScope,
  tenantId,
  window,
  include,
  tool,
}: HistoryDataOptions) {
  const filterKey =
    identityScope + "\u0000" + window + "\u0000" + include + "\u0000" + tool;
  const [resources, setResources] = useState<HistoryResources>(
    emptyHistoryResources,
  );
  const [representedFilterKey, setRepresentedFilterKey] = useState(filterKey);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<number | null>(null);
  const [summaryLiveDelta, setSummaryLiveDelta] = useState(false);
  const [executionRetentionCapped, setExecutionRetentionCapped] =
    useState(false);
  const activeRef = useRef(true);
  const requestIdRef = useRef(0);
  const fullLoadRef = useRef<Promise<void> | null>(null);
  const loadMoreRequestRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const resourcesRef = useRef(resources);
  const filterKeyRef = useRef(filterKey);
  resourcesRef.current = resources;
  filterKeyRef.current = filterKey;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestIdRef.current += 1;
      loadMoreRequestRef.current += 1;
      loadingMoreRef.current = false;
    };
  }, []);

  const load = useCallback(
    (reset: boolean, supersede: boolean): Promise<void> => {
      if (!supersede && fullLoadRef.current) return fullLoadRef.current;
      const requestId = ++requestIdRef.current;
      const baseline = reset ? emptyHistoryResources() : resourcesRef.current;
      if (reset) {
        setRepresentedFilterKey(filterKey);
        setResources(baseline);
        setLastVerifiedAt(null);
        setSummaryLiveDelta(false);
        setExecutionRetentionCapped(false);
        setLoadMoreError(null);
        loadMoreRequestRef.current += 1;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
      setRefreshing(true);

      const request = (async (): Promise<void> => {
        try {
          const since = windowSinceISO(window);
          const [statsResult, trendResult, executionResult, quotaResult] =
            await Promise.all([
              api.getMCPStats({ window, include }),
              api.getMCPTrend({ window, include }),
              api.listMCPExecutions({
                include,
                tool: tool || undefined,
                since,
                limit: 50,
              }),
              api.listMCPQuotas(),
            ]);
          if (!activeRef.current || requestId !== requestIdRef.current) return;

          let deniedFailure: ReturnType<typeof safeMcpFailure> | undefined;
          for (const error of [
            statsResult.error,
            trendResult.error,
            executionResult.error,
            quotaResult.error,
          ]) {
            if (!error) continue;
            const failure = safeMcpFailure(
              error,
              "MCP telemetry access was denied.",
            );
            if (!failure.denied) continue;
            deniedFailure = failure;
            break;
          }
          if (deniedFailure) {
            // Route39 is one confidential evidence family. A denial from any
            // member invalidates the authority assumption for the whole
            // batch; do not retain sibling successes or an earlier page.
            setResources(deniedHistoryResources(deniedFailure.message));
            setLastVerifiedAt(null);
            setSummaryLiveDelta(false);
            setExecutionRetentionCapped(false);
            setLoadMoreError(null);
            return;
          }

          let safeExecutionPage: MCPExecutionsResponse | undefined;
          let responseReachedRetentionCap: boolean | null = null;
          if (
            validExecutionPageForScope(
              executionResult.data,
              since,
              tool,
              undefined,
              tenantId,
              include,
            )
          ) {
            responseReachedRetentionCap =
              executionResult.data.rows.length >= MAX_RETAINED_MCP_EXECUTIONS &&
              executionResult.data.nextBeforeId !== undefined;
            safeExecutionPage = {
              tenantId: executionResult.data.tenantId,
              rows: executionResult.data.rows.map(projectSafeMcpExecution),
              detailPolicy: executionResult.data.detailPolicy,
              evidenceClass: executionResult.data.evidenceClass,
              nextBeforeId: responseReachedRetentionCap
                ? undefined
                : executionResult.data.nextBeforeId,
            };
          }
          const trendEnvelope = trendResult.data;
          const safeTrend = validTrendEnvelopeForScope(
            trendEnvelope,
            tenantId,
            WINDOW_HOURS[window],
            since,
          )
            ? trendEnvelope?.points
            : undefined;
          const quotaEnvelope = quotaResult.data;
          const safeQuotas = validQuotaEnvelopeForScope(quotaEnvelope, tenantId)
            ? quotaEnvelope?.quotas
            : undefined;

          const next: HistoryResources = {
            stats: resolveHistorySlot(
              statsResult.data,
              statsResult.error,
              (value) => validStatsForWindow(value, window, since, tenantId),
              baseline.stats,
              reset,
              "MCP statistics could not be verified.",
            ),
            trend: resolveHistorySlot(
              safeTrend,
              trendResult.error,
              validTrend,
              baseline.trend,
              reset,
              "The MCP call trend could not be verified.",
            ),
            quotas: resolveHistorySlot(
              safeQuotas,
              quotaResult.error,
              validQuotas,
              baseline.quotas,
              reset,
              "Per-tool quota usage could not be verified.",
            ),
            executions: resolveHistorySlot(
              safeExecutionPage,
              executionResult.error,
              (value) => value !== undefined && validExecutionPage(value),
              baseline.executions,
              reset,
              "MCP execution history could not be verified.",
            ),
          };
          setResources(next);
          if (responseReachedRetentionCap !== null) {
            setExecutionRetentionCapped(responseReachedRetentionCap);
          }
          if (next.stats.error === null) setSummaryLiveDelta(false);
          if (
            next.stats.error === null &&
            next.trend.error === null &&
            next.quotas.error === null &&
            next.executions.error === null
          ) {
            setLastVerifiedAt(Date.now());
          }
        } catch {
          if (!activeRef.current || requestId !== requestIdRef.current) return;
          const next: HistoryResources = {
            stats: resolveHistorySlot(
              undefined,
              { kind: "network", message: "Request failed" },
              validStats,
              baseline.stats,
              reset,
              "MCP statistics could not be verified.",
            ),
            trend: resolveHistorySlot(
              undefined,
              { kind: "network", message: "Request failed" },
              validTrend,
              baseline.trend,
              reset,
              "The MCP call trend could not be verified.",
            ),
            quotas: resolveHistorySlot(
              undefined,
              { kind: "network", message: "Request failed" },
              validQuotas,
              baseline.quotas,
              reset,
              "Per-tool quota usage could not be verified.",
            ),
            executions: resolveHistorySlot(
              undefined,
              { kind: "network", message: "Request failed" },
              validExecutionPage,
              baseline.executions,
              reset,
              "MCP execution history could not be verified.",
            ),
          };
          setResources(next);
        }
      })();

      let tracked: Promise<void>;
      tracked = request.finally(() => {
        if (fullLoadRef.current === tracked) fullLoadRef.current = null;
        if (activeRef.current && requestId === requestIdRef.current) {
          setRefreshing(false);
        }
      });
      fullLoadRef.current = tracked;
      return tracked;
    },
    [filterKey, include, tenantId, tool, window],
  );

  useEffect(() => {
    void load(true, true);
  }, [load]);

  const refresh = useCallback((): void => {
    void load(false, false);
  }, [load]);

  const loadMore = useCallback(async (): Promise<void> => {
    const page = resourcesRef.current.executions.data;
    if (!page?.nextBeforeId || loadingMoreRef.current) return;
    const requestId = ++loadMoreRequestRef.current;
    const requestFilterKey = filterKeyRef.current;
    const cursor = page.nextBeforeId;
    const since = windowSinceISO(window);
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await api.listMCPExecutions({
        include,
        tool: tool || undefined,
        since,
        limit: 50,
        beforeId: cursor,
      });
      if (
        !activeRef.current ||
        requestId !== loadMoreRequestRef.current ||
        requestFilterKey !== filterKeyRef.current
      ) {
        return;
      }
      if (
        response.error ||
        !validExecutionPageForScope(
          response.data,
          since,
          tool,
          cursor,
          tenantId,
          include,
        )
      ) {
        const failure = safeMcpFailure(
          response.error ?? MCP_PARSE_FAILURE,
          "Older MCP executions could not be verified.",
        );
        if (failure.denied) {
          setResources(deniedHistoryResources(failure.message));
          setLastVerifiedAt(null);
          setSummaryLiveDelta(false);
          setLoadMoreError(null);
        } else {
          setLoadMoreError(failure.message);
        }
        return;
      }
      const currentPage = resourcesRef.current.executions.data;
      if (!currentPage) return;
      const mergedRows = mergeExecutions(
        currentPage.rows,
        response.data.rows.map(projectSafeMcpExecution),
      );
      const reachedRetentionCap =
        mergedRows.length >= MAX_RETAINED_MCP_EXECUTIONS &&
        response.data.nextBeforeId !== undefined;
      setResources((current) => {
        if (!current.executions.data) return current;
        return {
          ...current,
          executions: {
            data: {
              tenantId: response.data.tenantId,
              rows: mergedRows,
              detailPolicy: response.data.detailPolicy,
              evidenceClass: response.data.evidenceClass,
              nextBeforeId: reachedRetentionCap
                ? undefined
                : response.data.nextBeforeId,
            },
            error: null,
            stale: false,
            denied: false,
          },
        };
      });
      setExecutionRetentionCapped(reachedRetentionCap);
    } catch {
      if (
        activeRef.current &&
        requestId === loadMoreRequestRef.current &&
        requestFilterKey === filterKeyRef.current
      ) {
        setLoadMoreError(
          safeMcpFailure(
            { kind: "network", message: "Request failed" },
            "Older MCP executions could not be verified.",
          ).message,
        );
      }
    } finally {
      if (
        activeRef.current &&
        requestId === loadMoreRequestRef.current &&
        requestFilterKey === filterKeyRef.current
      ) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [include, tenantId, tool, window]);

  const acceptLiveExecution = useCallback((row: MCPExecution): void => {
    const page = resourcesRef.current.executions.data;
    const mergedRows = mergeExecutions([row], page?.rows ?? []);
    const reachedRetentionCap =
      mergedRows.length >= MAX_RETAINED_MCP_EXECUTIONS &&
      page?.nextBeforeId !== undefined;
    setResources((current) => {
      if (current.executions.denied) return current;
      return {
        ...current,
        executions: {
          data: {
            tenantId: row.tenantId,
            rows: mergedRows,
            detailPolicy: "minimized_v1",
            evidenceClass: "best_effort_observability",
            nextBeforeId: reachedRetentionCap ? undefined : page?.nextBeforeId,
          },
          error: current.executions.error,
          stale: current.executions.stale,
          denied: false,
        },
      };
    });
    if (reachedRetentionCap) setExecutionRetentionCapped(true);
    setSummaryLiveDelta(true);
  }, []);

  const representsActiveScope = representedFilterKey === filterKey;
  return {
    resources: representsActiveScope ? resources : emptyHistoryResources(),
    refreshing,
    loadingMore,
    loadMoreError,
    lastVerifiedAt: representsActiveScope ? lastVerifiedAt : null,
    summaryLiveDelta: representsActiveScope ? summaryLiveDelta : false,
    executionRetentionCapped: representsActiveScope && executionRetentionCapped,
    scopePending: !representsActiveScope,
    refresh,
    loadMore,
    acceptLiveExecution,
  };
}

type McpLiveState =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "contract-failure"
  | "unavailable";

function mcpLiveLabel(state: McpLiveState): string {
  switch (state) {
    case "off":
      return "Live table updates are off.";
    case "connecting":
      return "Connecting the authenticated live table stream…";
    case "live":
      return "Live table stream connected.";
    case "reconnecting":
      return "Live stream interrupted; reconnecting automatically.";
    case "contract-failure":
      return "Live stream stopped because an event failed scope validation.";
    case "unavailable":
      return "Live stream is unavailable. Use Refresh for current records.";
  }
}

function historyNoticeTitle(options: {
  initialLoad: boolean;
  anyDenied: boolean;
  anyStale: boolean;
  anyError: boolean;
  refreshing: boolean;
}): string {
  if (options.initialLoad) return "Validating MCP telemetry responses";
  if (options.anyDenied) return "Access denied for some MCP telemetry";
  if (options.anyStale) return "Some telemetry is from the last valid response";
  if (options.anyError)
    return "Some telemetry responses could not be validated";
  if (options.refreshing) return "Refreshing MCP telemetry";
  return "Loaded telemetry responses validated";
}

function historyNoticeDetail(
  initialLoad: boolean,
  lastVerifiedAt: number | null,
  summaryLiveDelta: boolean,
): string {
  let detail = initialLoad
    ? "Statistics, trend, provisional quota signals, and recorded rows are loading independently."
    : "Each response is labeled independently; unavailable data is not represented as zero. This best-effort source may omit calls.";
  if (lastVerifiedAt !== null && !initialLoad) {
    const verifiedAt = new Date(lastVerifiedAt).toISOString();
    detail =
      "All four responses last passed validation " +
      fmtRelative(verifiedAt) +
      " · " +
      fmtAbsolute(verifiedAt) +
      ".";
  }
  return summaryLiveDelta
    ? detail +
        " New streamed rows are present; refresh to reconcile aggregate cards."
    : detail;
}

function useMcpLiveTail(
  enabled: boolean,
  identityScope: string,
  tenantId: string,
  window: Window,
  include: "mcp" | "all",
  tool: string,
  reconnectNonce: number,
  onExecution: (row: MCPExecution) => void,
): McpLiveState {
  const [state, setState] = useState<McpLiveState>("off");
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    if (!enabled) {
      setState("off");
      return;
    }
    let source: EventSource | null = null;
    let unavailableTimer: ReturnType<typeof globalThis.setTimeout> | null =
      null;
    let cancelled = false;
    let terminal = false;
    const clearUnavailableTimer = (): void => {
      if (unavailableTimer !== null) {
        globalThis.clearTimeout(unavailableTimer);
        unavailableTimer = null;
      }
    };
    setState("connecting");
    void (async () => {
      try {
        const suffix = include === "all" ? "?include=all" : "";
        const url = await buildStreamUrl(
          "/api/v1/mcp/executions/stream" + suffix,
        );
        if (cancelled) return;
        source = new EventSource(url, { withCredentials: true });
        source.addEventListener("open", () => {
          clearUnavailableTimer();
          if (!cancelled && !terminal) setState("live");
        });
        source.addEventListener("execution", (event: MessageEvent) => {
          try {
            const row: unknown = JSON.parse(event.data);
            if (cancelled || terminal) return;
            if (
              !validLiveExecutionForScope(
                row,
                windowSinceISO(window),
                tenantId,
                include,
              )
            ) {
              terminal = true;
              clearUnavailableTimer();
              source?.close();
              setState("contract-failure");
              return;
            }
            if (toolRef.current && row.toolName !== toolRef.current) return;
            onExecution(projectSafeMcpExecution(row));
          } catch {
            if (!cancelled && !terminal) {
              terminal = true;
              clearUnavailableTimer();
              source?.close();
              setState("contract-failure");
            }
          }
        });
        source.addEventListener("unavailable", (event: MessageEvent) => {
          if (cancelled || terminal) return;
          let validTerminalSignal = false;
          try {
            const payload: unknown = JSON.parse(event.data);
            validTerminalSignal =
              payload !== null &&
              typeof payload === "object" &&
              (payload as Record<string, unknown>).code ===
                "stream_read_unavailable" &&
              (payload as Record<string, unknown>).retryable === true;
          } catch {
            validTerminalSignal = false;
          }
          terminal = true;
          clearUnavailableTimer();
          source?.close();
          setState(validTerminalSignal ? "unavailable" : "contract-failure");
        });
        source.addEventListener("closed", (event: MessageEvent) => {
          if (cancelled || terminal) return;
          let validTerminalSignal = false;
          try {
            const payload: unknown = JSON.parse(event.data);
            const record = payload as Record<string, unknown>;
            validTerminalSignal =
              payload !== null &&
              typeof payload === "object" &&
              !Array.isArray(payload) &&
              Object.keys(record).length === 1 &&
              ["credential_expired", "max_duration"].includes(
                String(record.reason),
              );
          } catch {
            validTerminalSignal = false;
          }
          terminal = true;
          clearUnavailableTimer();
          source?.close();
          if (validTerminalSignal) invalidateStreamCredential();
          setState(validTerminalSignal ? "unavailable" : "contract-failure");
        });
        source.addEventListener("error", () => {
          if (cancelled || terminal) return;
          setState("reconnecting");
          unavailableTimer ??= globalThis.setTimeout(() => {
            unavailableTimer = null;
            if (!cancelled && !terminal) {
              terminal = true;
              source?.close();
              setState("unavailable");
            }
          }, 10_000);
        });
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      clearUnavailableTimer();
      source?.close();
    };
  }, [
    enabled,
    identityScope,
    include,
    onExecution,
    reconnectNonce,
    tenantId,
    window,
  ]);

  return state;
}

function HistoryTab({ identity }: { identity: McpIdentity }): ReactElement {
  if (!identity.ready || identity.effectiveRole !== "admin") {
    return (
      <McpHistoryAccessBoundary
        role={identity.effectiveRole}
        identityReady={identity.ready}
      />
    );
  }
  return <McpHistoryWorkspace identity={identity} />;
}

function McpHistoryAccessBoundary({
  role,
  identityReady,
}: {
  role: Role | null;
  identityReady: boolean;
}): ReactElement {
  return (
    <div className="mcp-section mcp-access-boundary">
      <span className="mcp-kicker">Protected evidence</span>
      <h2>
        {!identityReady || role === null
          ? "Verifying your access"
          : "Admin access required"}
      </h2>
      <p>
        {!identityReady || role === null
          ? "MCP execution telemetry remains hidden until this workspace identity and effective role are resolved."
          : "Execution paths, API-key identifiers, and quota usage are restricted to the workspace admin role. Export remains unavailable on this release-held surface."}
      </p>
      <div className="mcp-governance-signals" aria-label="History safeguards">
        <span className="badge neutral">No cached rows shown</span>
        <span className="badge neutral">No live stream opened</span>
        <span className="badge neutral">No export prepared</span>
      </div>
    </div>
  );
}

function McpHistoryWorkspace({
  identity,
}: {
  identity: McpIdentity;
}): ReactElement {
  const route = useDesktopRoute();
  const routeView = useMemo(() => mcpHistoryRouteView(route), [route]);
  const { window, include, tool: debouncedToolFilter } = routeView;
  const [toolFilter, setToolFilter] = useState(routeView.tool);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [liveReconnectNonce, setLiveReconnectNonce] = useState(0);
  const previousIdentityScope = useRef(identity.scope);

  useEffect(() => {
    if (!routeView.needsNormalization) return;
    navigateDesktopRoute(routeWithMcpHistoryView(route, routeView, null), {
      replace: true,
      source: "navigation",
    });
  }, [route, routeView]);

  useEffect(() => {
    setToolFilter(routeView.tool);
  }, [routeView.tool]);

  useEffect(() => {
    const normalized = toolFilter.trim();
    if (!validMcpToolFilter(normalized) || normalized === routeView.tool)
      return;
    const timer = globalThis.setTimeout(() => {
      navigateDesktopRoute(
        routeWithMcpHistoryView(
          route,
          { ...routeView, tool: normalized },
          null,
        ),
      );
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [route, routeView, toolFilter]);

  useEffect(() => {
    if (previousIdentityScope.current === identity.scope) return;
    previousIdentityScope.current = identity.scope;
    setToolFilter("");
    setAutoRefresh(false);
    navigateDesktopRoute(
      routeWithMcpHistoryView(
        route,
        { window: "7d", include: "mcp", tool: "" },
        null,
      ),
      { replace: true, source: "identity" },
    );
  }, [identity.scope, route]);

  const setWindow = useCallback(
    (nextWindow: Window): void => {
      navigateDesktopRoute(
        routeWithMcpHistoryView(
          route,
          { ...routeView, window: nextWindow },
          null,
        ),
      );
    },
    [route, routeView],
  );
  const setInclude = useCallback(
    (nextInclude: "mcp" | "all"): void => {
      navigateDesktopRoute(
        routeWithMcpHistoryView(
          route,
          { ...routeView, include: nextInclude },
          null,
        ),
      );
    },
    [route, routeView],
  );

  const data = useMcpHistoryData({
    identityScope: identity.scope,
    tenantId: identity.tenantId,
    window,
    include,
    tool: debouncedToolFilter,
  });
  const stats = data.resources.stats.data;
  const trend = data.resources.trend.data;
  const quotas = data.resources.quotas.data;
  const executionPage = data.resources.executions.data;
  const anyError = Object.values(data.resources).some(
    (resource) => resource.error !== null,
  );
  const anyStale = Object.values(data.resources).some(
    (resource) => resource.stale,
  );
  const anyDenied = Object.values(data.resources).some(
    (resource) => resource.denied,
  );
  const liveState = useMcpLiveTail(
    autoRefresh && !anyDenied,
    identity.scope,
    identity.tenantId,
    window,
    include,
    debouncedToolFilter,
    liveReconnectNonce,
    data.acceptLiveExecution,
  );
  const initialLoad =
    stats === null &&
    trend === null &&
    quotas === null &&
    executionPage === null &&
    !anyError;
  const filterPending =
    toolFilter.trim() !== debouncedToolFilter || data.scopePending;
  const telemetryNoticeTitle = historyNoticeTitle({
    initialLoad,
    anyDenied,
    anyStale,
    anyError,
    refreshing: data.refreshing,
  });
  const telemetryNoticeDetail = historyNoticeDetail(
    initialLoad,
    data.lastVerifiedAt,
    data.summaryLiveDelta,
  );
  const statsLoading = stats === null && data.resources.stats.error === null;
  const sourceLabel =
    include === "mcp"
      ? "Self-identified npm proxy"
      : "All recorded API-key telemetry";
  const selected =
    !data.resources.executions.denied && executionPage !== null
      ? (executionPage.rows.find((row) => row.id === routeView.selectedId) ??
        null)
      : null;

  useEffect(() => {
    if (routeView.selectedId === null) return;
    if (
      data.resources.executions.denied ||
      (executionPage !== null &&
        !executionPage.rows.some((row) => row.id === routeView.selectedId))
    ) {
      navigateDesktopRoute(routeWithMcpHistoryView(route, routeView, null), {
        replace: true,
        source: "navigation",
      });
    }
  }, [data.resources.executions.denied, executionPage, route, routeView]);

  useEffect(() => {
    if (!anyDenied) return;
    setAutoRefresh(false);
    if (route.overlay?.name === MCP_EXECUTION_OVERLAY) {
      navigateDesktopRoute(routeWithMcpHistoryView(route, routeView, null), {
        replace: true,
        source: "navigation",
      });
    }
  }, [anyDenied, route, routeView]);

  if (anyDenied) {
    const denial = Object.values(data.resources).find(
      (resource) => resource.denied,
    );
    return (
      <div className="mcp-section mcp-access-boundary" role="alert">
        <span className="mcp-kicker">Authorization changed</span>
        <h2>Telemetry hidden and live access closed</h2>
        <p>
          {denial?.error ??
            "Your current role does not have permission to view this telemetry."}
        </p>
        <div className="mcp-governance-signals" aria-label="Denial safeguards">
          <span className="badge neutral">Recorded rows cleared</span>
          <span className="badge neutral">Live stream closed</span>
          <span className="badge neutral">Detail selection cleared</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mcp-section">
      <header className="mcp-history-intro">
        <div>
          <span className="mcp-kicker">Admin evidence workspace</span>
          <h2>Observe what the API-key telemetry recorder retained.</h2>
          <p>
            Inspect bounded aggregates and rows without treating this mutable,
            best-effort source as a complete MCP audit log. Native RPC calls
            have a separate source plane that is not joined here.
          </p>
        </div>
        <dl className="mcp-history-scope" aria-label="Current telemetry scope">
          <div>
            <dt>Window</dt>
            <dd>Last {window}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{sourceLabel}</dd>
          </div>
          <div>
            <dt>Tool filter</dt>
            <dd>{debouncedToolFilter || "All recorded identifiers"}</dd>
          </div>
        </dl>
      </header>
      <Notice
        tone={anyError ? (anyStale ? "warning" : "danger") : "neutral"}
        announcement="polite"
        title={telemetryNoticeTitle}
      >
        {telemetryNoticeDetail}
      </Notice>

      <dl className="mcp-stats-grid" aria-label="Recorded telemetry summary">
        <StatCard
          label={"Calls (last " + window + ")"}
          value={
            statsLoading
              ? "Loading…"
              : stats
                ? stats.totalCalls.toLocaleString()
                : "Not available"
          }
          subtitle={
            stats
              ? (include === "mcp"
                  ? "Caller-labeled npm-proxy rows"
                  : "All retained API-key rows") + " · server aggregate"
              : undefined
          }
          accent
        />
        <StatCard
          label="Success rate"
          value={
            statsLoading
              ? "Loading…"
              : stats
                ? fmtPercent(stats.successRate)
                : "Not available"
          }
          subtitle={
            stats
              ? stats.successfulCalls.toLocaleString() +
                " of " +
                stats.totalCalls.toLocaleString() +
                " responses were 2xx or 3xx"
              : undefined
          }
        />
        <StatCard
          label="Average latency"
          value={
            statsLoading
              ? "Loading…"
              : stats
                ? fmtLatency(stats.averageLatencyMs)
                : "Not available"
          }
          subtitle={stats ? "p95 " + fmtLatency(stats.p95LatencyMs) : undefined}
        />
        <StatCard
          label="Last call"
          value={statsLoading ? "Loading…" : fmtRelative(stats?.lastCallAt)}
          subtitle={
            stats?.lastCallAt ? fmtAbsolute(stats.lastCallAt) : undefined
          }
        />
        <StatCard
          label="Estimated spend"
          value={
            statsLoading
              ? "Loading…"
              : stats
                ? fmtMicrosUSD(stats.totalCostMicros)
                : "Not available"
          }
          subtitle={
            stats
              ? stats.totalCostMicros.toLocaleString() +
                " micro-USD summed from server-recorded per-call estimates"
              : undefined
          }
        />
      </dl>

      {data.resources.stats.error ? (
        <Notice
          tone={data.resources.stats.stale ? "warning" : "danger"}
          title={
            data.resources.stats.stale
              ? "Showing the last response-validated MCP statistics"
              : "MCP statistics unavailable"
          }
        >
          {data.resources.stats.error}
        </Notice>
      ) : null}

      <SectionHeader
        title="Provisional quota signals"
        description="Configured observations and recorded usage—not authoritative enforcement, billing, or proof that excess calls were blocked."
      />
      <QuotasCard
        quotas={quotas ?? []}
        loading={quotas === null && data.resources.quotas.error === null}
        error={data.resources.quotas.error}
      />

      {data.resources.trend.error ? (
        <Notice
          tone={data.resources.trend.stale ? "warning" : "danger"}
          title={
            data.resources.trend.stale
              ? "Showing the last response-validated call trend"
              : "Call trend unavailable"
          }
        >
          {data.resources.trend.error}
        </Notice>
      ) : null}
      {trend === null && !data.resources.trend.error ? (
        <p className="muted" role="status">
          Loading and validating the hourly telemetry response…
        </p>
      ) : trend && trend.length > 0 ? (
        <Sparkline points={trend} windowLabel={window} include={include} />
      ) : trend ? (
        <Notice tone="neutral" title="No hourly call activity">
          The response-validated trend contains no recorded calls for this
          requested window and source.
        </Notice>
      ) : null}

      <SectionHeader
        title="Breakdowns"
        description="Recorded top-tool, API-key, and HTTP-status aggregates for the selected request scope; omissions in the recorder remain possible."
        helpText="Choose a recorded tool identifier to apply it to the telemetry-row filter."
      />
      <div className="mcp-top-row">
        <TopToolsCard
          tools={stats?.topTools ?? []}
          onDrill={(name) => setToolFilter(toolFilter === name ? "" : name)}
          active={toolFilter}
        />
        <TopKeysCard keys={stats?.topApiKeys ?? []} />
        <StatusBreakdownCard
          breakdown={stats?.statusBreakdown ?? []}
          loading={stats === null && data.resources.stats.error === null}
          error={data.resources.stats.error}
          windowLabel={window}
          include={include}
        />
      </div>

      <SectionHeader
        title="Executions"
        description="Response-validated recorded rows with exact retained identifiers and timestamps. Request content is locally redacted before display or clipboard use."
      />
      <div
        className={`mcp-live-state tone-${liveState}`}
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" />
        <div>
          <strong>{mcpLiveLabel(liveState)}</strong>
          <small>
            Streamed rows remain best-effort telemetry; refresh reconciles the
            aggregate cards.
          </small>
        </div>
        {liveState === "unavailable" || liveState === "contract-failure" ? (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setLiveReconnectNonce((value) => value + 1)}
          >
            Reconnect live stream
          </button>
        ) : null}
      </div>
      <McpHistoryFilters
        window={window}
        include={include}
        toolFilter={toolFilter}
        autoRefresh={autoRefresh}
        refreshing={data.refreshing}
        refreshReason={
          filterPending ? "Wait for the tool filter to finish applying." : null
        }
        onWindowChange={setWindow}
        onIncludeChange={setInclude}
        onToolFilterChange={setToolFilter}
        onAutoRefreshChange={setAutoRefresh}
        onRefresh={data.refresh}
      />
      <aside
        className="mcp-export-hold"
        aria-labelledby="mcp-export-hold-title"
      >
        <span className="badge warning">Release-held</span>
        <div>
          <h3 id="mcp-export-hold-title">Telemetry export is unavailable</h3>
          <p>
            No export action is mounted. The current server transport cannot
            establish a complete, bounded, formula-safe evidence file, so this
            workspace keeps inspection in place until that contract is proven.
          </p>
        </div>
      </aside>
      {filterPending ? (
        <Notice tone="neutral" title="Applying the tool filter">
          Execution rows are hidden while you finish typing so records from the
          previous filter cannot be mistaken for matches.
        </Notice>
      ) : (
        <McpExecutionLog
          error={data.resources.executions.error}
          rows={executionPage?.rows ?? null}
          stale={data.resources.executions.stale}
          window={window}
          include={include}
          nextBeforeId={executionPage?.nextBeforeId}
          retentionCapped={data.executionRetentionCapped}
          loadingMore={data.loadingMore}
          loadMoreError={data.loadMoreError}
          onSelect={(execution) =>
            navigateDesktopRoute(
              routeWithMcpHistoryView(route, routeView, {
                name: MCP_EXECUTION_OVERLAY,
                resourceId: String(execution.id),
              }),
            )
          }
          onLoadMore={() => void data.loadMore()}
        />
      )}

      {selected ? (
        <ExecutionSlideover
          execution={selected}
          onClose={() =>
            navigateDesktopRoute(
              routeWithMcpHistoryView(route, routeView, null),
              { replace: true, source: "navigation" },
            )
          }
        />
      ) : null}
    </div>
  );
}
/* ----------------------------------------------------------------------
 * Sub-components
 * -------------------------------------------------------------------- */

function StatCard(props: {
  label: string;
  value: string;
  subtitle?: string;
  accent?: boolean;
}): ReactElement {
  return (
    <Card
      className={`mcp-stat-card ${props.accent ? "accent" : ""}`}
      padding="md"
    >
      <dt className="mcp-stat-label">{props.label}</dt>
      <dd className="mcp-stat-value">{props.value}</dd>
      {props.subtitle ? (
        <dd className="mcp-stat-subtitle">{props.subtitle}</dd>
      ) : null}
    </Card>
  );
}

/** Calls-per-hour card around the shared inspectable compact Sparkline. */
function Sparkline(props: {
  points: MCPTrendPoint[];
  windowLabel: Window;
  include: "mcp" | "all";
}): ReactElement | null {
  const { points } = props;
  if (points.length === 0) return null;

  const totalCalls = points.reduce((n, p) => n + p.calls, 0);
  const peak = points.reduce(
    (best, p) => (p.calls > best.calls ? p : best),
    points[0],
  );

  return (
    <Card className="mcp-sparkline-card" padding="md">
      <div className="mcp-sparkline-meta">
        <span className="mcp-stat-label">Calls per hour</span>
        <span className="muted small">
          {totalCalls.toLocaleString()} total · peak {peak.calls} at{" "}
          {fmtAbsolute(peak.bucket)}
        </span>
      </div>
      <CompactSparkline
        values={points.map((point) => point.calls)}
        labels={points.map((point) => fmtAbsolute(point.bucket))}
        width={600}
        height={60}
        responsive
        className="mcp-sparkline-svg"
        valueLabel="calls"
        ariaLabel={`${points.length} hourly MCP call buckets, ${totalCalls.toLocaleString()} total, peak ${peak.calls.toLocaleString()}`}
        formatValue={(value) => value.toLocaleString()}
        dataDisclosure={{
          title: "MCP calls by hourly bucket",
          summary: `${points.length} hourly buckets contain ${totalCalls.toLocaleString()} calls; the peak bucket contains ${peak.calls.toLocaleString()} calls.`,
          provenance: dux025Provenance("mcpCallTrend", {
            scope: `${props.windowLabel} requested window · ${props.include === "mcp" ? "self-identified npm-proxy rows" : "all recorded API-key telemetry"} · best-effort source`,
          }),
          exportFileName: "mcp-calls-by-hour.csv",
          exportPrivacy: "confidential",
          allowExport: false,
          rowHeaderLabel: "Hourly bucket",
        }}
      />
    </Card>
  );
}

/**
 * QuotasCard renders one progress bar per per-tool quota the
 * operator configured. Tools with no quota row simply don't appear.
 * Bar colour goes warning→danger as utilisation approaches 100%.
 *
 * This projection is read-only. Server-attributed atomic enforcement is not
 * qualified, so create/update/delete remains structurally release-held rather
 * than delegated to a client or curl.
 */
function QuotasCard(props: {
  quotas: MCPToolQuota[];
  loading: boolean;
  error: string | null;
}): ReactElement {
  const reset = new Date(Date.now());
  reset.setUTCHours(24, 0, 0, 0);
  const resetIso = reset.toISOString();
  const summary =
    String(props.quotas.length) +
    " configured per-tool quota observations. Best-effort usage is counted from 00:00 UTC; cost values are configured estimates per call and are not billing receipts.";
  return (
    <Card className="mcp-mini-card" padding="md">
      <h3 className="mcp-subhead">Observed quota configuration · UTC day</h3>
      <p className="muted small">
        Usage resets at <time dateTime={resetIso}>{fmtAbsolute(resetIso)}</time>
        . These counters and tool labels are caller-influenced, asynchronous
        observations. They do not prove that a threshold was enforced, that an
        excess call was blocked, or that every call was counted.
      </p>
      {props.loading ? (
        <p className="muted" role="status">
          Loading and validating provisional quota observations…
        </p>
      ) : props.error && props.quotas.length === 0 ? (
        <p className="muted" role="alert">
          {props.error}
        </p>
      ) : (
        <>
          {props.error ? (
            <Notice
              tone="warning"
              title="Showing the last response-validated quota observations"
            >
              {props.error}
            </Notice>
          ) : null}
          {props.quotas.length === 0 ? (
            <p className="muted" role="status">
              The response contains no configured per-tool quota observations.
              Absence does not establish an enforced unlimited policy.
            </p>
          ) : (
            <div className="mcp-status-bars">
              {props.quotas.map((quota) => {
                const limit = quota.dailyLimit ?? 0;
                const utilization =
                  limit > 0 ? (quota.usedToday / limit) * 100 : null;
                const barPercent =
                  utilization === null
                    ? 0
                    : Math.min(100, Math.max(0, utilization));
                const remaining =
                  limit > 0 ? Math.max(0, limit - quota.usedToday) : null;
                const overage =
                  limit > 0 ? Math.max(0, quota.usedToday - limit) : 0;
                const tone =
                  utilization !== null && utilization >= 90
                    ? "danger"
                    : utilization !== null && utilization >= 70
                      ? "warning"
                      : "success";
                return (
                  <div key={quota.toolName} className="mcp-status-bar-row">
                    <code className="mcp-tool-name">{quota.toolName}</code>
                    <div className="mcp-status-bar-track" aria-hidden="true">
                      {limit > 0 ? (
                        <div
                          className={"mcp-status-bar-fill tone-" + tone}
                          style={{ width: barPercent.toFixed(1) + "%" }}
                        />
                      ) : null}
                    </div>
                    <span className="mcp-quota-detail">
                      <span>
                        {quota.usedToday.toLocaleString()} used
                        {limit > 0
                          ? " / " +
                            limit.toLocaleString() +
                            " configured threshold"
                          : " · no configured threshold row"}
                        {utilization === null
                          ? ""
                          : " · " +
                            utilization.toFixed(1) +
                            "% · " +
                            (tone === "danger"
                              ? "above or near threshold"
                              : tone === "warning"
                                ? "approaching threshold"
                                : "below configured threshold")}
                      </span>
                      <span className="muted small">
                        {overage > 0
                          ? overage.toLocaleString() +
                            " observed calls above the configured threshold"
                          : remaining === null
                            ? "No daily threshold represented"
                            : remaining.toLocaleString() +
                              " calls until the configured threshold (not an enforcement promise)"}
                        {" · "}
                        configured estimate{" "}
                        {fmtMicrosUSD(quota.estimatedCostMicros)} per call
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {!props.loading && props.quotas.length > 0 ? (
        <AccessibleChartData
          title="MCP per-tool quota utilization today · provisional observation"
          summary={summary}
          rowHeaderLabel="Exact tool identifier"
          columns={[
            { key: "used", label: "Calls used since 00:00 UTC" },
            { key: "limit", label: "Configured daily limit" },
            {
              key: "remaining",
              label: "Distance from configured threshold",
            },
            { key: "utilization", label: "Utilization" },
            {
              key: "estimatedCost",
              label: "Configured estimate per call",
            },
            { key: "reset", label: "Next UTC reset" },
          ]}
          rows={props.quotas.map((quota) => {
            const limit = quota.dailyLimit ?? 0;
            const utilization =
              limit > 0 ? (quota.usedToday / limit) * 100 : null;
            const delta = limit > 0 ? limit - quota.usedToday : null;
            return {
              key: quota.toolName,
              label: quota.toolName,
              values: {
                used: quota.usedToday.toLocaleString(),
                limit:
                  limit > 0
                    ? limit.toLocaleString()
                    : "No configured threshold",
                remaining:
                  delta === null
                    ? "Not applicable"
                    : delta >= 0
                      ? delta.toLocaleString() + " remaining"
                      : Math.abs(delta).toLocaleString() + " over",
                utilization:
                  utilization == null
                    ? "Not applicable"
                    : utilization.toFixed(1) + "%",
                estimatedCost: fmtMicrosUSD(quota.estimatedCostMicros),
                reset: fmtAbsolute(resetIso),
              },
              exportValues: {
                used: quota.usedToday,
                limit: limit > 0 ? limit : "Unlimited",
                remaining: delta,
                utilization,
                estimatedCost: quota.estimatedCostMicros / 1_000_000,
                reset: resetIso,
              },
            };
          })}
          provenance={dux025Provenance("mcpQuotaUtilization", {
            scope:
              "Configured quota rows · usage since 00:00 UTC · configured cost estimates",
          })}
          exportFileName="mcp-per-tool-quota-utilization.csv"
          exportPrivacy="confidential"
          allowExport={false}
        />
      ) : null}
    </Card>
  );
}
function TopToolsCard(props: {
  tools: { toolName: string; calls: number }[];
  onDrill: (name: string) => void;
  active: string;
}): ReactElement {
  return (
    <Card className="mcp-mini-card" padding="md">
      <h4 className="mcp-subhead">Top tools</h4>
      <ul className="mcp-mini-list">
        {props.tools.length === 0 ? (
          <li className="muted">No usage in this loaded window.</li>
        ) : (
          props.tools.map((tool) => (
            <li key={tool.toolName}>
              <button
                type="button"
                className={
                  "mcp-drill " +
                  (props.active === tool.toolName ? "active" : "")
                }
                onClick={() => props.onDrill(tool.toolName)}
                aria-pressed={props.active === tool.toolName}
                aria-label={
                  props.active === tool.toolName
                    ? "Remove execution filter for " + tool.toolName
                    : "Filter recorded telemetry to " + tool.toolName
                }
              >
                <code>{tool.toolName}</code>
                {props.active === tool.toolName ? (
                  <span className="mcp-drill-state">Selected</span>
                ) : null}
              </button>
              <span className="muted">{tool.calls.toLocaleString()} calls</span>
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}

function TopKeysCard(props: {
  keys: { apiKeyPrefix: string; calls: number; apiKeyId?: string }[];
}): ReactElement {
  return (
    <Card className="mcp-mini-card" padding="md">
      <h4 className="mcp-subhead">Top API keys</h4>
      <ul className="mcp-mini-list">
        {props.keys.length === 0 ? (
          <li className="muted">No usage in this loaded window.</li>
        ) : (
          props.keys.map((key, index) => (
            <li key={key.apiKeyId ?? "unknown-key-" + String(index)}>
              <span className="mcp-key-identity">
                <code>{key.apiKeyId || "ID not retained"}</code>
                <span className="muted small">
                  Prefix {key.apiKeyPrefix || "not retained"}
                </span>
              </span>
              <span className="muted">{key.calls.toLocaleString()} calls</span>
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}
/**
 * StatusBreakdownCard renders the 2xx/3xx/4xx/5xx distribution as
 * horizontal proportion bars. Each class is omitted when its count
 * is zero. The widths are flex-1 weighted by call count so the
 * card lets operators eyeball the error mix at a glance.
 */
function StatusBreakdownCard(props: {
  breakdown: MCPStatusFrequency[];
  loading: boolean;
  error: string | null;
  windowLabel: Window;
  include: "mcp" | "all";
}): ReactElement {
  const total = props.breakdown.reduce((n, s) => n + s.calls, 0);
  return (
    <Card className="mcp-mini-card" padding="md">
      <h4 className="mcp-subhead">Status breakdown</h4>
      {props.loading ? (
        <p className="muted" role="status">
          Loading HTTP status distribution…
        </p>
      ) : props.error && total === 0 ? (
        <p className="muted" role="alert">
          Couldn&apos;t load HTTP status distribution: {props.error}
        </p>
      ) : total === 0 ? (
        <p className="muted" role="status">
          No API calls were recorded in this window.
        </p>
      ) : (
        <CategoricalDistributionChart
          title="MCP HTTP status distribution"
          valueLabel="Calls"
          height={12}
          segments={props.breakdown.map((status) => ({
            key: String(status.class),
            label: classLabel(status.class),
            value: status.calls,
            color: classColor(status.class),
          }))}
          provenance={dux025Provenance("mcpStatusBreakdown", {
            scope: `${props.windowLabel} requested window · ${props.include === "mcp" ? "self-identified npm-proxy rows" : "all recorded API-key telemetry"} · best-effort source`,
          })}
          exportFileName="mcp-http-status-distribution.csv"
          exportPrivacy="confidential"
          allowExport={false}
        />
      )}
    </Card>
  );
}
