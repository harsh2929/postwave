/** Verified per-match action outcomes with bounded, locally redacted evidence. */

import type { ReactElement } from "react";

import {
  type RemoteLoadResult,
  useRemoteResource,
} from "../../hooks/useRemoteResource";
import type { InboundRouteActionRun } from "../../lib/api-client";
import { api } from "../../lib/api-client";
import { isInitialRemoteLoad } from "../../lib/remote-resource";
import { sanitizeInspectableText } from "../webhook-simulator/ResponseInspector";
import { RemoteDataNotice } from "../RemoteDataNotice";
import {
  formatInboundRouteAbsolute,
  formatInboundRouteRelative,
} from "./inbound-route-time";

function isRun(value: unknown): value is InboundRouteActionRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<InboundRouteActionRun>;
  return (
    typeof run.id === "number" &&
    Number.isFinite(run.id) &&
    typeof run.route_id === "string" &&
    typeof run.action_index === "number" &&
    Number.isInteger(run.action_index) &&
    typeof run.action_kind === "string" &&
    ["succeeded", "failed", "skipped"].includes(run.status ?? "") &&
    typeof run.attempts === "number" &&
    Number.isInteger(run.attempts) &&
    typeof run.duration_ms === "number" &&
    Number.isFinite(run.duration_ms) &&
    typeof run.executed_at === "string"
  );
}

async function loadActionRuns(
  matchId: number,
): Promise<RemoteLoadResult<InboundRouteActionRun[]>> {
  const response = await api.inboundRouteActionRunsList(matchId);
  if (response.error) return { error: response.error };
  const runs = response.data?.runs;
  if (!Array.isArray(runs) || !runs.every(isRun)) {
    return {
      error: {
        kind: "parse",
        message: "Inbound action-run response did not match its contract",
      },
    };
  }
  return { data: runs };
}

export function ActionRunsPanel({
  matchID,
  open = true,
}: {
  matchID: number;
  open?: boolean;
}): ReactElement | null {
  const resource = useRemoteResource(() => loadActionRuns(matchID), {
    identity: `inbound-action-runs:${matchID}`,
    auto: open,
  });
  if (!open) return null;

  return (
    <div className="inbound-runs-surface">
      <RemoteDataNotice
        resource={resource}
        label="action outcomes"
        onRetry={() => void resource.reload()}
      />
      {isInitialRemoteLoad(resource) ? (
        <div className="inbound-runs inbound-runs-empty muted" role="status">
          Verifying action outcomes…
        </div>
      ) : resource.data?.length ? (
        <ul className="inbound-runs">
          {resource.data.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      ) : resource.data ? (
        <div className="inbound-runs inbound-runs-empty muted" role="status">
          No action outcomes are present in this verified record. Older matches
          may predate action-run evidence or exceed the 30-day retention window.
        </div>
      ) : null}
    </div>
  );
}

function failureSummary(run: InboundRouteActionRun): string {
  const status = run.http_status;
  if (status === 401 || status === 403) {
    return "The destination rejected its configured authentication.";
  }
  if (status === 408 || status === 504) {
    return "The destination did not respond before the timeout.";
  }
  if (status === 429) {
    return "The destination rate-limited this action.";
  }
  if (status && status >= 500) {
    return "The destination reported a server failure.";
  }
  return "The action did not complete. Use the complete run and route identifiers to correlate destination logs.";
}

function RunRow({ run }: { run: InboundRouteActionRun }): ReactElement {
  const statusTone =
    run.status === "succeeded"
      ? "success"
      : run.status === "failed"
        ? "danger"
        : "warning";
  const snippet = run.response_snippet
    ? sanitizeInspectableText(run.response_snippet.slice(0, 4_096))
    : null;

  return (
    <li className="inbound-run-row">
      <div className="inbound-run-head">
        <span className="inbound-run-index">
          Action {(run.action_index + 1).toLocaleString()}
        </span>
        <code className="inbound-run-kind">{run.action_kind}</code>
        <span className={`badge ${statusTone} inbound-run-status`}>
          {run.status}
        </span>
        {run.http_status ? (
          <span
            className={`badge ${run.http_status >= 400 ? "danger" : "success"}`}
          >
            HTTP {run.http_status}
          </span>
        ) : null}
        {run.attempts > 1 ? (
          <span className="badge warning">
            {run.attempts.toLocaleString()} attempts
          </span>
        ) : null}
        <span className="spacer" />
        <time className="inbound-run-time" dateTime={run.executed_at}>
          <span>{formatInboundRouteRelative(run.executed_at)}</span>
          <span>{formatInboundRouteAbsolute(run.executed_at)}</span>
        </time>
      </div>
      <dl className="inbound-run-evidence">
        <div>
          <dt>Run ID</dt>
          <dd className="mono">{run.id}</dd>
        </div>
        <div>
          <dt>Route ID</dt>
          <dd className="mono">{run.route_id}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd className="tabular">{run.duration_ms.toLocaleString()} ms</dd>
        </div>
      </dl>
      {run.status === "failed" || run.error_message ? (
        <p className="inbound-run-error" role="alert">
          {failureSummary(run)} Raw provider error text is concealed.
        </p>
      ) : null}
      {snippet ? (
        <details className="inbound-run-response">
          <summary>View locally redacted response excerpt</summary>
          <p className="muted">
            Credential-shaped values are replaced locally. Review destination
            logs for authoritative evidence.
            {snippet.redactedCount
              ? ` ${snippet.redactedCount.toLocaleString()} sensitive ${snippet.redactedCount === 1 ? "value was" : "values were"} redacted.`
              : " No credential-shaped value was detected; the excerpt can still contain destination-authored data."}
          </p>
          <pre className="inbound-run-snippet">
            <code>{snippet.text}</code>
          </pre>
        </details>
      ) : null}
    </li>
  );
}
