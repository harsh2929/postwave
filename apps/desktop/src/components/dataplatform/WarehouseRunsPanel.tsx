/** Verified tenant-wide warehouse runs and privacy-bounded error evidence. */

import { type ReactElement, useMemo, useRef, useState } from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { type WarehouseSyncRun, warehouseApi } from "../../lib/api-client";
import { fmtDateTime, fmtRelative } from "../../lib/format-date";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { RemoteDataNotice } from "../RemoteDataNotice";
import { SectionHeader } from "../SectionHeader";
import {
  runErrorColumns,
  runRowCounts,
  runStatusTone,
} from "./warehouse-helpers";

const RUN_COLS = "120px 120px 110px 1.15fr 1fr 1.2fr 118px";
const SAFE_ERROR_COLUMNS = new Set([
  "row",
  "row_number",
  "line",
  "source_object",
  "field",
  "code",
  "error_code",
  "message",
  "error_message",
  "error",
]);

const SAFE_SOURCE_OBJECTS: Readonly<Record<string, string>> = {
  profiles: "profiles",
  subscribers: "subscribers",
  events: "events",
  metrics: "metrics",
  campaigns: "campaigns",
  flows: "flows",
  forms: "forms",
  catalog: "catalog",
  custom_objects: "custom_objects",
  reviews: "reviews",
  orders: "orders",
  customers: "customers",
  products: "products",
  commerce_orders: "commerce_orders",
};

const SAFE_ERROR_FIELDS: Readonly<Record<string, string>> = {
  email: "email",
  subscriber_id: "subscriber_id",
  event_name: "event_name",
  occurred_at: "occurred_at",
  properties: "properties",
  source_object: "source_object",
};

const SAFE_ERROR_CODES: Readonly<Record<string, string>> = {
  parse_failed: "parse_failed",
  missing_event_name: "missing_event_name",
  subscriber_not_found: "subscriber_not_found",
  invalid_event_name: "invalid_event_name",
  insert_failed: "insert_failed",
  property_type_record_failed: "property_type_record_failed",
  schema_invalid: "schema_invalid",
  schema_validation_failed: "schema_validation_failed",
  type_mismatch: "type_mismatch",
  required: "required",
};

const MAX_SAFE_ROW_REFERENCE = 1_000_000_000;

function classifiedRunFailure(raw: string | undefined): string {
  const value = raw?.toLowerCase() ?? "";
  if (/timeout|deadline|timed out/.test(value)) {
    return "The warehouse service did not respond before the deadline.";
  }
  if (/\b(?:401|403)\b|unauthor|forbid|credential|authentication/.test(value)) {
    return "The warehouse rejected the configured authentication.";
  }
  if (/schema|column|field|type|constraint/.test(value)) {
    return "The warehouse rejected one or more rows against its schema.";
  }
  if (/rate.?limit|\b429\b/.test(value)) {
    return "The warehouse rate-limited this run.";
  }
  if (/network|connect|dns|resolve/.test(value)) {
    return "The warehouse service could not be reached.";
  }
  return raw
    ? "The warehouse did not confirm this run."
    : "No run-level failure was recorded.";
}

function publicRunFailure(run: WarehouseSyncRun): string {
  if (run.schema_errors > 0) {
    return "The warehouse rejected one or more rows against its schema.";
  }
  if (run.rows_failed > 0) {
    return "One or more rows failed without exposing rejected values.";
  }
  return run.issue_present
    ? "The warehouse did not confirm this run."
    : "No run-level failure was recorded.";
}

function safeRowReference(value: unknown): string {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{1,10}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_SAFE_ROW_REFERENCE
    ? String(parsed)
    : "Not safely displayable";
}

function safeMappedValue(
  value: unknown,
  allowed: Readonly<Record<string, string>>,
  fallback: string,
): string {
  if (typeof value !== "string" || value.length > 64) return fallback;
  return Object.hasOwn(allowed, value) ? allowed[value]! : fallback;
}

function safeErrorCell(column: string, value: unknown): string {
  switch (column) {
    case "row":
    case "row_number":
    case "line":
      return safeRowReference(value);
    case "source_object":
      return safeMappedValue(
        value,
        SAFE_SOURCE_OBJECTS,
        "Unrecognized source object",
      );
    case "field":
      return safeMappedValue(value, SAFE_ERROR_FIELDS, "Unrecognized field");
    case "code":
    case "error_code":
      return safeMappedValue(
        value,
        SAFE_ERROR_CODES,
        "Unrecognized error category",
      );
    case "message":
    case "error_message":
    case "error":
      return classifiedRunFailure(
        typeof value === "string" ? value : undefined,
      );
    default:
      return "Not safely displayable";
  }
}

function runDuration(run: WarehouseSyncRun): string {
  if (!run.started_at || !run.completed_at) {
    return run.status === "running" ? "In progress" : "Not recorded";
  }
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "Not recorded";
  }
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function WarehouseRunsPanel({
  refreshToken,
}: {
  refreshToken: number;
}): ReactElement {
  const [errorsFor, setErrorsFor] = useState<WarehouseSyncRun | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const manualRefreshRef = useRef<Promise<void> | null>(null);
  const runsResource = useRemoteResource<WarehouseSyncRun[]>(
    async () => {
      const response = await warehouseApi.listRuns();
      return response.error
        ? { error: response.error }
        : { data: response.data?.items ?? [] };
    },
    { identity: `warehouse-runs:${refreshToken}` },
  );
  const runs = runsResource.data;
  const loading = runsResource.transport === "loading";
  const statusOptions = useMemo(
    () =>
      Array.from(new Set((runs ?? []).map((run) => run.status))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [runs],
  );
  const visibleRuns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (runs ?? []).filter((run) => {
      if (statusFilter !== "all" && run.status !== statusFilter) return false;
      if (!needle) return true;
      return [run.id, run.connection_id, run.direction, run.run_mode]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [query, runs, statusFilter]);
  const failedRuns = (runs ?? []).filter(
    (run) =>
      run.status === "failed" || run.rows_failed > 0 || run.issue_present,
  ).length;
  const runningRuns = (runs ?? []).filter(
    (run) => run.status === "running" || run.status === "queued",
  ).length;

  const refresh = async (): Promise<void> => {
    if (manualRefreshRef.current) {
      await manualRefreshRef.current;
      return;
    }
    let tracked: Promise<void>;
    tracked = runsResource.reload().finally(() => {
      if (manualRefreshRef.current === tracked) manualRefreshRef.current = null;
    });
    manualRefreshRef.current = tracked;
    await tracked;
  };

  return (
    <section
      className="warehouse-runs-panel dp-warehouse-block"
      aria-label="Warehouse sync runs"
    >
      <SectionHeader
        title="Sync runs"
        description="The latest server-bounded page across warehouse connections. Failure categories and support IDs are shown without exposing rejected row values or raw provider responses."
        actions={
          <button
            type="button"
            className="btn btn-sm pw-discoverable-unavailable"
            aria-disabled={loading || undefined}
            aria-busy={loading || undefined}
            onClick={() => {
              if (!loading) void refresh();
            }}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      <RemoteDataNotice
        resource={runsResource}
        label="warehouse runs"
        onRetry={() => void refresh()}
      />
      {runs !== null ? (
        <div className="dp-operation-strip" aria-label="Warehouse run summary">
          <div>
            <span>Loaded runs</span>
            <strong className="tabular">{runs.length.toLocaleString()}</strong>
            <small>Latest server-bounded page</small>
          </div>
          <div>
            <span>In progress</span>
            <strong className="tabular">{runningRuns.toLocaleString()}</strong>
            <small>Queued or running</small>
          </div>
          <div data-tone={failedRuns > 0 ? "warning" : undefined}>
            <span>Needs attention</span>
            <strong className="tabular">{failedRuns.toLocaleString()}</strong>
            <small>Failed run or rejected rows</small>
          </div>
        </div>
      ) : null}
      {runs === null && loading ? (
        <p className="muted" role="status" aria-busy="true">
          Verifying warehouse runs…
        </p>
      ) : runs === null ? null : runs.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No runs were returned in the latest server response. Review an active
          warehouse connection to start an inline run.
        </p>
      ) : (
        <div className="dp-run-directory">
          <div className="dp-run-filters" aria-label="Filter warehouse runs">
            <label>
              <span>Find a run</span>
              <input
                type="search"
                placeholder="Run or connection ID"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <span className="dp-run-result-count" role="status">
              {visibleRuns.length.toLocaleString()} of{" "}
              {runs.length.toLocaleString()} loaded
            </span>
          </div>
          {visibleRuns.length === 0 ? (
            <div className="dp-quiet-empty">
              <div>
                <strong>No runs match these filters</strong>
                <p>Clear the search or choose another status.</p>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setQuery("");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div
              className="list dp-data-list dp-run-list"
              role="table"
              aria-label="Loaded warehouse sync runs"
              aria-colcount={7}
              aria-rowcount={visibleRuns.length + 1}
            >
              <div
                className="list-header"
                style={{ gridTemplateColumns: RUN_COLS }}
                role="row"
              >
                <div role="columnheader">Run ID</div>
                <div role="columnheader">Connection</div>
                <div role="columnheader">Status</div>
                <div role="columnheader">Rows</div>
                <div role="columnheader">Scope</div>
                <div role="columnheader">Timing</div>
                <div role="columnheader">
                  <span className="visually-hidden">Run actions</span>
                </div>
              </div>
              {visibleRuns.map((run) => {
                const tone = runStatusTone(run.status);
                return (
                  <div
                    key={run.id}
                    className="list-row"
                    role="row"
                    style={{ gridTemplateColumns: RUN_COLS, cursor: "default" }}
                  >
                    <div
                      role="cell"
                      className="mono muted"
                      data-label="Run ID"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {run.id}
                    </div>
                    <div
                      role="cell"
                      className="mono muted"
                      data-label="Connection"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {run.connection_id || "Not recorded"}
                    </div>
                    <div role="cell" data-label="Status">
                      <span
                        className={`badge${tone === "neutral" ? "" : ` ${tone}`}`}
                      >
                        {run.status}
                      </span>
                      {run.issue_present ||
                      run.rows_failed > 0 ||
                      run.schema_errors > 0 ? (
                        <div
                          style={{
                            color: "var(--pw-danger)",
                            fontSize: 11,
                            overflowWrap: "anywhere",
                            marginTop: 3,
                          }}
                        >
                          {publicRunFailure(run)}
                        </div>
                      ) : null}
                    </div>
                    <div
                      role="cell"
                      className="muted tabular"
                      data-label="Rows"
                    >
                      {runRowCounts(run)}
                    </div>
                    <div role="cell" className="muted" data-label="Scope">
                      <span>
                        {run.direction} · {run.run_mode}
                      </span>
                      <small className="dp-cell-subtext">
                        {(run.object_selection ?? []).join(", ") ||
                          "No objects recorded"}
                      </small>
                    </div>
                    <div
                      role="cell"
                      className="muted tabular"
                      data-label="Timing"
                    >
                      {run.started_at ? (
                        <time dateTime={run.started_at}>
                          {fmtDateTime(run.started_at)}{" "}
                          <span className="muted">
                            ({fmtRelative(run.started_at)})
                          </span>
                        </time>
                      ) : (
                        "Not recorded"
                      )}
                      <small className="dp-cell-subtext">
                        {runDuration(run)} · {run.retry_count || 0} retries
                      </small>
                    </div>
                    <div
                      role="cell"
                      data-label="Actions"
                      style={{ textAlign: "right" }}
                    >
                      {run.rows_failed > 0 ||
                      run.schema_errors > 0 ||
                      run.issue_present ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          aria-label={`View error evidence for run ${run.id}`}
                          onClick={() => setErrorsFor(run)}
                        >
                          Error evidence
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {errorsFor ? (
        <RunErrorsModal run={errorsFor} onClose={() => setErrorsFor(null)} />
      ) : null}
    </section>
  );
}

function RunErrorsModal({
  run,
  onClose,
}: {
  run: WarehouseSyncRun;
  onClose: () => void;
}): ReactElement {
  const errorsResource = useRemoteResource<Array<Record<string, unknown>>>(
    async () => {
      const response = await warehouseApi.listRunErrors(run.id);
      return response.error
        ? { error: response.error }
        : { data: response.data?.items ?? [] };
    },
    { identity: `warehouse-run-errors:${run.id}` },
  );
  const rows = errorsResource.data;
  const loading = errorsResource.transport === "loading";
  const columns =
    rows && rows.length > 0
      ? runErrorColumns(rows).filter((column) => SAFE_ERROR_COLUMNS.has(column))
      : [];

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Warehouse run error evidence"
      description={`Run ${run.id} · ${run.rows_failed.toLocaleString()} failed rows · ${run.schema_errors.toLocaleString()} schema errors. Raw rejected values and provider responses are not displayed.`}
    >
      {run.issue_present || run.rows_failed > 0 || run.schema_errors > 0 ? (
        <Notice tone="warning" announcement="polite">
          <strong>Run-level category:</strong> {publicRunFailure(run)}
        </Notice>
      ) : null}
      <RemoteDataNotice
        resource={errorsResource}
        label="warehouse run-error evidence"
        onRetry={() => {
          if (!loading) void errorsResource.reload();
        }}
      />
      {rows === null && loading ? (
        <p className="muted" role="status" aria-busy="true">
          Verifying privacy-bounded error evidence…
        </p>
      ) : rows === null ? null : rows.length === 0 || columns.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No safely displayable per-row error evidence was retained. Use run ID{" "}
          <code>{run.id}</code> for support correlation.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" style={{ width: "100%" }}>
            <caption>
              Privacy-bounded error evidence for warehouse run {run.id}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column} scope="col">
                    {column.replaceAll("_", " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="mono"
                      style={{
                        fontSize: 11,
                        maxWidth: 280,
                        overflowWrap: "anywhere",
                        whiteSpace: "normal",
                      }}
                    >
                      {safeErrorCell(column, row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
