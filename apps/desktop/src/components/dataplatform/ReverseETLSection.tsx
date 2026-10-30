/**
 * Data Platform → Reverse ETL section (SUB-112).
 *
 * Warehouse-managed traits (columns from Snowflake/BigQuery/Redshift)
 * sync BACK onto subscribers as queryable custom fields. Each mapping
 * links one warehouse column path to one subscriber custom-field key.
 *
 * Surface:
 *   - Connection picker (mappings belong to a warehouse connection).
 *   - Active-mappings list: source table, mapped columns
 *     (warehouse.table.col → custom_field.key), last sync time, row count,
 *     status.
 *   - "Add mapping" → ReverseETLMappingModal.
 *   - Per-mapping deletion where the server supplied a stable mapping ID.
 *   - An explicit execution safety hold while no warehouse row-fetch driver
 *     exists, preventing empty-row false-success receipts.
 *
 * Honest-UI: a 404 on the connections / mappings endpoints means the
 * surface isn't enabled on this server — we say so instead of pretending
 * the tenant has nothing.
 *
 * Backend: apps/api/internal/warehouse/reverse_etl.go.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { useSingleFlightOperation } from "../../hooks/useSettingsDraftLifecycle";
import { ConfirmModal } from "../ConfirmModal";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { toast } from "../Toast";
import { ReverseETLMappingModal } from "../warehouse/ReverseETLMappingModal";
import {
  warehouseApi,
  type ReverseETLMapping,
  type WarehouseConnection,
} from "../../lib/api-client";
import { useCapabilityReporter } from "../../lib/capability-observations";
import { safeDataPlatformFailure } from "./safe-failures";

const COLS = "1.2fr 2fr 130px 100px 90px 90px";

function fmtTime(s: string | null | undefined): string {
  if (!s) return "never";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ReverseOverlayFocusController {
  primaryAddTriggerRef: RefObject<HTMLButtonElement | null>;
  deleteReturnFocusRef: RefObject<HTMLElement | null>;
  openAdd: (trigger: HTMLElement) => void;
  closeAdd: () => void;
  openDelete: (mapping: ReverseETLMapping, trigger: HTMLElement) => void;
  closeDelete: () => void;
  closeDeleteToPrimary: () => void;
}

function useReverseOverlayFocus({
  setAddOpen,
  setDeleting,
}: {
  setAddOpen: (open: boolean) => void;
  setDeleting: (mapping: ReverseETLMapping | null) => void;
}): ReverseOverlayFocusController {
  const primaryAddTriggerRef = useRef<HTMLButtonElement | null>(null);
  const addReturnFocusRef = useRef<HTMLElement | null>(null);
  const deleteReturnFocusRef = useRef<HTMLElement | null>(null);
  return {
    primaryAddTriggerRef,
    deleteReturnFocusRef,
    openAdd: (trigger) => {
      addReturnFocusRef.current = trigger;
      setAddOpen(true);
    },
    closeAdd: () => {
      const preferredTarget = addReturnFocusRef.current;
      setAddOpen(false);
      queueMicrotask(() => {
        const target = preferredTarget?.isConnected
          ? preferredTarget
          : primaryAddTriggerRef.current;
        if (
          target?.isConnected &&
          !target.closest('[aria-hidden="true"], [inert]')
        ) {
          target.focus();
        }
      });
    },
    openDelete: (mapping, trigger) => {
      deleteReturnFocusRef.current = trigger;
      setDeleting(mapping);
    },
    closeDelete: () => setDeleting(null),
    closeDeleteToPrimary: () => {
      deleteReturnFocusRef.current = primaryAddTriggerRef.current;
      setDeleting(null);
    },
  };
}

export function ReverseETLSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const { available, fromApiError } = useCapabilityReporter(
    "dataPlatform",
    "reverse-etl",
  );
  const [connections, setConnections] = useState<WarehouseConnection[] | null>(
    null,
  );
  const [connErr, setConnErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");

  const [mappings, setMappings] = useState<ReverseETLMapping[] | null>(null);
  const [mapErr, setMapErr] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<ReverseETLMapping | null>(null);
  const syncDescriptionId = useId();
  const deleteDescriptionId = useId();
  const mountedRef = useRef(false);
  const connectionRequestRef = useRef(0);
  const mappingRequestRef = useRef(0);
  const overlayFocus = useReverseOverlayFocus({ setAddOpen, setDeleting });
  const operation = useSingleFlightOperation({
    ownerId: "reverse-etl-action",
    label: "Reverse-ETL operation",
    detail: "Wait for the reverse-ETL request to finish before leaving.",
  });

  const loadConnections = useCallback(async (): Promise<void> => {
    const requestId = ++connectionRequestRef.current;
    setConnErr(null);
    try {
      const res = await warehouseApi.listConnections();
      if (!mountedRef.current || requestId !== connectionRequestRef.current)
        return;
      if (res.error) {
        fromApiError(res.error, {
          endpointAbsenceMeansNotConfigured: true,
          impact: "partial",
        });
        setConnErr(
          res.error.status === 404 || res.error.status === 405
            ? "Warehouse sync isn't enabled on this Moosewave server."
            : safeDataPlatformFailure(
                res.error,
                "Warehouse connections could not be verified.",
              ),
        );
        return;
      }
      available();
      const items = (res.data?.items ?? []).filter(
        (connection) => connection.provider !== "streaming_export",
      );
      setConnections(items);
      // Streaming-export destinations are not valid Reverse ETL sources.
      const first = items[0];
      setSelected((current) =>
        current && items.some((item) => item.id === current)
          ? current
          : (first?.id ?? ""),
      );
    } catch {
      if (!mountedRef.current || requestId !== connectionRequestRef.current)
        return;
      setConnErr(
        "Couldn't reach warehouse connections. Check the connection and retry.",
      );
    }
  }, [available, fromApiError]);

  // Load connections once and invalidate late responses on unmount.
  useEffect(() => {
    mountedRef.current = true;
    void loadConnections();
    return () => {
      mountedRef.current = false;
      connectionRequestRef.current += 1;
      mappingRequestRef.current += 1;
    };
  }, [loadConnections]);

  const loadMappings = useCallback(async (): Promise<void> => {
    const requestId = ++mappingRequestRef.current;
    if (!selected) {
      setMappings([]);
      return;
    }
    setMappings(null);
    setMapErr(null);
    let res;
    try {
      res = await warehouseApi.listReverseETLMappings(selected);
    } catch {
      if (!mountedRef.current || requestId !== mappingRequestRef.current)
        return;
      setMapErr(
        "Couldn't reach reverse ETL mappings. Check the connection and retry.",
      );
      setMappings([]);
      return;
    }
    if (!mountedRef.current || requestId !== mappingRequestRef.current) return;
    if (res.error) {
      fromApiError(res.error, {
        endpointAbsenceMeansNotConfigured: true,
        impact: "partial",
      });
      setMapErr(
        res.error.status === 404 || res.error.status === 405
          ? "Reverse ETL isn't enabled on this Moosewave server."
          : safeDataPlatformFailure(
              res.error,
              "Reverse ETL mappings could not be verified.",
            ),
      );
      setMappings([]);
      return;
    }
    available();
    setMappings(res.data?.items ?? []);
  }, [available, fromApiError, selected]);

  useEffect(() => {
    void loadMappings();
  }, [loadMappings]);

  const selectedName =
    connections?.find((c) => c.id === selected)?.name ?? "connection";
  const activeMappings = (mappings ?? []).filter(
    (mapping) => mapping.status === "active",
  ).length;

  const doDelete = async (): Promise<void> => {
    if (!deleting?.id || !selected) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const target = deleting;
    const targetConnection = selected;
    const request = operation.run(async () => {
      try {
        const res = await warehouseApi.deleteReverseETLMapping(
          targetConnection,
          target.id!,
          target.version,
          target.target_field_key,
        );
        if (res.error) {
          toast.error({
            message: "Couldn't delete mapping",
            detail: safeDataPlatformFailure(
              res.error,
              "The warehouse service could not delete this mapping.",
            ),
          });
          return;
        }
        toast.success("Mapping deleted");
        overlayFocus.closeDeleteToPrimary();
        if (selected === targetConnection) void loadMappings();
      } catch (error) {
        toast.error({
          message: "Couldn't delete mapping",
          detail: safeDataPlatformFailure(error, "The delete request failed."),
        });
      }
    });
    if (!request) await operation.wait();
  };

  return (
    <div className="dp-section dp-reverse-etl">
      <SectionHeader
        title="Reverse ETL"
        description="Sync warehouse-managed traits back onto subscribers as queryable custom fields. Each mapping links a warehouse column to one custom-field key."
        actions={
          selected ? (
            <div className="dp-section-actions">
              <ReverseETLSyncAction descriptionId={syncDescriptionId} />
              {canAdmin ? (
                <button
                  ref={overlayFocus.primaryAddTriggerRef}
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={(event) => overlayFocus.openAdd(event.currentTarget)}
                >
                  + Add mapping
                </button>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <div className="dp-runtime-callout" role="note">
        <span className="dp-runtime-callout-icon" aria-hidden="true">
          <Icon name="alert-triangle" size={18} />
        </span>
        <div>
          <strong>Live execution needs a warehouse row-fetch driver</strong>
          <p>
            This build can create and review mapping contracts, but it cannot
            fetch source rows. “Sync now” stays unavailable so an empty staged
            request cannot be mistaken for a successful activation.
          </p>
        </div>
        <span className="dp-status-pill dp-status-pill-warning">
          Mapping only
        </span>
      </div>

      {connErr ? (
        <Notice
          className="dp-notice"
          tone="danger"
          announcement="assertive"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void loadConnections();
              }}
            >
              Retry connections
            </button>
          }
        >
          {connErr}
        </Notice>
      ) : connections === null ? (
        <p className="muted">Loading connections…</p>
      ) : connections.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No warehouse connections yet — create one in the Warehouse tab first,
          then map its columns onto subscribers here.
        </p>
      ) : (
        <>
          <div className="dp-operation-strip" aria-label="Reverse ETL summary">
            <div>
              <span>Connection</span>
              <strong>{selectedName}</strong>
              <small>Selected source contract</small>
            </div>
            <div>
              <span>Mappings</span>
              <strong className="tabular">
                {mappings === null ? "—" : mappings.length.toLocaleString()}
              </strong>
              <small>{activeMappings.toLocaleString()} active</small>
            </div>
            <div data-tone="warning">
              <span>Execution</span>
              <strong>Driver required</strong>
              <small>No warehouse rows are fetched</small>
            </div>
          </div>

          <ReverseConnectionPicker
            connections={connections}
            selected={selected}
            disabled={addOpen || operation.active}
            onChange={setSelected}
          />

          <ReverseMappingsState
            mappings={mappings}
            error={mapErr}
            canAdmin={canAdmin}
            deleteDescriptionId={deleteDescriptionId}
            onRetry={() => void loadMappings()}
            onAdd={overlayFocus.openAdd}
            onDelete={overlayFocus.openDelete}
          />
        </>
      )}

      {addOpen && selected ? (
        <ReverseETLMappingModal
          key={selected}
          connectionId={selected}
          connectionName={selectedName}
          onClose={overlayFocus.closeAdd}
          onSaved={() => {
            overlayFocus.closeAdd();
            void loadMappings();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmModal
          open
          title="Delete mapping?"
          description={`Remove the mapping ${deleting.source_table}.${deleting.source_column} → custom_field.${deleting.target_field_key}? Subscriber values already written are kept.`}
          confirmLabel="Delete"
          danger
          busy={operation.active}
          returnFocusRef={overlayFocus.deleteReturnFocusRef}
          onConfirm={() => void doDelete()}
          onClose={() => {
            if (!operation.active) overlayFocus.closeDelete();
          }}
        />
      ) : null}
    </div>
  );
}

function ReverseMappingsState({
  mappings,
  error,
  canAdmin,
  deleteDescriptionId,
  onRetry,
  onAdd,
  onDelete,
}: {
  mappings: ReverseETLMapping[] | null;
  error: string | null;
  canAdmin: boolean;
  deleteDescriptionId: string;
  onRetry: () => void;
  onAdd: (trigger: HTMLElement) => void;
  onDelete: (mapping: ReverseETLMapping, trigger: HTMLElement) => void;
}): ReactElement {
  if (error) {
    return (
      <Notice
        className="dp-notice"
        tone="danger"
        announcement="assertive"
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry mappings
          </button>
        }
      >
        {error}
      </Notice>
    );
  }
  if (mappings === null) return <p className="muted">Loading mappings…</p>;
  if (mappings.length === 0) {
    return (
      <div className="dp-quiet-empty">
        <Icon name="git-branch" size={21} />
        <div>
          <strong>No mapping contracts yet</strong>
          <p>
            Add a source column and profile-field target. The contract can be
            prepared now; execution remains unavailable until a row-fetch driver
            is attached.
          </p>
        </div>
        {canAdmin ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={(event) => onAdd(event.currentTarget)}
          >
            Add first mapping
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <div
        className="list dp-data-list dp-reverse-list"
        role="table"
        aria-label="Reverse ETL mapping contracts"
        aria-colcount={6}
        aria-rowcount={mappings.length + 1}
      >
        <div
          className="list-header"
          style={{ gridTemplateColumns: COLS }}
          role="row"
        >
          <div role="columnheader">Source table</div>
          <div role="columnheader">Mapping</div>
          <div role="columnheader">Last sync</div>
          <div role="columnheader">Rows</div>
          <div role="columnheader">Status</div>
          <div role="columnheader">
            <span className="visually-hidden">Actions</span>
          </div>
        </div>
        {mappings.map((mapping) => (
          <ReverseMappingRow
            key={
              mapping.id ?? `${mapping.source_table}.${mapping.source_column}`
            }
            mapping={mapping}
            canAdmin={canAdmin}
            deleteDescriptionId={deleteDescriptionId}
            onDelete={onDelete}
          />
        ))}
      </div>
      <span id={deleteDescriptionId} className="visually-hidden">
        A mapping must have a stable server identifier before it can be deleted.
      </span>
    </>
  );
}

function ReverseMappingRow({
  mapping,
  canAdmin,
  deleteDescriptionId,
  onDelete,
}: {
  mapping: ReverseETLMapping;
  canAdmin: boolean;
  deleteDescriptionId: string;
  onDelete: (mapping: ReverseETLMapping, trigger: HTMLElement) => void;
}): ReactElement {
  return (
    <div
      className="list-row"
      role="row"
      style={{ gridTemplateColumns: COLS, cursor: "default" }}
    >
      <div role="cell" className="mono" data-label="Source table">
        {mapping.source_table}
      </div>
      <div
        role="cell"
        className="mono muted"
        data-label="Mapping"
        style={{
          fontSize: 11,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={`warehouse.${mapping.source_table}.${mapping.source_column} → custom_field.${mapping.target_field_key}`}
      >
        {mapping.source_column} → custom_field.{mapping.target_field_key}
      </div>
      <div role="cell" className="muted tabular" data-label="Last sync">
        {fmtTime(mapping.last_synced_at)}
      </div>
      <div role="cell" className="muted tabular" data-label="Rows">
        {(mapping.last_row_count || 0).toLocaleString()}
      </div>
      <div role="cell" data-label="Status">
        <span
          className={`badge${mapping.status === "active" ? " success" : ""}`}
        >
          {mapping.status}
        </span>
      </div>
      <div role="cell" data-label="Actions" style={{ textAlign: "right" }}>
        {canAdmin ? (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-disabled={!mapping.id || undefined}
            aria-describedby={!mapping.id ? deleteDescriptionId : undefined}
            onClick={(event) => {
              if (mapping.id) onDelete(mapping, event.currentTarget);
            }}
          >
            {mapping.id ? "Delete" : "Delete unavailable"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ReverseETLSyncAction({
  descriptionId,
}: {
  descriptionId: string;
}): ReactElement {
  return (
    <>
      <span id={descriptionId} className="visually-hidden">
        Live reverse-ETL execution is unavailable because this build has no
        warehouse row-fetch driver. Mapping contracts can still be managed.
      </span>
      <button
        type="button"
        className="btn btn-sm"
        aria-disabled="true"
        aria-describedby={descriptionId}
      >
        Sync unavailable
      </button>
    </>
  );
}

function ReverseConnectionPicker({
  connections,
  selected,
  disabled,
  onChange,
}: {
  connections: WarehouseConnection[];
  selected: string;
  disabled: boolean;
  onChange: (connectionId: string) => void;
}): ReactElement {
  return (
    <div className="dp-connection-picker">
      <label
        htmlFor="reverse-etl-connection"
        className="muted"
        style={{ fontSize: 11, display: "block", marginBottom: 4 }}
      >
        Warehouse connection
      </label>
      <select
        id="reverse-etl-connection"
        value={selected}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Warehouse connection"
      >
        {connections.map((connection) => (
          <option
            key={connection.id ?? connection.name}
            value={connection.id ?? ""}
          >
            {connection.name} ({connection.provider})
          </option>
        ))}
      </select>
    </div>
  );
}
