/**
 * StreamingExportStatus — SUB-111 read-only status panel for one
 * streaming-export destination (a warehouse_connection with
 * provider="streaming_export").
 *
 * Surfaces, honestly, what the server reports:
 *   - last-shipped-at (newest completed window end)
 *   - current batch size + format/compression
 *   - hourly throughput (rows/second) of the latest completed window
 *   - cumulative rows + bytes exported across the recent run window
 *   - failed-run evidence and bounded cursor continuity, without exposing
 *     provider locations or raw errors
 *
 * Load failures render inline — a 404 means the streaming surface isn't
 * mounted on this server, not "no data". Nothing here ships anything
 * except the explicit operator-triggered retry.
 *
 * Backend: apps/api/internal/streaming_export (GET .../streaming/runs,
 * POST .../streaming/ship).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { Notice } from "../Notice";
import { toast } from "../Toast";
import {
  warehouseApi,
  type StreamingExportConfig,
  type StreamingExportRun,
  type WarehouseConnection,
} from "../../lib/api-client";
import {
  formatBytes,
  runStatusTone,
  streamingConfigOf,
  streamingCumulativeRows,
  streamingThroughput,
} from "./warehouse-helpers";
import { safeDataPlatformFailure } from "./safe-failures";

const RUN_COLS = "150px 100px 1fr 110px 110px 90px";

type StreamingOperation = ReturnType<typeof useSingleFlightOperation>;

interface StreamingStatusController {
  cfg: StreamingExportConfig;
  runs: StreamingExportRun[] | null;
  lastShipped: string | null;
  err: string | null;
  loading: boolean;
  operation: StreamingOperation;
  load: () => Promise<void>;
  shipNow: () => Promise<void>;
}

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: "10px 12px",
        minWidth: 0,
      }}
    >
      <div className="muted" style={{ fontSize: 11 }}>
        {label}
      </div>
      <div style={{ fontWeight: 600, fontSize: 16, marginTop: 2 }}>{value}</div>
      {hint ? (
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function useStreamingStatusController({
  connection,
  onBusyChange,
}: {
  connection: WarehouseConnection;
  onBusyChange?: (busy: boolean) => void;
}): StreamingStatusController {
  const id = connection.id ?? "";
  const cfg = streamingConfigOf(connection);
  const [runs, setRuns] = useState<StreamingExportRun[] | null>(null);
  const [lastShipped, setLastShipped] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(false);
  const loadRequestRef = useRef(0);
  const loadFlightRef = useRef<Promise<void> | null>(null);
  const operation = useSingleFlightOperation({
    ownerId: `streaming-export-ship-${id}`,
    label: "Streaming export shipment",
    detail: "Wait for the streaming shipment to finish before leaving.",
  });

  useEffect(() => {
    onBusyChange?.(operation.active);
  }, [onBusyChange, operation.active]);

  const load = useCallback(async (): Promise<void> => {
    if (!id || loadFlightRef.current) {
      if (loadFlightRef.current) await loadFlightRef.current;
      return;
    }
    const requestId = ++loadRequestRef.current;
    const request = loadStreamingRuns({
      id,
      isCurrent: () =>
        mountedRef.current && requestId === loadRequestRef.current,
      onStart: () => {
        setLoading(true);
        setErr(null);
      },
      onRuns: (nextRuns, nextLastShipped) => {
        setRuns(nextRuns);
        setLastShipped(nextLastShipped);
      },
      onFailure: setErr,
      onSettled: () => setLoading(false),
    });
    loadFlightRef.current = request;
    try {
      await request;
    } finally {
      if (loadFlightRef.current === request) loadFlightRef.current = null;
    }
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadRequestRef.current += 1;
      loadFlightRef.current = null;
    };
  }, [load]);

  const shipNow = async (): Promise<void> => {
    if (!id) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const request = operation.run(async () => {
      try {
        const latest = await warehouseApi.getConnection(id);
        if (latest.error) {
          toast.error({
            message: "Couldn't verify the export",
            detail: safeDataPlatformFailure(
              latest.error,
              "The connection version could not be verified before shipping.",
            ),
          });
          return;
        }
        if (latest.queued || !latest.data) {
          toast.error(
            "You're offline — shipping a window needs a live server.",
          );
          return;
        }
        if (latest.data.version !== connection.version) {
          toast.error(
            "This export changed on the server. Refresh it before shipping.",
          );
          void load();
          return;
        }
        const res = await warehouseApi.shipStreaming(id, latest.data.version);
        if (res.error) {
          toast.error({
            message: "Couldn't ship a window",
            detail: safeDataPlatformFailure(
              res.error,
              "The streaming service could not ship this window.",
            ),
          });
          return;
        }
        if (res.queued) {
          toast.error(
            "You're offline — shipping a window needs a live server.",
          );
          return;
        }
        const run = res.data;
        if (run.status === "failed" || run.issue_present) {
          toast.error({
            message: "Window shipment failed",
            detail:
              "The worker returned issue evidence. Raw provider details and storage locations are hidden.",
          });
          void load();
          return;
        }
        const rows = (run.rows_shipped || 0).toLocaleString();
        toast.success(
          run.status === "empty" || run.rows_shipped === 0
            ? "No due events — the window was empty."
            : `Shipped ${rows} row${run.rows_shipped === 1 ? "" : "s"} (status "${run.status}").`,
        );
        void load();
      } catch (error) {
        toast.error({
          message: "Couldn't ship a window",
          detail: safeDataPlatformFailure(
            error,
            "The shipment request failed.",
          ),
        });
      }
    });
    if (!request) await operation.wait();
  };

  return {
    cfg,
    runs,
    lastShipped,
    err,
    loading,
    operation,
    load,
    shipNow,
  };
}

async function loadStreamingRuns({
  id,
  isCurrent,
  onStart,
  onRuns,
  onFailure,
  onSettled,
}: {
  id: string;
  isCurrent: () => boolean;
  onStart: () => void;
  onRuns: (runs: StreamingExportRun[], lastShipped: string | null) => void;
  onFailure: (message: string) => void;
  onSettled: () => void;
}): Promise<void> {
  onStart();
  try {
    const res = await warehouseApi.listStreamingRuns(id);
    if (!isCurrent()) return;
    if (res.error) {
      onFailure(
        res.error.status === 404
          ? "Streaming export isn't enabled on this Moosewave server."
          : safeDataPlatformFailure(
              res.error,
              "Streaming shipment evidence could not be verified.",
            ),
      );
      return;
    }
    onRuns(res.data?.items ?? [], res.data?.last_shipped_at ?? null);
  } catch (error) {
    if (!isCurrent()) return;
    onFailure(
      safeDataPlatformFailure(
        error,
        "Couldn't reach streaming shipment evidence. Check the connection and retry.",
      ),
    );
  } finally {
    if (isCurrent()) onSettled();
  }
}

export function StreamingExportStatus({
  connection,
  canAdmin,
  onBusyChange,
}: {
  connection: WarehouseConnection;
  canAdmin: boolean;
  onBusyChange?: (busy: boolean) => void;
}): ReactElement {
  const controller = useStreamingStatusController({
    connection,
    onBusyChange,
  });
  const shipDescriptionId = useId();
  const failedWindowHelpId = useId();

  return (
    <div className="dp-streaming-status">
      {controller.err ? <StreamingLoadFailure controller={controller} /> : null}
      {controller.runs === null ? (
        <StreamingInitialState loading={controller.loading} />
      ) : (
        <StreamingEvidence
          controller={controller}
          canAdmin={canAdmin}
          shipDescriptionId={shipDescriptionId}
          failedWindowHelpId={failedWindowHelpId}
        />
      )}
    </div>
  );
}

function StreamingLoadFailure({
  controller,
}: {
  controller: StreamingStatusController;
}): ReactElement {
  return (
    <Notice
      className="dp-notice"
      tone="danger"
      announcement="assertive"
      action={
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={controller.loading || undefined}
          aria-busy={controller.loading || undefined}
          onClick={() => {
            if (!controller.loading) void controller.load();
          }}
        >
          {controller.loading ? "Retrying…" : "Retry status"}
        </button>
      }
    >
      {controller.err}
    </Notice>
  );
}

function StreamingInitialState({
  loading,
}: {
  loading: boolean;
}): ReactElement {
  return loading ? (
    <p className="muted" role="status">
      Loading streaming status…
    </p>
  ) : (
    <p className="muted">
      No verified shipment evidence is available. Retry when the service is
      reachable.
    </p>
  );
}

function StreamingEvidence({
  controller,
  canAdmin,
  shipDescriptionId,
  failedWindowHelpId,
}: {
  controller: StreamingStatusController;
  canAdmin: boolean;
  shipDescriptionId: string;
  failedWindowHelpId: string;
}): ReactElement {
  const runs = controller.runs ?? [];
  const failures = runs.filter(
    (run) => run.status === "failed" || run.issue_present,
  );
  return (
    <>
      {controller.loading ? (
        <Notice tone="info" announcement="polite">
          Refreshing shipment evidence… The last verified window remains
          visible.
        </Notice>
      ) : null}
      <Notice tone="info" announcement="polite">
        Shipments use tenant-bound workspace storage and an overflow-safe,
        versioned cursor. Provider locations and raw worker errors stay hidden.
      </Notice>
      <StreamingStats
        runs={runs}
        failures={failures}
        lastShipped={controller.lastShipped}
        cfg={controller.cfg}
      />
      <StreamingActions
        controller={controller}
        canAdmin={canAdmin}
        shipDescriptionId={shipDescriptionId}
      />
      {runs.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No shipment records were returned. The scheduled worker can create the
          next due window, or an administrator can ship it now.
        </p>
      ) : (
        <StreamingRunList
          runs={runs}
          failures={failures}
          controller={controller}
          canAdmin={canAdmin}
          shipDescriptionId={shipDescriptionId}
          failedWindowHelpId={failedWindowHelpId}
        />
      )}
    </>
  );
}

function StreamingStats({
  runs,
  failures,
  lastShipped,
  cfg,
}: {
  runs: StreamingExportRun[];
  failures: StreamingExportRun[];
  lastShipped: string | null;
  cfg: StreamingExportConfig;
}): ReactElement {
  const latestCompleted = runs.find((run) => run.status === "completed");
  const throughput = latestCompleted ? streamingThroughput(latestCompleted) : 0;
  const cumulative = streamingCumulativeRows(runs);
  const cumulativeBytes = runs.reduce(
    (sum, run) => sum + (run.bytes_shipped || 0),
    0,
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 10,
        marginBottom: 14,
      }}
    >
      <Stat label="Last shipped" value={fmtTime(lastShipped)} />
      <Stat
        label="Throughput"
        value={`${throughput.toLocaleString(undefined, { maximumFractionDigits: 1 })} rows/s`}
        hint="Latest completed window"
      />
      <Stat
        label="Rows in loaded runs"
        value={cumulative.toLocaleString()}
        hint={`${formatBytes(cumulativeBytes)} · latest ${runs.length.toLocaleString()} run${runs.length === 1 ? "" : "s"}`}
      />
      <Stat
        label="Batch"
        value={(cfg.batch_size ?? 0).toLocaleString()}
        hint={`${cfg.format} · ${cfg.compression}`}
      />
      <Stat
        label="Failures in loaded runs"
        value={String(failures.length)}
        hint={
          failures.length > 0
            ? "needs attention"
            : "none in this bounded response"
        }
      />
    </div>
  );
}

function StreamingActions({
  controller,
  canAdmin,
  shipDescriptionId,
}: {
  controller: StreamingStatusController;
  canAdmin: boolean;
  shipDescriptionId: string;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        marginBottom: 10,
      }}
    >
      <span id={shipDescriptionId} className="visually-hidden">
        {controller.operation.active
          ? "A streaming-export shipment is already running."
          : "Ships the next due window as an operator-triggered action."}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled={controller.loading || undefined}
        aria-busy={controller.loading || undefined}
        onClick={() => void controller.load()}
      >
        {controller.loading ? "Refreshing…" : "Refresh"}
      </button>
      {canAdmin ? (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          aria-disabled={controller.operation.active || undefined}
          aria-describedby={shipDescriptionId}
          onClick={() => {
            if (
              controller.operation.active ||
              controller.operation.promiseRef.current
            ) {
              return;
            }
            void controller.shipNow();
          }}
        >
          {controller.operation.active ? "Shipping…" : "Ship next window"}
        </button>
      ) : null}
    </div>
  );
}

function StreamingRunList({
  runs,
  failures,
  controller,
  canAdmin,
  shipDescriptionId,
  failedWindowHelpId,
}: {
  runs: StreamingExportRun[];
  failures: StreamingExportRun[];
  controller: StreamingStatusController;
  canAdmin: boolean;
  shipDescriptionId: string;
  failedWindowHelpId: string;
}): ReactElement {
  return (
    <>
      {failures.length > 0 ? (
        <p
          id={failedWindowHelpId}
          className="muted"
          style={{ fontSize: 11, margin: "0 0 8px" }}
        >
          Failed windows retain their bounded cursor. Shipping again resumes
          from the last committed cursor and does not advance past unverified
          events.
        </p>
      ) : null}
      <div
        className="list dp-data-list dp-streaming-run-list"
        role="table"
        aria-label="Streaming export run evidence"
        aria-colcount={6}
        aria-rowcount={runs.length + 1}
      >
        <div
          className="list-header"
          style={{ gridTemplateColumns: RUN_COLS }}
          role="row"
        >
          <div role="columnheader">Window end</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">Cursor or issue</div>
          <div role="columnheader">Rows</div>
          <div role="columnheader">Bytes</div>
          <div role="columnheader">
            <span className="visually-hidden">Actions</span>
          </div>
        </div>
        {runs.map((run) => (
          <StreamingRunRow
            key={run.id}
            run={run}
            controller={controller}
            canAdmin={canAdmin}
            shipDescriptionId={shipDescriptionId}
            failedWindowHelpId={failedWindowHelpId}
          />
        ))}
      </div>
    </>
  );
}

function StreamingRunRow({
  run,
  controller,
  canAdmin,
  shipDescriptionId,
  failedWindowHelpId,
}: {
  run: StreamingExportRun;
  controller: StreamingStatusController;
  canAdmin: boolean;
  shipDescriptionId: string;
  failedWindowHelpId: string;
}): ReactElement {
  const tone = runStatusTone(run.status);
  const failed = run.status === "failed" || run.issue_present;
  return (
    <div
      className="list-row"
      role="row"
      style={{ gridTemplateColumns: RUN_COLS, cursor: "default" }}
    >
      <div
        role="cell"
        className="muted tabular"
        data-label="Window end"
        style={{ fontSize: 12 }}
      >
        {fmtTime(run.window_end)}
      </div>
      <div role="cell" data-label="Status">
        <span className={`badge${tone === "neutral" ? "" : ` ${tone}`}`}>
          {run.status}
        </span>
      </div>
      <div
        role="cell"
        className={failed ? "dp-row-issue" : "muted"}
        data-label="Cursor / issue"
        style={{ fontSize: 11, overflowWrap: "anywhere" }}
      >
        {failed
          ? "Issue evidence recorded; private details are hidden"
          : `${run.cursor_from.toLocaleString()}–${run.cursor_to.toLocaleString()}${run.has_more ? " · more due" : " · caught up"}`}
      </div>
      <div
        role="cell"
        className="muted tabular"
        data-label="Rows"
        style={{ fontSize: 12 }}
      >
        {(run.rows_shipped || 0).toLocaleString()}
      </div>
      <div
        role="cell"
        className="muted tabular"
        data-label="Bytes"
        style={{ fontSize: 12 }}
      >
        {formatBytes(run.bytes_shipped || 0)}
      </div>
      <div role="cell" data-label="Action" style={{ textAlign: "right" }}>
        {failed && canAdmin ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-disabled={controller.operation.active || undefined}
            aria-describedby={
              controller.operation.active
                ? `${failedWindowHelpId} ${shipDescriptionId}`
                : failedWindowHelpId
            }
            onClick={() => {
              if (
                controller.operation.active ||
                controller.operation.promiseRef.current
              ) {
                return;
              }
              void controller.shipNow();
            }}
          >
            Ship next due
          </button>
        ) : null}
      </div>
    </div>
  );
}
