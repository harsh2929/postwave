/** A privacy-bounded, live summary of the most recent MCP executions. */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the bounded overflow region needs a keyboard scroll stop at high zoom */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { api } from "../../lib/api-client";
import {
  onContextEpochObserved,
  readContextEpoch,
} from "../../lib/context-epoch";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import { useMe } from "../../lib/store";
import "../../styles-postwave-ai-context.css";
import { inspectorFailureMessage } from "./contextual-inspector-helpers";
import { projectSafeMcpExecution } from "../mcp/mcp-execution-security";
import { validExecutionPageForScope } from "../mcp/mcp-telemetry-validation";

const POLL_MS = 5000;
const MAX_ROWS = 8;

type ExecutionState =
  | "success"
  | "redirect"
  | "client-error"
  | "server-error"
  | "unknown";

interface ExecutionRow {
  id: string;
  tool: string;
  method: string;
  path: string;
  statusCode: number | null;
  latencyMs: number | null;
  calledAt: string | null;
}

function decodeRows(payload: unknown, tenantId: string): ExecutionRow[] | null {
  const candidatePage = payload as Parameters<
    typeof validExecutionPageForScope
  >[0];
  if (
    !validExecutionPageForScope(
      candidatePage,
      "1970-01-01T00:00:00Z",
      "",
      undefined,
      tenantId,
      "mcp",
    ) ||
    candidatePage.rows.length > MAX_ROWS
  ) {
    return null;
  }
  return candidatePage.rows.map((candidate) => {
    const row = projectSafeMcpExecution(candidate);
    return {
      id: String(row.id),
      tool: row.toolName || `${row.method} request`,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      calledAt: row.calledAt,
    };
  });
}

function executionState(code: number | null): ExecutionState {
  if (code === null) return "unknown";
  if (code >= 500) return "server-error";
  if (code >= 400) return "client-error";
  if (code >= 300) return "redirect";
  if (code >= 200) return "success";
  return "unknown";
}

function executionLabel(state: ExecutionState): string {
  switch (state) {
    case "success":
      return "Completed";
    case "redirect":
      return "Redirected";
    case "client-error":
      return "Request error";
    case "server-error":
      return "Server error";
    default:
      return "Result unavailable";
  }
}

function relativeTime(iso: string | null): {
  visible: string;
  accessible: string;
} {
  if (!iso) {
    return { visible: "—", accessible: "Call time unavailable" };
  }
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const exact = date.toLocaleString();
  if (diff < -60_000) return { visible: exact, accessible: exact };
  if (diff < 60_000) return { visible: "just now", accessible: exact };
  if (diff < 3_600_000) {
    return {
      visible: `${Math.floor(diff / 60_000)}m ago`,
      accessible: exact,
    };
  }
  if (diff < 86_400_000) {
    return {
      visible: `${Math.floor(diff / 3_600_000)}h ago`,
      accessible: exact,
    };
  }
  return {
    visible: date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    }),
    accessible: exact,
  };
}

export function RecentExecutionsStrip(): ReactElement {
  const me = useMe();
  const contextEpoch = useSyncExternalStore(
    onContextEpochObserved,
    readContextEpoch,
    readContextEpoch,
  );
  const ready = Boolean(me?.user && me.tenant && contextEpoch);
  if (!ready || me?.effectiveRole !== "admin") {
    return (
      <section
        className="card ai-context-card"
        aria-labelledby="ai-recent-executions-title"
      >
        <header className="ai-context-header">
          <div className="ai-context-header-copy">
            <span className="ai-context-kicker">Protected evidence</span>
            <h3 id="ai-recent-executions-title" className="ai-context-title">
              Recent agent activity
            </h3>
          </div>
        </header>
        <p className="ai-context-copy">
          {!ready
            ? "Execution telemetry stays hidden until the current user, workspace, effective role, and server context epoch are observed."
            : "Execution telemetry is available only to the current workspace's effective admin role."}
        </p>
      </section>
    );
  }
  const identityScope =
    me.user + ":" + me.tenant + ":" + me.effectiveRole + ":" + contextEpoch;
  return (
    <AuthorizedRecentExecutionsStrip
      key={identityScope}
      identityScope={identityScope}
      tenantId={me.tenant}
    />
  );
}

function AuthorizedRecentExecutionsStrip({
  identityScope,
  tenantId,
}: {
  identityScope: string;
  tenantId: string;
}): ReactElement {
  const [rows, setRows] = useState<ExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const pollingPausedRef = useRef(false);
  const requestRef = useRef(0);

  const fetchOnce = useCallback(
    async (force = false): Promise<void> => {
      if ((!force && pollingPausedRef.current) || inFlightRef.current) return;
      if (force) {
        pollingPausedRef.current = false;
        setAccessDenied(false);
        setLoading(true);
      }
      inFlightRef.current = true;
      const requestId = ++requestRef.current;
      let response: Awaited<ReturnType<typeof api.listMCPExecutions>>;
      try {
        response = await api.listMCPExecutions({ limit: MAX_ROWS });
      } catch (caught) {
        if (mountedRef.current && requestId === requestRef.current) {
          setError(inspectorFailureMessage(caught, "executions-load"));
          setLoading(false);
        }
        return;
      } finally {
        inFlightRef.current = false;
      }
      if (!mountedRef.current || requestId !== requestRef.current) return;
      if (response.error) {
        const denied =
          response.error.status === 401 || response.error.status === 403;
        if (denied) {
          pollingPausedRef.current = true;
          setAccessDenied(true);
          setRows([]);
        }
        setError(inspectorFailureMessage(response.error, "executions-load"));
        setLoading(false);
        return;
      }
      const decoded = decodeRows(response.data, tenantId);
      if (!decoded) {
        setError(inspectorFailureMessage({ kind: "parse" }, "executions-load"));
        setLoading(false);
        return;
      }
      setAccessDenied(false);
      setError(null);
      setRows(decoded);
      setLoading(false);
    },
    [tenantId],
  );

  useEffect(() => {
    mountedRef.current = true;
    pollingPausedRef.current = false;
    void fetchOnce();
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchOnce();
    }, POLL_MS);
    const onVisibilityChange = (): void => {
      if (!document.hidden) void fetchOnce();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchOnce, identityScope]);

  return (
    <section
      className="card ai-context-card"
      aria-labelledby="ai-recent-executions-title"
      aria-busy={loading}
    >
      <header className="ai-context-header">
        <div className="ai-context-header-copy">
          <span className="ai-context-kicker">MCP receipt</span>
          <h3 id="ai-recent-executions-title" className="ai-context-title">
            Recent agent activity
          </h3>
        </div>
        {!accessDenied ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              navigateDesktopRoute({ section: "mcp", tab: "history" })
            }
          >
            Full history →
          </button>
        ) : null}
      </header>

      <p className="ai-context-copy">
        While visible, this admin-only panel checks about every five seconds for
        up to eight response-validated, self-identified npm-proxy telemetry
        rows. The source is best-effort and may be incomplete.
      </p>

      {loading ? (
        <div className="ai-context-loading" role="status" aria-live="polite">
          <span className="sr-only">Loading recent agent activity…</span>
          <div className="skel" />
          <div className="skel" />
        </div>
      ) : accessDenied ? (
        <div className="ai-context-guidance" data-tone="locked">
          <p className="ai-context-copy">{error}</p>
          <div className="ai-context-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void fetchOnce(true)}
            >
              Check access again
            </button>
          </div>
        </div>
      ) : error && rows.length === 0 ? (
        <div className="notice ai-context-notice" role="alert">
          <span>{error}</span>{" "}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void fetchOnce(true)}
          >
            Retry now
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="ai-context-empty">
          No recent MCP calls were returned for this workspace. New calls will
          appear here after the next successful check.
        </p>
      ) : (
        <>
          {error ? (
            <div className="notice ai-context-notice" role="status">
              <span>Showing the last verified activity. {error}</span>{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void fetchOnce(true)}
              >
                Retry now
              </button>
            </div>
          ) : null}
          {/* Horizontal overflow needs a keyboard stop at narrow/200% zoom. */}
          <div
            className="ai-execution-scroll"
            tabIndex={0}
            role="region"
            aria-label="Recent MCP executions; scroll horizontally for all columns"
          >
            <table className="ai-execution-table">
              <caption className="sr-only">
                Most recent response-validated recorded telemetry rows
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tool and endpoint</th>
                  <th scope="col">Result</th>
                  <th scope="col">Latency</th>
                  <th scope="col">Called</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const state = executionState(row.statusCode);
                  const called = relativeTime(row.calledAt);
                  return (
                    <tr key={row.id}>
                      <th scope="row">
                        <span className="ai-execution-tool">{row.tool}</span>
                        <span className="ai-execution-endpoint">
                          {row.method} {row.path}
                        </span>
                      </th>
                      <td data-label="Result">
                        <span className="ai-execution-state" data-state={state}>
                          {executionLabel(state)}
                          {row.statusCode === null
                            ? ""
                            : ` · ${row.statusCode}`}
                        </span>
                      </td>
                      <td className="ai-execution-meta" data-label="Latency">
                        {row.latencyMs === null ? "—" : `${row.latencyMs} ms`}
                      </td>
                      <td className="ai-execution-meta" data-label="Called">
                        <time
                          dateTime={row.calledAt ?? undefined}
                          aria-label={called.accessible}
                        >
                          {called.visible}
                        </time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
