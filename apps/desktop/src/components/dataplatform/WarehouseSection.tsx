/**
 * Data Platform → Warehouse section (#35).
 *
 * - Source-type catalog (providers / objects / import targets with
 *   runtime_status badges — "planned" entries say so honestly).
 * - Connections: list, create (server-side validate via POST
 *   /warehouse/validate BEFORE save; errors + warnings rendered; the
 *   create 400's body IS the validation result and is recovered into
 *   the same panel), detail modal with per-source-object import
 *   mappings (GET/PUT).
 * - Runs: explicit inline-execution review (the server returns 202 only after
 *   work), a bounded tenant-wide run page, and privacy-classified evidence.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { HeroEmptyState } from "../HeroEmptyState";
import { Modal, ModalFooter } from "../Modal";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { StreamingExportForm } from "./StreamingExportForm";
import { StreamingExportStatus } from "./StreamingExportStatus";
import { WarehouseConnectionControl } from "./WarehouseConnectionControl";
import {
  statusTone,
  WarehouseCatalogPanel,
  WarehouseReadinessOverview,
  WarehouseStreamingPanel,
} from "./WarehousePresentationPanels";
import { WarehouseProviderFields } from "./WarehouseProviderFields";
import { WarehouseRunsPanel } from "./WarehouseRunsPanel";
import {
  type WarehouseCatalogResponse,
  type WarehouseConnection,
  type WarehouseImportMapping,
  type WarehouseProviderSpec,
  type WarehouseValidationResult,
  warehouseApi,
} from "../../lib/api-client";
import { HERO } from "../../lib/heroAssets";
import { useCapabilityReporter } from "../../lib/capability-observations";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { useRemoteResource } from "../../hooks/useRemoteResource";
import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";

import {
  type ConnectionDraft,
  type MappingDraft,
  connectionDraftErrors,
  connectionDraftToInput,
  emptyConnectionDraft,
  extractWarehouseValidation,
  mappingDraftErrors,
  mappingDraftFrom,
  mappingDraftToInput,
  isStreamingConnection,
  runQueuedMessage,
  toggleSelection,
} from "./warehouse-helpers";
import { safeDataPlatformFailure } from "./safe-failures";

const CONNECTION_COLS = "1.35fr 1fr 100px 100px 100px 1.15fr 176px";

interface WarehouseOverviewController {
  catalog: WarehouseCatalogResponse | null;
  catalogErr: string | null;
  connections: WarehouseConnection[] | null;
  connErr: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

function useWarehouseOverview(): WarehouseOverviewController {
  const catalogCapability = useCapabilityReporter(
    "dataPlatform",
    "warehouse-catalog",
  );
  const connectionsCapability = useCapabilityReporter(
    "dataPlatform",
    "warehouse-connections",
  );
  const [catalog, setCatalog] = useState<WarehouseCatalogResponse | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [connections, setConnections] = useState<WarehouseConnection[] | null>(
    null,
  );
  const [connErr, setConnErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(false);
  const reloadFlightRef = useRef<Promise<void> | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (reloadFlightRef.current) return reloadFlightRef.current;
    const request = (async (): Promise<void> => {
      if (mountedRef.current) setLoading(true);
      const [catalogResult, connectionsResult] = await Promise.allSettled([
        Promise.resolve().then(() => warehouseApi.catalog()),
        Promise.resolve().then(() => warehouseApi.listConnections()),
      ]);
      if (!mountedRef.current) return;

      if (catalogResult.status === "rejected") {
        setCatalogErr(
          "Couldn't reach the warehouse catalog. Check the connection and retry.",
        );
        setCatalog(null);
      } else {
        const cat = catalogResult.value;
        if (cat.error) {
          catalogCapability.fromApiError(cat.error, {
            endpointAbsenceMeansNotConfigured: true,
            impact: "partial",
          });
          setCatalogErr(
            cat.error.status === 404 || cat.error.status === 405
              ? "Warehouse sync isn't enabled on this Moosewave server."
              : "The warehouse catalog could not be verified. Retry to check again.",
          );
          setCatalog(null);
        } else {
          catalogCapability.available();
          setCatalogErr(null);
          setCatalog(cat.data ?? null);
        }
      }

      if (connectionsResult.status === "rejected") {
        setConnErr(
          "Couldn't reach warehouse connections. Check the connection and retry.",
        );
        setConnections([]);
      } else {
        const conns = connectionsResult.value;
        if (conns.error) {
          connectionsCapability.fromApiError(conns.error, {
            endpointAbsenceMeansNotConfigured: true,
            impact: "partial",
          });
          setConnErr(
            "Warehouse connections could not be verified. Retry to check again.",
          );
          setConnections([]);
        } else {
          connectionsCapability.available();
          setConnErr(null);
          setConnections(conns.data?.items ?? []);
        }
      }
    })();
    reloadFlightRef.current = request;
    try {
      await request;
    } finally {
      if (reloadFlightRef.current === request) reloadFlightRef.current = null;
      if (mountedRef.current) setLoading(false);
    }
  }, [
    catalogCapability.available,
    catalogCapability.fromApiError,
    connectionsCapability.available,
    connectionsCapability.fromApiError,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => {
      mountedRef.current = false;
    };
  }, [reload]);

  return { catalog, catalogErr, connections, connErr, loading, reload };
}

export function WarehouseSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const {
    catalog,
    catalogErr,
    connections,
    connErr,
    loading: overviewLoading,
    reload: load,
  } = useWarehouseOverview();
  const [createOpen, setCreateOpen] = useState(false);
  const [streamingOpen, setStreamingOpen] = useState(false);
  const [streamingDetail, setStreamingDetail] =
    useState<WarehouseConnection | null>(null);
  const [streamingStatusBusy, setStreamingStatusBusy] = useState(false);
  const [detail, setDetail] = useState<WarehouseConnection | null>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const connectionsFallbackRef = useRef<HTMLButtonElement | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    connection: WarehouseConnection;
    runtimeStatus: string;
  } | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runsRefresh, setRunsRefresh] = useState(0);
  const runOperation = useSingleFlightOperation({
    ownerId: "warehouse-run-action",
    label: "Warehouse run operation",
    detail: "Wait for the warehouse run request to finish before leaving.",
  });

  const runNow = async (c: WarehouseConnection): Promise<void> => {
    if (!c.id) return;
    const targetId = c.id;
    const request = runOperation.run(async (): Promise<boolean> => {
      setRunningId(targetId);
      try {
        const latest = await warehouseApi.getConnection(targetId);
        if (latest.error || !latest.data) {
          toast.error({
            message: "Run did not start",
            detail: safeDataPlatformFailure(
              latest.error,
              "The exact connection version could not be rechecked.",
            ),
          });
          return false;
        }
        if (latest.data.version !== c.version) {
          toast.error(
            "This connection changed after it was loaded. Refresh and review it before running.",
          );
          return false;
        }
        const res = await warehouseApi.runConnection(
          targetId,
          latest.data.version,
        );
        if (res.error) {
          toast.error({
            message: "Run failed to start",
            detail: safeDataPlatformFailure(
              res.error,
              "The warehouse service could not start this run.",
            ),
          });
          return false;
        }
        if (res.queued) {
          toast.error("You're offline — warehouse runs need a live server.");
          return false;
        }
        // The handler returns HTTP 202 only after performing work inline.
        toast.success(runQueuedMessage(res.data));
        return true;
      } catch (error) {
        toast.error({
          message: "Run failed to start",
          detail: safeDataPlatformFailure(
            error,
            "The warehouse run request failed.",
          ),
        });
        return false;
      } finally {
        setRunningId(null);
      }
    });
    const accepted = request ? await request : false;
    if (accepted) setRunsRefresh((n) => n + 1);
  };

  // Streaming-export destinations (SUB-111) live in their own card; keep
  // them out of the generic connections grid so the two surfaces don't mix.
  const streamingConnections = (connections ?? []).filter(
    isStreamingConnection,
  );
  const standardConnections = (connections ?? []).filter(
    (c) => !isStreamingConnection(c),
  );

  return (
    <div className="dp-section dp-warehouse">
      <WarehouseReadinessOverview
        catalog={catalog}
        connections={connections}
        loading={overviewLoading}
      />
      <WarehouseCatalogPanel
        catalog={catalog}
        error={catalogErr}
        loading={overviewLoading}
        onRetry={load}
      />
      <WarehouseConnectionsPanel
        canAdmin={canAdmin}
        catalog={catalog}
        createButtonRef={connectionsFallbackRef}
        connections={standardConnections}
        connectionsLoaded={connections !== null}
        error={connErr}
        loading={overviewLoading}
        runBusy={runOperation.active}
        runningId={runningId}
        onCreate={() => setCreateOpen(true)}
        onOpenMappings={(connection, trigger) => {
          detailTriggerRef.current = trigger;
          setDetail(connection);
        }}
        onRetry={load}
        onRun={(connection, runtimeStatus) =>
          setPendingRun({ connection, runtimeStatus })
        }
      />
      <WarehouseStreamingPanel
        canAdmin={canAdmin}
        connections={streamingConnections}
        connectionsLoaded={connections !== null}
        loading={overviewLoading}
        onCreate={() => setStreamingOpen(true)}
        onOpenStatus={setStreamingDetail}
      />

      <WarehouseRunsPanel refreshToken={runsRefresh} />

      <WarehouseDialogs
        catalog={catalog}
        canAdmin={canAdmin}
        createOpen={createOpen}
        streamingOpen={streamingOpen}
        streamingDetail={streamingDetail}
        streamingStatusBusy={streamingStatusBusy}
        detail={detail}
        detailReturnFocusRef={detailTriggerRef}
        reload={load}
        onCreateClose={() => setCreateOpen(false)}
        onStreamingClose={() => setStreamingOpen(false)}
        onStreamingDetailClose={() => setStreamingDetail(null)}
        onStreamingBusyChange={setStreamingStatusBusy}
        onDetailClose={() => setDetail(null)}
        onDetailChange={(connection) => {
          setDetail(connection);
          void load();
        }}
        onDetailDisconnected={() => {
          detailTriggerRef.current = connectionsFallbackRef.current;
          setDetail(null);
          void load();
        }}
      />
      <ConfirmModal
        open={pendingRun !== null}
        title={`Run ${pendingRun?.connection.name ?? "warehouse connection"}?`}
        description={
          pendingRun
            ? `This request executes inline before the HTTP 202 response returns. Scope: ${pendingRun.connection.direction} · ${(pendingRun.connection.object_selection ?? []).join(", ") || "no objects"} · ${pendingRun.connection.backfill_days || 0} backfill days. Provider runtime is “${pendingRun.runtimeStatus}”; non-available runtimes may stop at a manifest or storage handoff.`
            : ""
        }
        confirmLabel="Run now"
        busy={runOperation.active}
        onConfirm={() => {
          if (!pendingRun || runOperation.active) return;
          const connection = pendingRun.connection;
          setPendingRun(null);
          void runNow(connection);
        }}
        onClose={() => {
          if (!runOperation.active) setPendingRun(null);
        }}
      />
    </div>
  );
}

function WarehouseConnectionsPanel({
  canAdmin,
  catalog,
  createButtonRef,
  connections,
  connectionsLoaded,
  error,
  loading,
  runBusy,
  runningId,
  onCreate,
  onOpenMappings,
  onRetry,
  onRun,
}: {
  canAdmin: boolean;
  catalog: WarehouseCatalogResponse | null;
  createButtonRef: RefObject<HTMLButtonElement | null>;
  connections: WarehouseConnection[];
  connectionsLoaded: boolean;
  error: string | null;
  loading: boolean;
  runBusy: boolean;
  runningId: string | null;
  onCreate: () => void;
  onOpenMappings: (
    connection: WarehouseConnection,
    trigger: HTMLButtonElement,
  ) => void;
  onRetry: () => Promise<void>;
  onRun: (connection: WarehouseConnection, runtimeStatus: string) => void;
}): ReactElement {
  const createReasonId = useId();
  const runReasonId = useId();
  const canCreate = canAdmin && catalog !== null && !loading;
  return (
    <section className="dp-warehouse-block" aria-label="Warehouse connections">
      <SectionHeader
        title="Connections"
        description="Saved data-movement contracts. Check each provider runtime and connection status before queuing work; non-available providers may record manifests without direct loading."
        actions={
          <button
            ref={createButtonRef}
            type="button"
            className="btn btn-sm btn-primary"
            aria-disabled={!canCreate || undefined}
            aria-describedby={createReasonId}
            onClick={() => {
              if (canCreate) onCreate();
            }}
          >
            + New connection
          </button>
        }
      />
      <p
        id={createReasonId}
        className="muted"
        style={{ fontSize: 11, marginTop: -6 }}
      >
        {!canAdmin
          ? "Admin access is required to create warehouse connections."
          : loading
            ? "Wait for the warehouse catalog to finish loading."
            : !catalog
              ? "A verified warehouse catalog is required before a connection can be created."
              : "New connections are validated by the server before they are saved."}
      </p>
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
              {loading ? "Retrying…" : "Retry connections"}
            </button>
          }
        >
          Couldn&apos;t verify connections: {error}
        </Notice>
      ) : null}
      {!connectionsLoaded ? (
        <p className="muted" role="status">
          Loading connections…
        </p>
      ) : connections.length === 0 && error ? (
        <div className="list-empty">
          <div className="empty-state">
            <div className="empty-state-icon" aria-hidden="true">
              ·
            </div>
            <h3>No verified connections</h3>
            <p>Retry when the warehouse service is reachable.</p>
          </div>
        </div>
      ) : connections.length === 0 ? (
        <HeroEmptyState
          tone="sand"
          eyebrow="Data platform"
          title="Warehouse manifests without guesswork."
          subtitle="Prepare governed export or import contracts, then verify the provider runtime before expecting direct movement. Delegated and partial providers may stop at manifest or storage handoff."
          imageSrc={HERO.migrations}
          imageAlt="Moving boxes representing data in transit"
          primaryCta={
            canCreate
              ? { label: "New connection", onClick: onCreate }
              : undefined
          }
          meta="Connections are validated server-side before they save — credentials stay in your secrets manager via a credentials reference."
        />
      ) : (
        <div
          className="list dp-data-list dp-connection-list"
          role="list"
          aria-label="Warehouse connections"
        >
          <div
            className="list-header"
            style={{ gridTemplateColumns: CONNECTION_COLS }}
            aria-hidden="true"
          >
            <div>Name</div>
            <div>Provider</div>
            <div>Direction</div>
            <div>Cadence</div>
            <div>Status</div>
            <div>Objects</div>
            <div></div>
          </div>
          {connections.map((connection) => (
            <WarehouseConnectionRow
              key={connection.id ?? connection.name}
              canAdmin={canAdmin}
              connection={connection}
              providerRuntimeStatus={
                catalog?.providers?.find(
                  (provider) => provider.key === connection.provider,
                )?.runtime_status ?? "unverified"
              }
              runBusy={runBusy}
              running={runningId === connection.id}
              runReasonId={runReasonId}
              onOpenMappings={onOpenMappings}
              onRun={onRun}
            />
          ))}
        </div>
      )}
      <p
        id={runReasonId}
        className="muted"
        role={runBusy ? "status" : undefined}
        style={{ fontSize: 11, marginTop: 6 }}
      >
        {!canAdmin
          ? "Admin access is required to queue warehouse runs."
          : runBusy
            ? "The live warehouse request is executing inline; other run controls are temporarily unavailable."
            : "Run now waits for inline server execution. Although the endpoint answers HTTP 202, this build is not a background queue."}
      </p>
    </section>
  );
}

function WarehouseConnectionRow({
  canAdmin,
  connection,
  providerRuntimeStatus,
  runBusy,
  running,
  runReasonId,
  onOpenMappings,
  onRun,
}: {
  canAdmin: boolean;
  connection: WarehouseConnection;
  providerRuntimeStatus: string;
  runBusy: boolean;
  running: boolean;
  runReasonId: string;
  onOpenMappings: (
    connection: WarehouseConnection,
    trigger: HTMLButtonElement,
  ) => void;
  onRun: (connection: WarehouseConnection, runtimeStatus: string) => void;
}): ReactElement {
  const connectionRunReasonId = useId();
  const runUnavailable =
    !canAdmin || runBusy || !connection.id || connection.status !== "active";
  return (
    <div
      className="list-row"
      role="listitem"
      style={{ gridTemplateColumns: CONNECTION_COLS }}
    >
      <div data-label="Name" style={{ minWidth: 0 }}>
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
        className="muted"
        data-label="Provider"
        aria-label={`Provider: ${connection.provider}; runtime: ${providerRuntimeStatus}`}
      >
        <span>{connection.provider}</span>
        <small className="dp-cell-subtext">
          {providerRuntimeStatus} runtime
        </small>
      </div>
      <div
        className="muted"
        data-label="Direction"
        aria-label={`Direction: ${connection.direction}`}
      >
        {connection.direction}
      </div>
      <div
        className="muted"
        data-label="Cadence"
        aria-label={`Cadence: ${connection.cadence}`}
      >
        {connection.cadence}
      </div>
      <div data-label="Status" aria-label={`Status: ${connection.status}`}>
        <span
          className={`badge${statusTone(connection.status) ? ` ${statusTone(connection.status)}` : ""}`}
        >
          {connection.status || "unknown"}
        </span>
      </div>
      <div
        className="muted mono"
        data-label="Objects"
        aria-label={`Objects: ${(connection.object_selection ?? []).join(", ") || "none"}`}
        style={{ overflowWrap: "anywhere" }}
      >
        {(connection.object_selection ?? []).join(", ") || "—"}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 6,
          alignItems: "center",
        }}
      >
        <span id={connectionRunReasonId} className="visually-hidden">
          {connection.status === "active"
            ? `Connection ${connection.name} is active.`
            : `Connection ${connection.name} has status ${connection.status || "unknown"}; only active connections can run.`}
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={`Manage ${connection.name}`}
          onClick={(event) => onOpenMappings(connection, event.currentTarget)}
        >
          Manage
        </button>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={runUnavailable || undefined}
          aria-busy={running || undefined}
          aria-describedby={`${runReasonId} ${connectionRunReasonId}`}
          onClick={() => {
            if (!runUnavailable) onRun(connection, providerRuntimeStatus);
          }}
        >
          {!connection.id
            ? "Run unavailable"
            : connection.status !== "active"
              ? "Run unavailable"
              : running
                ? "Running…"
                : "Review run"}
        </button>
      </div>
    </div>
  );
}

function WarehouseDialogs({
  catalog,
  canAdmin,
  createOpen,
  streamingOpen,
  streamingDetail,
  streamingStatusBusy,
  detail,
  detailReturnFocusRef,
  reload,
  onCreateClose,
  onStreamingClose,
  onStreamingDetailClose,
  onStreamingBusyChange,
  onDetailClose,
  onDetailChange,
  onDetailDisconnected,
}: {
  catalog: WarehouseCatalogResponse | null;
  canAdmin: boolean;
  createOpen: boolean;
  streamingOpen: boolean;
  streamingDetail: WarehouseConnection | null;
  streamingStatusBusy: boolean;
  detail: WarehouseConnection | null;
  detailReturnFocusRef: RefObject<HTMLElement | null>;
  reload: () => Promise<void>;
  onCreateClose: () => void;
  onStreamingClose: () => void;
  onStreamingDetailClose: () => void;
  onStreamingBusyChange: (busy: boolean) => void;
  onDetailClose: () => void;
  onDetailChange: (connection: WarehouseConnection) => void;
  onDetailDisconnected: () => void;
}): ReactElement {
  return (
    <>
      {streamingOpen ? (
        <StreamingExportForm
          onClose={onStreamingClose}
          onSaved={() => {
            onStreamingClose();
            void reload();
          }}
        />
      ) : null}
      <StreamingStatusModal
        connection={streamingDetail}
        canAdmin={canAdmin}
        busy={streamingStatusBusy}
        onBusyChange={onStreamingBusyChange}
        onClose={onStreamingDetailClose}
      />
      {createOpen && catalog ? (
        <ConnectionCreateModal
          catalog={catalog}
          onClose={onCreateClose}
          onSaved={() => {
            onCreateClose();
            void reload();
          }}
        />
      ) : null}
      {detail ? (
        <ConnectionDetailModal
          connection={detail}
          canAdmin={canAdmin}
          returnFocusRef={detailReturnFocusRef}
          onClose={onDetailClose}
          onConnectionChanged={onDetailChange}
          onDisconnected={onDetailDisconnected}
        />
      ) : null}
    </>
  );
}

function StreamingStatusModal({
  connection,
  canAdmin,
  busy,
  onBusyChange,
  onClose,
}: {
  connection: WarehouseConnection | null;
  canAdmin: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}): ReactElement | null {
  const busyReasonId = useId();
  if (!connection) return null;
  const requestClose = (): void => {
    if (!busy) onClose();
  };
  return (
    <Modal
      open
      onClose={requestClose}
      size="xl"
      title={`Streaming export — ${connection.name}`}
      description="Operational status, throughput, shipment history, and explicit operator-triggered shipment controls."
    >
      <StreamingExportStatus
        key={connection.id ?? connection.name}
        connection={connection}
        canAdmin={canAdmin}
        onBusyChange={onBusyChange}
      />
      <p id={busyReasonId} className="muted" role={busy ? "status" : undefined}>
        {busy
          ? "Wait for the streaming export operation to finish before closing this status view."
          : "Closing this view does not stop the streaming export."}
      </p>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          aria-describedby={busyReasonId}
          onClick={requestClose}
        >
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

/* ---------- validation panel (shared: live validate + 400 body) ---------- */

function ValidationPanel({
  result,
  transportError,
  validating,
}: {
  result: WarehouseValidationResult | null;
  transportError: string | null;
  validating: boolean;
}): ReactElement | null {
  if (validating) {
    return (
      <p className="muted" style={{ fontSize: 12 }}>
        Validating against the server…
      </p>
    );
  }
  if (transportError) {
    return (
      <Notice tone="danger" announcement="assertive">
        Couldn&apos;t reach the validator: {transportError}
      </Notice>
    );
  }
  if (!result) return null;
  return (
    <div
      style={{
        border: `1px solid ${result.valid ? "color-mix(in srgb, var(--pw-accent) 35%, transparent)" : "color-mix(in srgb, var(--pw-danger) 35%, transparent)"}`,
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 12,
        marginTop: 8,
      }}
      role="status"
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {result.valid ? "Server validation passed" : "Server validation failed"}
      </div>
      {(result.errors ?? []).map((e, i) => (
        <div key={`e${i}`} style={{ color: "var(--pw-danger)" }}>
          ✕ {e}
        </div>
      ))}
      {(result.warnings ?? []).map((w, i) => (
        <div key={`w${i}`} style={{ color: "var(--pw-warning)" }}>
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

function normalizedValidationResult(
  result: WarehouseValidationResult | null | undefined,
): WarehouseValidationResult | null {
  if (!result) return null;
  try {
    return extractWarehouseValidation(JSON.stringify(result));
  } catch {
    return null;
  }
}

/* ---------- create connection ---------- */

export function ConnectionCreateModal({
  catalog,
  onClose,
  onSaved,
}: {
  catalog: WarehouseCatalogResponse;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const saveGuidanceId = useId();
  // A shape-light catalog (empty `{}` from the wire) can leave these
  // arrays undefined — fall back to empty so option lists render blank
  // rather than crashing the modal.
  const providers = catalog.providers ?? [];
  const directions = catalog.directions ?? [];
  const cadences = catalog.cadences ?? [];
  const objects = catalog.objects ?? [];
  const initialDraft = useMemo<ConnectionDraft>(
    () => ({
      ...emptyConnectionDraft(),
      provider:
        providers.find((provider) => provider.runtime_status === "available")
          ?.key ?? "",
      direction: directions[0] ?? "export",
      cadence: cadences.includes("manual")
        ? "manual"
        : (cadences[0] ?? "manual"),
    }),
    [cadences, directions, providers],
  );
  const [draft, setDraft] = useState<ConnectionDraft>(initialDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [validating, setValidating] = useState(false);
  const [serverResult, setServerResult] =
    useState<WarehouseValidationResult | null>(null);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [validatedOnce, setValidatedOnce] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const providerSpecsResource = useRemoteResource<WarehouseProviderSpec[]>(
    async () => {
      const response = await warehouseApi.providers();
      return response.error
        ? { error: response.error }
        : { data: response.data?.items ?? [] };
    },
    { identity: "warehouse-provider-specs" },
  );
  const providerSpec = providerSpecsResource.data?.find(
    (item) => item.provider === draft.provider,
  );

  const patch = (p: Partial<ConnectionDraft>): void => {
    setDraft((d) => ({ ...d, ...p }));
    // Any edit invalidates a previous validation pass.
    setValidatedOnce(false);
    setServerResult(null);
  };

  const requestProviderChange = (provider: string): void => {
    if (provider === draft.provider) return;
    if (draft.configText.trim() || draft.credentialsRef.trim()) {
      setPendingProvider(provider);
      return;
    }
    patch({ provider });
  };

  const runValidateCore =
    async (): Promise<WarehouseValidationResult | null> => {
      const e = connectionDraftErrors(draft);
      setErrors(e);
      if (Object.keys(e).length > 0) return null;
      setValidating(true);
      setValidateError(null);
      try {
        const res = await warehouseApi.validate(connectionDraftToInput(draft));
        if (res.error) {
          // The validate endpoint itself can answer 400-with-body too.
          const recovered = extractWarehouseValidation(res.error.message);
          if (recovered) {
            setServerResult(recovered);
            setValidatedOnce(true);
            return recovered;
          }
          setValidateError(
            safeDataPlatformFailure(
              res.error,
              "The warehouse service could not validate this connection.",
            ),
          );
          setServerResult(null);
          return null;
        }
        const normalized = normalizedValidationResult(res.data);
        if (!normalized) {
          setValidateError(
            "The warehouse validator returned an unusable response. Retry validation before saving.",
          );
          setServerResult(null);
          setValidatedOnce(false);
          return null;
        }
        setServerResult(normalized);
        setValidatedOnce(true);
        return normalized;
      } finally {
        setValidating(false);
      }
    };

  const save = async (): Promise<boolean> => {
    // Always validate before save — the manifest's contract for #35.
    const v =
      validatedOnce && serverResult ? serverResult : await runValidateCore();
    if (!v || !v.valid) return false; // panel shows why
    const res = await warehouseApi.createConnection(
      connectionDraftToInput(draft),
    );
    if (res.error) {
      // 400 body IS the validation result (deviation #5).
      const recovered = extractWarehouseValidation(res.error.message);
      if (recovered) {
        setServerResult(recovered);
        return false;
      }
      // GAP-1#13: the client core truncates unenveloped error bodies to 200
      // chars, so a large errors+warnings ValidationResult arrives as
      // unparseable truncated JSON (recovered === null). Rather than dumping
      // the cut-off blob into errors.form, re-fetch the full structured
      // result from the validate endpoint (always 200, untruncated).
      const revalidated = await warehouseApi.validate(
        connectionDraftToInput(draft),
      );
      const normalized = !revalidated.error
        ? normalizedValidationResult(revalidated.data)
        : null;
      if (normalized) {
        setServerResult(normalized);
        return false;
      }
      setErrors({
        form: safeDataPlatformFailure(
          res.error,
          "The warehouse service could not create this connection.",
        ),
      });
      return false;
    }
    toast.success(`Connection "${draft.name.trim()}" created`);
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: "warehouse-connection-create",
    label: "Warehouse connection draft",
    mode: "create",
    enabled: true,
    dirty: JSON.stringify(draft) !== JSON.stringify(initialDraft),
    save,
    discard: () => {
      setDraft(initialDraft);
      setErrors({});
      setServerResult(null);
      setValidateError(null);
      setValidatedOnce(false);
      setPendingProvider(null);
    },
    close: onClose,
    detail: "This warehouse connection draft has not been created.",
    operationDetail:
      "Wait for warehouse validation or creation to finish before leaving.",
    onError: (error) => {
      setValidateError(
        safeDataPlatformFailure(error, "The warehouse request failed."),
      );
    },
  });

  const runValidate = async (): Promise<void> => {
    const request = lifecycle.runOperation(runValidateCore);
    if (!request) return;
    try {
      await request;
    } catch (error) {
      setValidateError(
        safeDataPlatformFailure(error, "The validation request failed."),
      );
    }
  };

  const submit = async (): Promise<void> => {
    if (await lifecycle.submit()) onSaved();
  };

  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        size="lg"
        title="New warehouse connection"
        description="Validated server-side before saving — credentials are referenced by name, never stored in the dashboard."
      >
        <ConnectionCreateForm
          active={lifecycle.active}
          cadences={cadences}
          directions={directions}
          draft={draft}
          errors={errors}
          objects={objects}
          providers={providers}
          providerSpec={providerSpec}
          providerSpecError={providerSpecsResource.failure?.message ?? null}
          providerSpecLoading={providerSpecsResource.transport === "loading"}
          saveGuidanceId={saveGuidanceId}
          serverResult={serverResult}
          validateError={validateError}
          validating={validating}
          onCancel={lifecycle.requestClose}
          onPatch={patch}
          onProviderChange={requestProviderChange}
          onRetryProviderSpecs={() => void providerSpecsResource.reload()}
          onSubmit={() => void submit()}
          onValidate={() => void runValidate()}
        />
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard warehouse connection draft?"
        description="The connection details and credentials reference entered here will be lost."
        confirmLabel="Discard draft"
        danger
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
      <ConfirmModal
        open={pendingProvider !== null}
        title="Replace provider-specific connection settings?"
        description="Changing provider clears the provider config JSON and credentials reference entered for the current provider."
        confirmLabel="Replace provider"
        danger
        busy={lifecycle.active}
        onConfirm={() => {
          if (pendingProvider) {
            patch({
              provider: pendingProvider,
              configText: "",
              credentialsRef: "",
            });
          }
          setPendingProvider(null);
        }}
        onClose={() => setPendingProvider(null)}
      />
    </>
  );
}

function ConnectionCreateForm({
  active,
  cadences,
  directions,
  draft,
  errors,
  objects,
  providers,
  providerSpec,
  providerSpecError,
  providerSpecLoading,
  saveGuidanceId,
  serverResult,
  validateError,
  validating,
  onCancel,
  onPatch,
  onProviderChange,
  onRetryProviderSpecs,
  onSubmit,
  onValidate,
}: {
  active: boolean;
  cadences: NonNullable<WarehouseCatalogResponse["cadences"]>;
  directions: NonNullable<WarehouseCatalogResponse["directions"]>;
  draft: ConnectionDraft;
  errors: Record<string, string>;
  objects: NonNullable<WarehouseCatalogResponse["objects"]>;
  providers: NonNullable<WarehouseCatalogResponse["providers"]>;
  providerSpec: WarehouseProviderSpec | undefined;
  providerSpecError: string | null;
  providerSpecLoading: boolean;
  saveGuidanceId: string;
  serverResult: WarehouseValidationResult | null;
  validateError: string | null;
  validating: boolean;
  onCancel: () => void;
  onPatch: (patch: Partial<ConnectionDraft>) => void;
  onProviderChange: (provider: string) => void;
  onRetryProviderSpecs: () => void;
  onSubmit: () => void;
  onValidate: () => void;
}): ReactElement {
  return (
    <form
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset disabled={active} style={{ border: 0, margin: 0, padding: 0 }}>
        {errors.form ? (
          <Notice
            tone="danger"
            announcement="assertive"
            style={{ marginBottom: 12 }}
          >
            {errors.form}
          </Notice>
        ) : null}
        <FormField label="Name" required error={errors.name}>
          <input
            type="text"
            value={draft.name}
            onChange={(event) => onPatch({ name: event.target.value })}
            placeholder="e.g. Snowflake production"
          />
        </FormField>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 12,
          }}
        >
          <FormField label="Provider" required error={errors.provider}>
            <select
              value={draft.provider}
              onChange={(event) => onProviderChange(event.target.value)}
            >
              {providers.map((provider) => (
                <option
                  key={provider.key}
                  value={provider.key}
                  disabled={provider.runtime_status !== "available"}
                >
                  {provider.label}
                  {provider.runtime_status !== "available"
                    ? ` (${provider.runtime_status} · unavailable)`
                    : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Direction">
            <select
              value={draft.direction}
              onChange={(event) => onPatch({ direction: event.target.value })}
            >
              {(directions.length > 0
                ? directions
                : ["export", "import", "bidirectional"]
              ).map((direction) => (
                <option key={direction} value={direction}>
                  {direction}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Cadence">
            <select
              value={draft.cadence}
              onChange={(event) => onPatch({ cadence: event.target.value })}
            >
              {(cadences.length > 0
                ? cadences
                : ["manual", "hourly", "daily", "weekly"]
              ).map((cadence) => (
                <option key={cadence} value={cadence}>
                  {cadence}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField
          label="Objects to sync"
          required
          error={errors.objectSelection}
        >
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {objects.map((object) => {
              const unavailable = object.runtime_status !== "available";
              return (
                <label
                  key={object.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    cursor: unavailable ? "not-allowed" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={draft.objectSelection.includes(object.key)}
                    aria-disabled={unavailable || undefined}
                    onChange={() => {
                      if (!unavailable) {
                        onPatch({
                          objectSelection: toggleSelection(
                            draft.objectSelection,
                            object.key,
                          ),
                        });
                      }
                    }}
                  />
                  {object.label}
                  <span className="muted">
                    ({object.runtime_status}
                    {unavailable ? " · unavailable" : ""})
                  </span>
                </label>
              );
            })}
          </div>
        </FormField>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 12,
          }}
        >
          <FormField
            label="Backfill days"
            error={errors.backfillDays}
            help="How far back the first run reaches."
          >
            <input
              type="number"
              min={1}
              max={3650}
              value={draft.backfillDays}
              onChange={(event) =>
                onPatch({ backfillDays: event.target.value })
              }
            />
          </FormField>
          <FormField
            label="Credentials reference"
            required={providerSpec?.required_settings.some(
              (field) => field.key === "credentials_ref" && field.required,
            )}
            help="Name of the secret holding warehouse credentials (e.g. vault://warehouse-prod)."
          >
            <input
              type="text"
              value={draft.credentialsRef}
              onChange={(event) =>
                onPatch({ credentialsRef: event.target.value })
              }
              placeholder="vault://warehouse-prod"
            />
          </FormField>
        </div>
        <WarehouseProviderFields
          spec={providerSpec}
          configText={draft.configText}
          error={errors.config}
          loading={providerSpecLoading}
          loadError={providerSpecError}
          onChange={(configText) => onPatch({ configText })}
          onRetry={onRetryProviderSpecs}
        />
        <ValidationPanel
          result={serverResult}
          transportError={validateError}
          validating={validating}
        />
        <p id={saveGuidanceId} className="muted" style={{ fontSize: 11 }}>
          Validate &amp; save always asks the server to validate the current
          draft and saves only after a valid response.
        </p>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            disabled={active}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={active}
            onClick={onValidate}
          >
            {validating ? "Validating…" : "Validate"}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={active}
            aria-describedby={saveGuidanceId}
          >
            {active && !validating ? "Saving…" : "Validate & save"}
          </button>
        </ModalFooter>
      </fieldset>
    </form>
  );
}

/* ---------- connection detail: mappings ---------- */

function ConnectionDetailModal({
  connection,
  canAdmin,
  returnFocusRef,
  onClose,
  onConnectionChanged,
  onDisconnected,
}: {
  connection: WarehouseConnection;
  canAdmin: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConnectionChanged: (connection: WarehouseConnection) => void;
  onDisconnected: () => void;
}): ReactElement {
  const mappingActionReasonId = useId();
  const [editing, setEditing] = useState<{
    draft: MappingDraft;
    existing: boolean;
    expectedVersion: number;
  } | null>(null);

  const id = connection.id ?? "";
  const mappingResource = useRemoteResource<WarehouseImportMapping[]>(
    async () => {
      if (!id) return { data: [] };
      const response = await warehouseApi.listMappings(id);
      return response.error
        ? { error: response.error }
        : { data: response.data?.items ?? [] };
    },
    { identity: `warehouse-mappings:${id || "missing"}` },
  );
  const mappings = mappingResource.data;
  const mappingLoading = mappingResource.transport === "loading";

  const mappingFor = (obj: string): WarehouseImportMapping | undefined =>
    mappings?.find((m) => m.source_object === obj);

  return (
    <Modal
      open
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      size="xl"
      title={`Manage — ${connection.name}`}
      description="Verify runtime evidence, control the connection lifecycle, and define how imported source objects become subscriber events."
    >
      <WarehouseConnectionControl
        connection={connection}
        canAdmin={canAdmin}
        onConnectionChanged={onConnectionChanged}
        onDisconnected={onDisconnected}
      />

      <section
        className="dp-connection-mappings"
        aria-labelledby={`${mappingActionReasonId}-heading`}
      >
        <div className="dp-connection-subheader">
          <div>
            <span className="dp-eyebrow">Import contract</span>
            <h3 id={`${mappingActionReasonId}-heading`}>Source mappings</h3>
            <p>
              Choose the profile key, event timestamp, and properties emitted
              for every selected source object.
            </p>
          </div>
        </div>
        {!id ? (
          <Notice tone="danger" announcement="assertive">
            This connection has no stable identifier, so its mappings cannot be
            read or changed.
          </Notice>
        ) : null}
        {mappingResource.failure ? (
          <Notice
            tone="danger"
            announcement="assertive"
            action={
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={mappingLoading || undefined}
                aria-busy={mappingLoading || undefined}
                onClick={() => {
                  if (!mappingLoading) void mappingResource.reload();
                }}
              >
                {mappingLoading ? "Retrying…" : "Retry mappings"}
              </button>
            }
          >
            Couldn&apos;t verify mappings: {mappingResource.failure.message}
          </Notice>
        ) : null}
        {mappings === null && mappingLoading ? (
          <p className="muted">Loading mappings…</p>
        ) : mappings === null ? (
          <p className="muted">
            No verified mapping data is available. Retry when the service is
            reachable.
          </p>
        ) : (connection.object_selection ?? []).length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            This connection has no objects selected — nothing to map.
          </p>
        ) : (
          <div
            className="list dp-data-list dp-connection-mapping-list"
            role="table"
            aria-label={`Source mappings for ${connection.name}`}
            aria-colcount={4}
            aria-rowcount={(connection.object_selection ?? []).length + 1}
          >
            <div
              className="list-header"
              style={{ gridTemplateColumns: "1fr 1.2fr 1fr 120px" }}
              role="row"
            >
              <div role="columnheader">Source object</div>
              <div role="columnheader">Target event</div>
              <div role="columnheader">Profile key / time</div>
              <div role="columnheader">
                <span className="visually-hidden">Actions</span>
              </div>
            </div>
            {(connection.object_selection ?? []).map((obj) => {
              const m = mappingFor(obj);
              return (
                <div
                  key={obj}
                  className="list-row"
                  role="row"
                  style={{
                    gridTemplateColumns: "1fr 1.2fr 1fr 120px",
                    cursor: "default",
                  }}
                >
                  <div
                    role="cell"
                    className="mono"
                    data-label="Source object"
                    style={{ fontSize: 12 }}
                  >
                    {obj}
                  </div>
                  <div
                    role="cell"
                    className="muted"
                    data-label="Target event"
                    style={{ fontSize: 12 }}
                  >
                    {m?.target_event_name || (
                      <em className="muted">not mapped</em>
                    )}
                  </div>
                  <div
                    role="cell"
                    className="muted mono"
                    data-label="Profile key / time"
                    style={{ fontSize: 11 }}
                  >
                    {m
                      ? `${m.profile_key_column} / ${m.occurred_at_column}`
                      : "—"}
                  </div>
                  <div
                    role="cell"
                    data-label="Actions"
                    style={{ textAlign: "right" }}
                  >
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      aria-disabled={!canAdmin || !id || undefined}
                      aria-describedby={mappingActionReasonId}
                      onClick={() => {
                        if (canAdmin && id) {
                          setEditing({
                            draft: mappingDraftFrom(obj, m),
                            existing: Boolean(m),
                            expectedVersion: m?.version ?? 0,
                          });
                        }
                      }}
                    >
                      {m ? "Edit" : "Map"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p
          id={mappingActionReasonId}
          className="muted"
          style={{ fontSize: 11 }}
        >
          {!canAdmin
            ? "Admin access is required to create or edit mappings."
            : !id
              ? "Mapping changes require a connection with a stable identifier."
              : "Mappings determine how imported warehouse rows join profiles and events."}
        </p>
      </section>

      {editing ? (
        <MappingEditModal
          key={`${id}:${editing.draft.sourceObject}`}
          connectionId={id}
          draft={editing.draft}
          existing={editing.existing}
          expectedVersion={editing.expectedVersion}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void mappingResource.reload();
          }}
        />
      ) : null}

      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}

function MappingEditModal({
  connectionId,
  draft: initial,
  existing,
  expectedVersion,
  onClose,
  onSaved,
}: {
  connectionId: string;
  draft: MappingDraft;
  existing: boolean;
  expectedVersion: number;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<MappingDraft>(initial);
  const [baseline, setBaseline] = useState<MappingDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const patch = (p: Partial<MappingDraft>): void =>
    setDraft((d) => ({ ...d, ...p }));

  const save = async (): Promise<boolean> => {
    const e = mappingDraftErrors(draft);
    setErrors(e);
    if (Object.keys(e).length > 0) return false;
    const res = await warehouseApi.putMapping(
      connectionId,
      draft.sourceObject,
      { ...mappingDraftToInput(draft), expected_version: expectedVersion },
    );
    if (res.error) {
      setErrors({
        form: safeDataPlatformFailure(
          res.error,
          "The warehouse service could not save this mapping.",
        ),
      });
      return false;
    }
    setBaseline(draft);
    toast.success(`Mapping for "${draft.sourceObject}" saved`);
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: `warehouse-mapping-${connectionId}-${initial.sourceObject}`,
    label: `Warehouse mapping for ${initial.sourceObject}`,
    mode: existing ? "edit" : "create",
    enabled: true,
    dirty: JSON.stringify(draft) !== JSON.stringify(baseline),
    save,
    discard: () => {
      setDraft(baseline);
      setErrors({});
    },
    close: onClose,
    detail: existing
      ? "These edits to the acknowledged warehouse mapping have not been saved."
      : "This warehouse mapping draft has not been created.",
    operationDetail:
      "Wait for the warehouse mapping request to finish before leaving.",
    onError: (error) => {
      setErrors({
        form: safeDataPlatformFailure(error, "The mapping request failed."),
      });
    },
  });

  const submit = async (): Promise<void> => {
    if (await lifecycle.submit()) onSaved();
  };

  return (
    <>
      <Modal
        open
        onClose={lifecycle.requestClose}
        title={`Map "${draft.sourceObject}"`}
        description="Imported rows become profile events: the profile-key column matches subscribers, occurred-at orders the timeline."
      >
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset
            disabled={lifecycle.active}
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            {errors.form ? (
              <Notice
                tone="danger"
                announcement="assertive"
                style={{ marginBottom: 12 }}
              >
                {errors.form}
              </Notice>
            ) : null}
            <FormField
              label="Target event name"
              required
              error={errors.targetEventName}
            >
              <input
                type="text"
                value={draft.targetEventName}
                onChange={(e) => patch({ targetEventName: e.target.value })}
                placeholder="order_placed"
              />
            </FormField>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <FormField
                label="Profile-key column"
                required
                error={errors.profileKeyColumn}
              >
                <input
                  type="text"
                  value={draft.profileKeyColumn}
                  onChange={(e) => patch({ profileKeyColumn: e.target.value })}
                  placeholder="email"
                />
              </FormField>
              <FormField
                label="Occurred-at column"
                required
                error={errors.occurredAtColumn}
              >
                <input
                  type="text"
                  value={draft.occurredAtColumn}
                  onChange={(e) => patch({ occurredAtColumn: e.target.value })}
                  placeholder="created_at"
                />
              </FormField>
            </div>
            <FormField
              label="Property map (JSON, optional)"
              error={errors.propertyMap}
              help='Maps event property names to source columns, e.g. {"total": "total_cents"}.'
            >
              <textarea
                rows={4}
                value={draft.propertyMapText}
                onChange={(e) => patch({ propertyMapText: e.target.value })}
                style={{ fontFamily: "var(--pw-font-mono)", fontSize: 12 }}
              />
            </FormField>
            <FormField label="Status">
              <select
                value={draft.status}
                onChange={(e) => patch({ status: e.target.value })}
              >
                <option value="active">active</option>
                <option value="paused">paused</option>
              </select>
            </FormField>
            <ModalFooter>
              <button
                type="button"
                className="btn"
                disabled={lifecycle.active}
                onClick={lifecycle.requestClose}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={lifecycle.active}
              >
                {lifecycle.active ? "Saving…" : "Save mapping"}
              </button>
            </ModalFooter>
          </fieldset>
        </form>
      </Modal>
      <ConfirmModal
        open={lifecycle.discardConfirmOpen}
        title="Discard warehouse mapping changes?"
        description={
          existing
            ? "Your edits will be replaced by the last acknowledged mapping."
            : "This new mapping draft will be lost."
        }
        confirmLabel="Discard changes"
        danger
        onConfirm={lifecycle.discardAndClose}
        onClose={lifecycle.keepEditing}
      />
    </>
  );
}
