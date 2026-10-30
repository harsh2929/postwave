import { useId, type ReactElement } from "react";

import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import {
  type WarehouseCatalogResponse,
  type WarehouseConnection,
} from "../../lib/api-client";

import { isStreamingConnection, streamingConfigOf } from "./warehouse-helpers";

const STREAMING_COLS = "1.45fr 0.9fr 0.9fr 0.9fr 1.15fr 130px";

export function connectionIssueSummary(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const value = raw.toLowerCase();
  if (/credential|auth|unauthor|forbid|\b401\b|\b403\b/.test(value)) {
    return "Authentication needs attention. Review the credentials reference.";
  }
  if (/timeout|deadline|timed out/.test(value)) {
    return "The provider did not respond before the verification deadline.";
  }
  if (/network|connect|dns|resolve/.test(value)) {
    return "The provider endpoint could not be reached.";
  }
  if (/schema|column|field|constraint/.test(value)) {
    return "The configured schema or object scope needs attention.";
  }
  return "The connection reported an operator-visible issue. Open Manage for verified details.";
}

export function statusTone(status: string): string {
  if (["active", "available", "completed"].includes(status)) return "success";
  if (["paused", "partial", "delegated", "running"].includes(status)) {
    return "warning";
  }
  if (["failed", "disconnected", "error"].includes(status)) return "danger";
  return "";
}

export function WarehouseReadinessOverview({
  catalog,
  connections,
  loading,
}: {
  catalog: WarehouseCatalogResponse | null;
  connections: WarehouseConnection[] | null;
  loading: boolean;
}): ReactElement {
  const standard = (connections ?? []).filter(
    (connection) => !isStreamingConnection(connection),
  );
  const streaming = (connections ?? []).filter(isStreamingConnection);
  const active = standard.filter(
    (connection) => connection.status === "active",
  ).length;
  const verifiedProviders = (catalog?.providers ?? []).filter(
    (provider) => provider.runtime_status === "available",
  ).length;
  const availableWorkers = (catalog?.workers ?? []).filter(
    (worker) => worker.runtime_status === "available",
  ).length;

  return (
    <section className="dp-warehouse-overview" aria-label="Warehouse readiness">
      <div className="dp-warehouse-overview-copy">
        <span>Runtime truth</span>
        <h3>Configuration, worker availability, and movement are separate.</h3>
        <p>
          A saved connection proves its control-plane contract—not that a
          provider driver has moved data. Runtime badges below come directly
          from this server.
        </p>
      </div>
      <div className="dp-warehouse-metrics">
        <div>
          <span>Connections</span>
          <strong className="tabular">
            {connections === null ? "—" : standard.length.toLocaleString()}
          </strong>
          <small>{active.toLocaleString()} active contracts</small>
        </div>
        <div>
          <span>Streaming</span>
          <strong className="tabular">
            {connections === null ? "—" : streaming.length.toLocaleString()}
          </strong>
          <small>Scheduled batch destinations</small>
        </div>
        <div>
          <span>Runtime-ready</span>
          <strong className="tabular">
            {catalog === null ? "—" : verifiedProviders.toLocaleString()}
          </strong>
          <small>
            {availableWorkers.toLocaleString()} available worker
            {availableWorkers === 1 ? "" : "s"}
          </small>
        </div>
      </div>
      {loading ? (
        <span className="dp-warehouse-verifying" role="status">
          <span aria-hidden="true" /> Verifying control plane…
        </span>
      ) : null}
    </section>
  );
}

export function WarehouseCatalogPanel({
  catalog,
  error,
  loading,
  onRetry,
}: {
  catalog: WarehouseCatalogResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => Promise<void>;
}): ReactElement {
  return (
    <section
      className="dp-warehouse-block"
      aria-label="Warehouse source catalog"
    >
      <SectionHeader
        title="Source catalog"
        description="Server-reported control-plane contracts. Only 'available' confirms an attached runtime; delegated, partial, and planned entries are not equivalent to live movement."
      />
      {error ? (
        <Notice
          className="dp-notice"
          tone="danger"
          announcement="assertive"
          action={
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={loading || undefined}
              aria-busy={loading || undefined}
              onClick={() => {
                if (!loading) void onRetry();
              }}
            >
              {loading ? "Retrying…" : "Retry warehouse overview"}
            </button>
          }
        >
          {error}
        </Notice>
      ) : catalog === null ? (
        <p className="muted" role="status">
          Loading catalog…
        </p>
      ) : (
        <div className="dp-catalog-grid">
          <CatalogRow label="Providers" items={catalog.providers ?? []} />
          <CatalogRow label="Objects" items={catalog.objects ?? []} />
          <CatalogRow
            label="Import targets"
            items={catalog.import_targets ?? []}
          />
          <CatalogRow label="Workers" items={catalog.workers ?? []} />
          <div className="dp-catalog-meta">
            Directions: {(catalog.directions ?? []).join(", ") || "—"} ·
            Cadences: {(catalog.cadences ?? []).join(", ") || "—"} · schema v
            {catalog.schema_version ?? "—"}
          </div>
        </div>
      )}
    </section>
  );
}

export function WarehouseStreamingPanel({
  canAdmin,
  connections,
  connectionsLoaded,
  loading,
  onCreate,
  onOpenStatus,
}: {
  canAdmin: boolean;
  connections: WarehouseConnection[];
  connectionsLoaded: boolean;
  loading: boolean;
  onCreate: () => void;
  onOpenStatus: (connection: WarehouseConnection) => void;
}): ReactElement {
  const createReasonId = useId();
  const createUnavailable = !canAdmin || loading;
  return (
    <section
      className="dp-warehouse-block"
      aria-label="Warehouse streaming exports"
    >
      <SectionHeader
        title="Scheduled streaming export"
        description="Hourly-style subscriber event and profile batches prepared as Parquet or Avro through the configured storage adapter. Destination configuration does not by itself prove delivery."
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            aria-disabled={createUnavailable || undefined}
            aria-describedby={createReasonId}
            onClick={() => {
              if (!createUnavailable) onCreate();
            }}
          >
            + New streaming export
          </button>
        }
      />
      <p
        id={createReasonId}
        className="muted"
        style={{ fontSize: 11, marginTop: -6 }}
      >
        {!canAdmin
          ? "Admin access is required to create a streaming export."
          : loading
            ? "Warehouse connections are still loading."
            : "Exports use tenant-bound workspace storage and failure-safe, overflow-safe shipment cursors."}
      </p>
      {!connectionsLoaded ? (
        <p className="muted" role="status">
          Loading streaming exports…
        </p>
      ) : connections.length === 0 ? (
        <div className="dp-quiet-empty">
          <Icon name="clock" size={21} />
          <div>
            <strong>No scheduled exports yet</strong>
            <p>
              Create a batch destination to prepare subscriber events and
              profile mutations for the active storage adapter.
            </p>
          </div>
          {canAdmin ? (
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={loading || undefined}
              aria-describedby={loading ? createReasonId : undefined}
              onClick={() => {
                if (!loading) onCreate();
              }}
            >
              Create streaming export
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className="list dp-data-list dp-streaming-list"
          role="table"
          aria-label="Scheduled streaming exports"
          aria-colcount={6}
          aria-rowcount={connections.length + 1}
        >
          <div
            className="list-header"
            style={{ gridTemplateColumns: STREAMING_COLS }}
            role="row"
          >
            <div role="columnheader">Name</div>
            <div role="columnheader">Status</div>
            <div role="columnheader">Format</div>
            <div role="columnheader">Interval</div>
            <div role="columnheader">Destination</div>
            <div role="columnheader">
              <span className="visually-hidden">Actions</span>
            </div>
          </div>
          {connections.map((connection) => (
            <WarehouseStreamingRow
              key={connection.id ?? connection.name}
              connection={connection}
              onOpenStatus={onOpenStatus}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WarehouseStreamingRow({
  connection,
  onOpenStatus,
}: {
  connection: WarehouseConnection;
  onOpenStatus: (connection: WarehouseConnection) => void;
}): ReactElement {
  const config = streamingConfigOf(connection);
  const destinationType =
    typeof connection.config?.destination_type === "string"
      ? connection.config.destination_type
      : "storage adapter";
  return (
    <div
      className="list-row"
      role="row"
      style={{
        gridTemplateColumns: STREAMING_COLS,
        cursor: "default",
      }}
    >
      <div role="cell" data-label="Name" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>
          {connection.name}
        </div>
        {connection.issue_present ? (
          <div className="dp-row-issue">
            The connection reported an issue. Raw provider detail remains
            server-side.
          </div>
        ) : null}
      </div>
      <div
        role="cell"
        data-label="Status"
        aria-label={`Status: ${connection.status}`}
      >
        <span
          className={`badge${statusTone(connection.status) ? ` ${statusTone(connection.status)}` : ""}`}
        >
          {connection.status || "unknown"}
        </span>
      </div>
      <div role="cell" className="muted" data-label="Format">
        {config.format} · {config.compression}
      </div>
      <div role="cell" className="muted" data-label="Interval">
        {connection.cadence}
      </div>
      <div
        role="cell"
        className="muted mono"
        data-label="Destination"
        style={{ overflowWrap: "anywhere" }}
      >
        <span>{destinationType}</span>
        <small className="dp-cell-subtext">
          Tenant-bound workspace storage
        </small>
      </div>
      <div role="cell" data-label="Actions" style={{ textAlign: "right" }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={`Open status for ${connection.name}`}
          onClick={() => onOpenStatus(connection)}
        >
          Status
        </button>
      </div>
    </div>
  );
}

function CatalogRow({
  label,
  items,
}: {
  label: string;
  items: Array<{ key: string; label: string; runtime_status: string }>;
}): ReactElement {
  return (
    <div className="dp-catalog-card">
      <strong>{label}</strong>
      {items.length === 0 ? (
        <span className="muted">None reported</span>
      ) : (
        <div className="dp-catalog-items">
          {items.map((item) => (
            <span
              key={item.key}
              className="dp-catalog-item"
              data-runtime={item.runtime_status}
              aria-label={`${item.label}: ${item.runtime_status}`}
            >
              <span>{item.label}</span>
              <small>{item.runtime_status}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
