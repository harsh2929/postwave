/**
 * Connection-scoped warehouse lifecycle, health, and recent-run evidence.
 *
 * Provider responses are treated as untrusted: this surface renders bounded
 * status tokens and locally classified failures, never raw provider errors,
 * credential references, cursors, URIs, or rejected row values.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import {
  type WarehouseConnection,
  type WarehouseSyncRun,
  warehouseApi,
} from "../../lib/api-client";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import { ConfirmModal } from "../ConfirmModal";
import { Notice } from "../Notice";
import { RemoteDataNotice } from "../RemoteDataNotice";

const RECENT_RUN_LIMIT = 5;
const MUTATION_OPERATION = {
  ownerId: "warehouse-connection-lifecycle",
  label: "Warehouse connection lifecycle operation",
  detail:
    "Wait for the warehouse connection request to finish before leaving Moosewave.",
} as const;

interface ProviderHealthView {
  state: string;
  liveState: string | null;
  executionMode: string | null;
  executable: boolean;
  statementsExecuted: number;
  missingSettings: string[];
  warningCount: number;
  issue: string | null;
}

interface ConnectionHealthView {
  status: string;
  health: string;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  providerRuntimeStatus: string | null;
  providerDriverAttachment: string | null;
  missingSettings: string[];
  warningCount: number;
  issue: string | null;
  providerHealth: ProviderHealthView | null;
}

export interface WarehouseConnectionControlProps {
  connection: WarehouseConnection;
  canAdmin: boolean;
  onConnectionChanged: (connection: WarehouseConnection) => void;
  onDisconnected: () => void;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeToken(value: unknown): string | null {
  const token = stringOf(value);
  return token && token.length <= 80 && /^[A-Za-z0-9._:@/-]+$/.test(token)
    ? token
    : null;
}

const CONNECTION_STATUSES = new Set([
  "active",
  "disconnected",
  "draft",
  "error",
  "paused",
]);
const CONNECTION_HEALTH_STATES = new Set([
  "disconnected",
  "error",
  "healthy",
  "needs_attention",
  "paused",
]);
const RUN_STATUSES = new Set([
  "cancelled",
  "completed",
  "failed",
  "partial",
  "queued",
  "running",
]);
const PROVIDER_RUNTIME_STATES = new Set([
  "available",
  "delegated",
  "partial",
  "planned",
  "unavailable",
]);
const PROVIDER_DRIVER_ATTACHMENTS = new Set([
  "attached",
  "inline",
  "manifest_worker",
  "planned",
  "worker_attached",
  "workspace_storage",
]);
const PROVIDER_HEALTH_STATES = new Set([
  "checked",
  "driver_not_attached",
  "failed",
  "health_check_ready",
  "not_active",
  "not_ready",
  "provider_checked",
  "ready",
]);
const PROVIDER_LIVE_STATES = new Set([
  "executed",
  "failed",
  "healthy",
  "not_executed",
  "planned",
]);
const PROVIDER_EXECUTION_MODES = new Set([
  "bounded_sql",
  "inline",
  "local_driver",
  "snowflake_database_sql",
  "snowflake_sql_api",
]);
const PROVIDER_SETTING_KEYS = new Set([
  "account",
  "account_id",
  "account_url",
  "bucket",
  "catalog",
  "cluster_or_workgroup",
  "container",
  "credentials_ref",
  "database",
  "dataset",
  "host",
  "http_path",
  "iam_role_ref",
  "import_prefix",
  "import_table",
  "location",
  "port",
  "prefix",
  "project_id",
  "region",
  "role",
  "schema",
  "sslmode",
  "stage",
  "table_prefix",
  "tenant_id",
  "warehouse",
  "warehouse_id",
  "workspace_url",
]);
const WAREHOUSE_PROVIDERS = new Set([
  "azure_blob",
  "bigquery",
  "databricks",
  "postgres",
  "r2",
  "redshift",
  "s3",
  "snowflake",
  "streaming_export",
]);
const WAREHOUSE_DIRECTIONS = new Set(["bidirectional", "export", "import"]);
const WAREHOUSE_CADENCES = new Set(["daily", "hourly", "manual", "weekly"]);
const WAREHOUSE_OBJECTS = new Set([
  "campaigns",
  "catalog",
  "custom_objects",
  "events",
  "flows",
  "forms",
  "metrics",
  "profiles",
  "reviews",
  "subscribers",
]);
const WAREHOUSE_RUN_MODES = new Set([
  "backfill",
  "dry_run",
  "manual",
  "retry",
  "scheduled",
]);

function safeEnumToken(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | null {
  const token = safeToken(value)?.toLowerCase();
  return token && allowed.has(token) ? token : null;
}

function safeEnumTokens(
  value: unknown,
  allowed: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => safeEnumToken(item, allowed))
    .filter((item): item is string => item !== null)
    .slice(0, 20);
}

function finiteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function safeTimestamp(value: unknown): string | null {
  const timestamp = stringOf(value);
  return timestamp &&
    timestamp.length <= 64 &&
    !Number.isNaN(Date.parse(timestamp))
    ? timestamp
    : null;
}

function humanizeToken(value: unknown, fallback = "Unverified"): string {
  const token = safeToken(value);
  if (!token) return fallback;
  return token
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function classifiedIssue(raw: unknown): string | null {
  const value = stringOf(raw)?.toLowerCase();
  if (!value) return null;
  if (/credential|auth|unauthor|forbid|\b401\b|\b403\b/.test(value)) {
    return "Provider authentication needs attention. Review the credentials reference without placing secret material in Moosewave.";
  }
  if (/timeout|deadline|timed out/.test(value)) {
    return "The provider did not respond before the verification deadline.";
  }
  if (/rate.?limit|\b429\b/.test(value)) {
    return "The provider rate-limited this request. Retry after its recovery window.";
  }
  if (/network|connect|dns|resolve|unreachable/.test(value)) {
    return "The provider endpoint could not be reached.";
  }
  if (/schema|column|field|constraint|table/.test(value)) {
    return "The configured schema or object scope needs attention.";
  }
  return "The connection reported an issue. Raw provider details are hidden; use the request reference in server logs for investigation.";
}

function normalizeProviderHealth(value: unknown): ProviderHealthView | null {
  const record = recordOf(value);
  if (!record) return null;
  return {
    state: safeEnumToken(record.state, PROVIDER_HEALTH_STATES) ?? "unverified",
    liveState: safeEnumToken(record.live_state, PROVIDER_LIVE_STATES),
    executionMode: safeEnumToken(
      record.execution_mode,
      PROVIDER_EXECUTION_MODES,
    ),
    executable: record.executable === true,
    statementsExecuted: finiteCount(record.statements_executed),
    missingSettings: safeEnumTokens(
      record.missing_required_settings,
      PROVIDER_SETTING_KEYS,
    ),
    warningCount: finiteCount(record.warning_count),
    issue:
      record.issue_present === true
        ? "The provider reported an issue. Raw provider detail remains server-side."
        : null,
  };
}

function normalizeHealth(value: unknown): ConnectionHealthView | null {
  const record = recordOf(value);
  if (!record) return null;
  return {
    status: safeEnumToken(record.status, CONNECTION_STATUSES) ?? "unverified",
    health:
      safeEnumToken(record.health, CONNECTION_HEALTH_STATES) ?? "unverified",
    lastRunStatus: safeEnumToken(record.last_run_status, RUN_STATUSES),
    lastRunAt: safeTimestamp(record.last_run_at),
    providerRuntimeStatus: safeEnumToken(
      record.provider_runtime_status,
      PROVIDER_RUNTIME_STATES,
    ),
    providerDriverAttachment: safeEnumToken(
      record.provider_driver_attachment,
      PROVIDER_DRIVER_ATTACHMENTS,
    ),
    missingSettings: safeEnumTokens(
      record.missing_required_settings,
      PROVIDER_SETTING_KEYS,
    ),
    warningCount: finiteCount(record.warning_count),
    issue:
      record.issue_present === true
        ? "The connection reported an issue. Raw provider detail remains server-side."
        : null,
    providerHealth: normalizeProviderHealth(record.provider_health),
  };
}

function safeOperationFailure(
  action: "Pause" | "Disconnect",
  error: unknown,
): string {
  const record = recordOf(error);
  const status = finiteCount(record?.status);
  const kind = safeToken(record?.kind)?.toLowerCase();
  const issue = classifiedIssue(record?.message);
  const requestId = safeToken(record?.requestId);
  let detail = issue ?? "The server could not complete this request.";
  if (status === 401) detail = "Your session is no longer authorized.";
  else if (status === 403) detail = "Admin access is required for this action.";
  else if (status === 404)
    detail = "The connection no longer exists. Refresh the connection list.";
  else if (status === 409 || status === 412)
    detail =
      "The connection changed on the server. Refresh it before retrying.";
  else if (kind === "network" || kind === "timeout") {
    detail =
      "The service could not be reached. Check the connection and retry.";
  } else if (status >= 500)
    detail = "The warehouse service could not complete the request.";
  return `${action} failed. ${detail}${requestId ? ` Reference: ${requestId}.` : ""}`;
}

function statusTone(status: string): string {
  const value = status.toLowerCase();
  if (
    [
      "active",
      "available",
      "healthy",
      "completed",
      "checked",
      "provider_checked",
    ].includes(value)
  ) {
    return "success";
  }
  if (
    [
      "paused",
      "partial",
      "delegated",
      "running",
      "ready",
      "needs_attention",
    ].includes(value)
  ) {
    return "warning";
  }
  if (["failed", "disconnected", "error", "not_ready"].includes(value)) {
    return "danger";
  }
  return "";
}

function StatusBadge({ value }: { value: string }): ReactElement {
  const tone = statusTone(value);
  return (
    <span className={`badge dp-connection-status${tone ? ` ${tone}` : ""}`}>
      {humanizeToken(value)}
    </span>
  );
}

function TimeValue({ value }: { value: string | null }): ReactElement {
  if (!value) return <span>Not recorded</span>;
  return (
    <time dateTime={value}>
      {fmtDateTime(value)} <span className="muted">({fmtRelative(value)})</span>
    </time>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className="dp-connection-detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ConnectionFacts({
  connection,
  health,
}: {
  connection: WarehouseConnection;
  health: ConnectionHealthView | null;
}): ReactElement {
  const credentialPresent = connection.credential_ref_present === true;
  const objects = safeEnumTokens(
    connection.object_selection,
    WAREHOUSE_OBJECTS,
  );
  const createdAt = safeTimestamp(connection.created_at);
  const updatedAt = safeTimestamp(connection.updated_at);
  const backfill = finiteCount(connection.backfill_days);

  return (
    <dl className="dp-connection-detail-grid">
      <Detail label="Provider">
        {humanizeToken(safeEnumToken(connection.provider, WAREHOUSE_PROVIDERS))}
      </Detail>
      <Detail label="Direction">
        {humanizeToken(
          safeEnumToken(connection.direction, WAREHOUSE_DIRECTIONS),
        )}
      </Detail>
      <Detail label="Cadence">
        {humanizeToken(safeEnumToken(connection.cadence, WAREHOUSE_CADENCES))}
      </Detail>
      <Detail label="Backfill">
        {backfill > 0 ? `${backfill} days` : "No backfill"}
      </Detail>
      <Detail label="Credentials reference">
        {credentialPresent ? "Present (value hidden)" : "Missing"}
      </Detail>
      <Detail label="Provider runtime">
        {humanizeToken(health?.providerRuntimeStatus)}
      </Detail>
      <Detail label="Worker attachment">
        {humanizeToken(health?.providerDriverAttachment)}
      </Detail>
      <Detail label="Created">
        <TimeValue value={createdAt} />
      </Detail>
      <Detail label="Last changed">
        <TimeValue value={updatedAt} />
      </Detail>
      <div className="dp-connection-detail dp-connection-scope">
        <dt>Object scope</dt>
        <dd>
          {objects.length > 0
            ? objects.map((item) => humanizeToken(item)).join(", ")
            : "No verified objects"}
        </dd>
      </div>
    </dl>
  );
}

function HealthSummary({
  health,
}: {
  health: ConnectionHealthView | null;
}): ReactElement {
  if (!health) {
    return (
      <p className="muted dp-connection-loading" role="status">
        Waiting for verified connection health…
      </p>
    );
  }
  return (
    <>
      <div className="dp-connection-health-grid">
        <div className="dp-connection-health-card">
          <span>Saved status</span>
          <StatusBadge value={health.status} />
          <small>Control-plane state, not proof of data movement.</small>
        </div>
        <div className="dp-connection-health-card">
          <span>Connection health</span>
          <StatusBadge value={health.health} />
          <small>Derived from configuration and the latest recorded run.</small>
        </div>
        <div className="dp-connection-health-card">
          <span>Latest run</span>
          {health.lastRunStatus ? (
            <StatusBadge value={health.lastRunStatus} />
          ) : (
            <strong>None recorded</strong>
          )}
          <small>
            <TimeValue value={health.lastRunAt} />
          </small>
        </div>
      </div>
      {health.issue ? (
        <Notice
          className="dp-connection-alert"
          tone="danger"
          announcement="assertive"
        >
          {health.issue}
        </Notice>
      ) : null}
      {health.missingSettings.length > 0 ? (
        <Notice
          className="dp-connection-alert"
          tone="warning"
          announcement="polite"
        >
          <strong>Required settings need attention:</strong>{" "}
          {health.missingSettings.map((item) => humanizeToken(item)).join(", ")}
          .
        </Notice>
      ) : null}
      {health.warningCount > 0 ? (
        <Notice
          className="dp-connection-alert"
          tone="warning"
          announcement="polite"
        >
          The server reported {health.warningCount.toLocaleString()}{" "}
          configuration warning{health.warningCount === 1 ? "" : "s"}. Raw
          provider output is hidden; review the connection settings before
          running production movement.
        </Notice>
      ) : null}
    </>
  );
}

function ProviderVerification({
  health,
  busy,
  unavailable,
  reasonId,
  onVerify,
}: {
  health: ConnectionHealthView | null;
  busy: boolean;
  unavailable: boolean;
  reasonId: string;
  onVerify: () => void;
}): ReactElement {
  const provider = health?.providerHealth ?? null;
  const reason = !health
    ? "Verify connection health before requesting a live provider check."
    : !provider
      ? "This provider does not expose a live verification contract on this server."
      : !provider.executable
        ? "The live check is not executable in the current connection state."
        : "Runs the provider's bounded live health check. Ready means executable; it does not mean executed.";
  return (
    <section
      className="dp-connection-provider-check"
      aria-labelledby={`${reasonId}-title`}
    >
      <div className="dp-connection-provider-check-copy">
        <span className="dp-eyebrow">Provider verification</span>
        <h4 id={`${reasonId}-title`}>
          {provider ? humanizeToken(provider.state) : "Not exposed"}
        </h4>
        <p id={reasonId}>{reason}</p>
        {provider?.liveState ? (
          <p>
            Live state: <strong>{humanizeToken(provider.liveState)}</strong>
          </p>
        ) : null}
        {provider?.executionMode ? (
          <p>
            Execution mode:{" "}
            <strong>{humanizeToken(provider.executionMode)}</strong>
          </p>
        ) : null}
        {provider && provider.statementsExecuted > 0 ? (
          <p>
            {provider.statementsExecuted.toLocaleString()} bounded verification
            statement{provider.statementsExecuted === 1 ? "" : "s"} executed.
          </p>
        ) : null}
        {provider?.missingSettings.length ? (
          <p>
            Missing prerequisites:{" "}
            {provider.missingSettings
              .map((item) => humanizeToken(item))
              .join(", ")}
            .
          </p>
        ) : null}
        {provider?.warningCount ? (
          <p>
            {provider.warningCount.toLocaleString()} provider warning
            {provider.warningCount === 1 ? "" : "s"} recorded; raw provider text
            is hidden.
          </p>
        ) : null}
        {provider?.issue ? (
          <p className="dp-row-issue" role="alert">
            {provider.issue}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-sm dp-connection-verify-button"
        aria-disabled={unavailable || undefined}
        aria-busy={busy || undefined}
        aria-describedby={reasonId}
        onClick={() => {
          if (!unavailable) onVerify();
        }}
      >
        {busy ? "Verifying provider…" : "Verify provider"}
      </button>
    </section>
  );
}

function runCounts(run: WarehouseSyncRun): string {
  const moved = finiteCount(run.rows_exported) + finiteCount(run.rows_imported);
  const failed = finiteCount(run.rows_failed) + finiteCount(run.schema_errors);
  return `${moved.toLocaleString()} moved · ${failed.toLocaleString()} failed`;
}

function runIdentifier(value: unknown): string {
  const id = safeToken(value);
  if (!id) return "Run";
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-5)}` : id;
}

function RecentRuns({
  runs,
}: {
  runs: WarehouseSyncRun[] | null;
}): ReactElement {
  if (runs === null) {
    return (
      <p className="muted dp-connection-loading" role="status">
        Loading recent runs…
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="muted dp-connection-empty">
        No runs have been recorded for this connection.
      </p>
    );
  }
  return (
    <ol
      className="dp-connection-run-list"
      aria-label="Five most recent warehouse runs"
    >
      {runs.slice(0, RECENT_RUN_LIMIT).map((run) => {
        const occurredAt =
          safeTimestamp(run.started_at) ?? safeTimestamp(run.created_at);
        return (
          <li className="dp-connection-run" key={run.id}>
            <div className="dp-connection-run-main">
              <span className="mono">{runIdentifier(run.id)}</span>
              <StatusBadge
                value={safeEnumToken(run.status, RUN_STATUSES) ?? "unverified"}
              />
            </div>
            <div className="dp-connection-run-meta">
              <span>
                {humanizeToken(
                  safeEnumToken(run.direction, WAREHOUSE_DIRECTIONS),
                )}{" "}
                ·{" "}
                {humanizeToken(
                  safeEnumToken(run.run_mode, WAREHOUSE_RUN_MODES),
                )}
              </span>
              <span className="tabular">{runCounts(run)}</span>
              <TimeValue value={occurredAt} />
            </div>
            {run.issue_present ? (
              <p className="dp-row-issue">
                This run recorded an issue. Raw provider detail remains
                server-side.
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ConnectionLifecycleControls({
  connectionName,
  confirmationToken,
  canAdmin,
  hasConnectionId,
  status,
  blocked,
  pauseOpen,
  disconnectOpen,
  mutationBusy,
  actionError,
  adminReasonId,
  headingId,
  onPauseOpen,
  onPauseClose,
  onDisconnectOpen,
  onDisconnectClose,
  onPause,
  onDisconnect,
}: {
  connectionName: string;
  confirmationToken: string;
  canAdmin: boolean;
  hasConnectionId: boolean;
  status: string;
  blocked: boolean;
  pauseOpen: boolean;
  disconnectOpen: boolean;
  mutationBusy: boolean;
  actionError: string | null;
  adminReasonId: string;
  headingId: string;
  onPauseOpen: () => void;
  onPauseClose: () => void;
  onDisconnectOpen: () => void;
  onDisconnectClose: () => void;
  onPause: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}): ReactElement {
  const canPause =
    canAdmin && hasConnectionId && !["paused", "disconnected"].includes(status);
  const canDisconnect =
    canAdmin && hasConnectionId && status !== "disconnected";
  const adminReason = !canAdmin
    ? "Admin access is required to pause or disconnect this warehouse connection."
    : !hasConnectionId
      ? "Lifecycle actions require a saved connection identifier."
      : status === "disconnected"
        ? "This connection is already disconnected. Run and mapping history remain available from retained audit evidence."
        : status === "paused"
          ? "Scheduled runs are paused. This server does not expose a resume operation; disconnect remains available."
          : "Pause stops scheduled runs. Disconnect also blocks new manual runs and mapping changes.";

  return (
    <>
      <section
        className="dp-connection-danger-zone"
        aria-labelledby={`${headingId}-lifecycle`}
      >
        <div>
          <span className="dp-eyebrow">Lifecycle</span>
          <h4 id={`${headingId}-lifecycle`}>Pause or disconnect</h4>
          <p id={adminReasonId}>{adminReason}</p>
        </div>
        <div className="dp-connection-lifecycle-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-disabled={!canPause || blocked || undefined}
            aria-describedby={adminReasonId}
            onClick={() => {
              if (canPause && !blocked) onPauseOpen();
            }}
          >
            {status === "paused" ? "Paused" : "Pause"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            aria-disabled={!canDisconnect || blocked || undefined}
            aria-describedby={adminReasonId}
            onClick={() => {
              if (canDisconnect && !blocked) onDisconnectOpen();
            }}
          >
            Disconnect
          </button>
        </div>
      </section>

      <ConfirmModal
        open={pauseOpen}
        title={`Pause ${connectionName}?`}
        description="Scheduled warehouse runs will stop. Existing connection configuration, mappings, and run evidence remain in place."
        confirmLabel="Pause connection"
        busy={mutationBusy}
        onConfirm={onPause}
        onClose={onPauseClose}
      >
        <div className="dp-connection-confirm-impact">
          <p>
            This server currently exposes no resume operation. Confirm only
            after reviewing how the connection will be restored or replaced.
          </p>
          {actionError ? (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={disconnectOpen}
        title={`Disconnect ${connectionName}?`}
        description="Moosewave will preserve audit evidence while blocking new warehouse work for this connection."
        confirmLabel="Disconnect connection"
        danger
        typeToConfirm={confirmationToken}
        busy={mutationBusy}
        onConfirm={onDisconnect}
        onClose={onDisconnectClose}
      >
        <div className="dp-connection-confirm-impact">
          <p>
            Run and mapping history remains in Moosewave, but scheduled runs,
            manual runs, and mapping changes stop.
          </p>
          <p>
            Provider-side users, roles, grants, stages, storage, and credentials
            are not removed. Complete and record that cleanup separately.
          </p>
          {actionError ? (
            <p className="field-error" role="alert">
              {actionError}
            </p>
          ) : null}
        </div>
      </ConfirmModal>
    </>
  );
}

function ConnectionSafetyNotices({
  connectionIssue,
  hasConnectionId,
}: {
  connectionIssue: string | null;
  hasConnectionId: boolean;
}): ReactElement {
  return (
    <>
      <Notice
        className="dp-connection-truth-note"
        tone="info"
        announcement="off"
      >
        A healthy saved connection does not prove that a live provider check ran
        or that data moved. Verify each signal below before production use.
      </Notice>
      {connectionIssue ? (
        <Notice
          className="dp-connection-alert"
          tone="danger"
          announcement="assertive"
        >
          {connectionIssue}
        </Notice>
      ) : null}
      {!hasConnectionId ? (
        <Notice
          className="dp-connection-alert"
          tone="danger"
          announcement="assertive"
        >
          This connection has no verified server identifier. Health, runs, and
          lifecycle actions are unavailable.
        </Notice>
      ) : null}
    </>
  );
}

export function WarehouseConnectionControl({
  connection,
  canAdmin,
  onConnectionChanged,
  onDisconnected,
}: WarehouseConnectionControlProps): ReactElement {
  const headingId = useId();
  const adminReasonId = useId();
  const providerReasonId = useId();
  const connectionId = stringOf(connection.id) ?? "";
  const connectionName = stringOf(connection.name) ?? "this connection";
  const confirmationToken = stringOf(connection.name) ?? "DISCONNECT";
  const identity = connectionId || `unsaved:${connectionName}`;
  const providerCheckRef = useRef(false);
  const mountedRef = useRef(true);
  const readOperation = useSingleFlightOperation();
  const mutationOperation = useSingleFlightOperation(MUTATION_OPERATION);
  const [readIntent, setReadIntent] = useState<"refresh" | "provider" | null>(
    null,
  );
  const [pauseOpen, setPauseOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const healthResource = useRemoteResource<Record<string, unknown>>(
    async () => {
      const providerCheck = providerCheckRef.current;
      providerCheckRef.current = false;
      if (!connectionId)
        return {
          error: {
            kind: "invalid_config",
            message: "Missing connection identifier",
          },
        };
      const response = await warehouseApi.connectionHealth(
        connectionId,
        providerCheck,
      );
      return response.error
        ? { error: response.error }
        : { data: response.data ?? {} };
    },
    {
      identity: `warehouse-connection-health:${identity}`,
      auto: Boolean(connectionId),
    },
  );
  const runsResource = useRemoteResource<WarehouseSyncRun[]>(
    async () => {
      if (!connectionId)
        return {
          error: {
            kind: "invalid_config",
            message: "Missing connection identifier",
          },
        };
      const response = await warehouseApi.listConnectionRuns(connectionId);
      if (response.error) return { error: response.error };
      const items = Array.isArray(response.data?.items)
        ? response.data.items
        : [];
      return { data: items.slice(0, RECENT_RUN_LIMIT) };
    },
    {
      identity: `warehouse-connection-runs:${identity}`,
      auto: Boolean(connectionId),
    },
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    setPauseOpen(false);
    setDisconnectOpen(false);
    setActionError(null);
    providerCheckRef.current = false;
  }, [identity]);

  const health = normalizeHealth(healthResource.data);
  const connectionIssue = connection.issue_present
    ? "The connection reported an issue. Raw provider detail remains server-side."
    : null;
  const status =
    safeEnumToken(connection.status, CONNECTION_STATUSES) ?? "unverified";
  const readBusy = readOperation.active;
  const mutationBusy = mutationOperation.active;
  const remoteLoading =
    healthResource.transport === "loading" ||
    runsResource.transport === "loading";
  const canPause =
    canAdmin &&
    Boolean(connectionId) &&
    !["paused", "disconnected"].includes(status);
  const canDisconnect =
    canAdmin && Boolean(connectionId) && status !== "disconnected";
  const operationBlocked = readBusy || mutationBusy;
  const interactionBlocked = operationBlocked || remoteLoading;

  const runRead = async (
    intent: "refresh" | "provider",
    task: () => Promise<void>,
  ): Promise<void> => {
    if (mutationOperation.promiseRef.current) return;
    const request = readOperation.run(async () => {
      if (mountedRef.current) setReadIntent(intent);
      try {
        await task();
      } finally {
        if (mountedRef.current) setReadIntent(null);
      }
    });
    if (request) await request;
    else await readOperation.wait();
  };

  const refresh = (): Promise<void> =>
    runRead("refresh", async () => {
      providerCheckRef.current = false;
      await Promise.all([
        healthResource.reloadResult(),
        runsResource.reloadResult(),
      ]);
    });

  const verifyProvider = (): Promise<void> =>
    runRead("provider", async () => {
      providerCheckRef.current = true;
      try {
        await healthResource.reloadResult();
      } finally {
        providerCheckRef.current = false;
      }
    });

  const pause = async (): Promise<void> => {
    if (!canPause || readOperation.promiseRef.current) return;
    const request = mutationOperation.run(async () => {
      try {
        const latest = await warehouseApi.getConnection(connectionId);
        if (
          latest.error ||
          !latest.data ||
          latest.data.version !== connection.version
        ) {
          if (mountedRef.current)
            setActionError(
              latest.error
                ? safeOperationFailure("Pause", latest.error)
                : "The connection changed after this view loaded. Refresh before pausing it.",
            );
          return;
        }
        const response = await warehouseApi.pauseConnection(
          connectionId,
          latest.data.version,
        );
        if (response.error) {
          if (mountedRef.current)
            setActionError(safeOperationFailure("Pause", response.error));
          return;
        }
        if (!mountedRef.current) return;
        setActionError(null);
        setPauseOpen(false);
        const changed = response.data ?? { ...connection, status: "paused" };
        // Publish the accepted server mutation before any follow-up read. The
        // health refresh may be slow and the detail modal may be dismissed in
        // that gap; the parent list must still become truthful immediately.
        onConnectionChanged(changed);
        await healthResource.reloadResult();
      } catch (error) {
        if (mountedRef.current)
          setActionError(safeOperationFailure("Pause", error));
        return;
      }
    });
    if (request) await request;
    else await mutationOperation.wait();
  };

  const disconnect = async (): Promise<void> => {
    if (!canDisconnect || readOperation.promiseRef.current) return;
    const request = mutationOperation.run(async () => {
      let disconnected = false;
      try {
        const latest = await warehouseApi.getConnection(connectionId);
        if (
          latest.error ||
          !latest.data ||
          latest.data.version !== connection.version
        ) {
          if (mountedRef.current)
            setActionError(
              latest.error
                ? safeOperationFailure("Disconnect", latest.error)
                : "The connection changed after this view loaded. Refresh before disconnecting it.",
            );
          return;
        }
        const response = await warehouseApi.deleteConnection(
          connectionId,
          latest.data.version,
          latest.data.name,
        );
        if (response.error) {
          if (mountedRef.current)
            setActionError(safeOperationFailure("Disconnect", response.error));
          return;
        }
        if (!mountedRef.current) return;
        setActionError(null);
        setDisconnectOpen(false);
        disconnected = true;
      } catch (error) {
        if (mountedRef.current)
          setActionError(safeOperationFailure("Disconnect", error));
        return;
      }
      if (mountedRef.current && disconnected) onDisconnected();
    });
    if (request) await request;
    else await mutationOperation.wait();
  };

  return (
    <section className="dp-connection-control" aria-labelledby={headingId}>
      <header className="dp-connection-control-header">
        <div>
          <span className="dp-eyebrow">Connection control</span>
          <h3 id={headingId}>{connectionName}</h3>
          <p>
            Configuration, provider verification, worker attachment, and
            successful movement are independent signals.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-disabled={!connectionId || interactionBlocked || undefined}
          aria-busy={readIntent === "refresh" || remoteLoading || undefined}
          onClick={() => {
            if (connectionId && !interactionBlocked) void refresh();
          }}
        >
          {readIntent === "refresh" ? "Refreshing…" : "Refresh evidence"}
        </button>
      </header>

      <ConnectionSafetyNotices
        connectionIssue={connectionIssue}
        hasConnectionId={Boolean(connectionId)}
      />

      <RemoteDataNotice
        resource={healthResource}
        label="connection health"
        onRetry={() =>
          void runRead("refresh", async () => {
            await healthResource.reloadResult();
          })
        }
      />
      <HealthSummary health={health} />
      <ConnectionFacts connection={connection} health={health} />

      <ProviderVerification
        health={health}
        busy={readIntent === "provider"}
        unavailable={
          !connectionId ||
          !health?.providerHealth?.executable ||
          operationBlocked ||
          healthResource.transport === "loading"
        }
        reasonId={providerReasonId}
        onVerify={() => void verifyProvider()}
      />

      <section
        className="dp-connection-runs"
        aria-labelledby={`${headingId}-runs`}
      >
        <div className="dp-connection-subheader">
          <div>
            <h4 id={`${headingId}-runs`}>Recent runs</h4>
            <p>
              Connection-scoped outcomes. Provider errors, URIs, cursors, and
              rejected row values stay hidden.
            </p>
          </div>
        </div>
        <RemoteDataNotice
          resource={runsResource}
          label="connection runs"
          onRetry={() =>
            void runRead("refresh", async () => {
              await runsResource.reloadResult();
            })
          }
        />
        <RecentRuns runs={runsResource.data} />
      </section>

      <ConnectionLifecycleControls
        connectionName={connectionName}
        confirmationToken={confirmationToken}
        canAdmin={canAdmin}
        hasConnectionId={Boolean(connectionId)}
        status={status}
        blocked={interactionBlocked}
        pauseOpen={pauseOpen}
        disconnectOpen={disconnectOpen}
        mutationBusy={mutationBusy}
        actionError={actionError}
        adminReasonId={adminReasonId}
        headingId={headingId}
        onPauseOpen={() => {
          setActionError(null);
          setPauseOpen(true);
        }}
        onPauseClose={() => {
          setPauseOpen(false);
          setActionError(null);
        }}
        onDisconnectOpen={() => {
          setActionError(null);
          setDisconnectOpen(true);
        }}
        onDisconnectClose={() => {
          setDisconnectOpen(false);
          setActionError(null);
        }}
        onPause={pause}
        onDisconnect={disconnect}
      />
    </section>
  );
}
