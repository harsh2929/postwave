import type { ApiResult } from "./result";

interface WarehouseRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

type WarehouseRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: WarehouseRequestOptions,
) => Promise<ApiResult<T>>;

/* ---------- #35 Warehouse (warehouse) -------------------------------- */

export interface WarehouseCatalogResponse {
  schema_version: string;
  providers: Array<{
    key: string;
    label: string;
    runtime_status: string;
    auth_mode?: string;
    managed?: boolean;
    capabilities?: string[];
    docs_url?: string;
  }>;
  directions: string[];
  cadences: string[];
  objects: Array<{ key: string; label: string; runtime_status: string }>;
  import_targets: Array<{ key: string; label: string; runtime_status: string }>;
  workers: Array<{ key: string; label: string; runtime_status: string }>;
}

export interface WarehouseProviderField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  help?: string;
}

export interface WarehouseProviderSpec {
  provider: string;
  name: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  sync_model?: string;
  verification_mode?: string;
  capabilities: string[];
  required_settings: WarehouseProviderField[];
  optional_settings?: WarehouseProviderField[];
  sync_objects: string[];
  docs_url: string;
}

export interface WarehouseConnection {
  id?: string;
  tenant_id?: string;
  name: string;
  provider: string;
  /** export | import | bidirectional */
  direction: string;
  status: string;
  /** Whether a server-side credential reference exists; its value is private. */
  credential_ref_present: boolean;
  config?: Record<string, unknown>;
  object_selection: string[];
  /** manual | hourly | daily | weekly */
  cadence: string;
  backfill_days: number;
  issue_present: boolean;
  /** Exact compare-and-swap token for lifecycle and execution writes. */
  version: number;
  created_at?: string;
  updated_at?: string;
}

/** Write-only connection fields are deliberately separated from public reads. */
export type WarehouseConnectionInput = Partial<WarehouseConnection> & {
  credentials_ref?: string;
};

export interface WarehouseProviderCleanupAcknowledgementInput {
  expected_version: number;
  completed_actions?: string[];
  notes?: string;
}

export interface WarehouseProviderCleanupAcknowledgementResponse {
  ok: true;
  id: string;
  previous_version: number;
  version: number;
}

export interface WarehouseDisconnectReceipt {
  ok: true;
  id: string;
  previous_version: number;
  version: number;
  status: "disconnected";
}

export interface WarehouseValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  [extra: string]: unknown;
}

export interface WarehouseSyncRun {
  id: string;
  connection_id?: string;
  direction: string;
  run_mode: string;
  status: string;
  object_selection: string[];
  rows_scanned: number;
  rows_exported: number;
  rows_imported: number;
  rows_failed: number;
  schema_errors: number;
  retry_count: number;
  issue_present: boolean;
  started_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseImportMapping {
  id?: string;
  connection_id?: string;
  source_object: string;
  target_event_name: string;
  profile_key_column: string;
  occurred_at_column: string;
  property_map?: Record<string, unknown>;
  validation_rules?: Record<string, unknown>;
  status: string;
  version: number;
  /** Input-only CAS token: 0 creates, a positive value updates exactly. */
  expected_version?: number;
  created_at?: string;
  updated_at?: string;
}

/* ---------- SUB-111 Streaming export (Currents-style) -------------- */
// A streaming-export destination is a warehouse_connection with
// provider="streaming_export"; its config block carries format /
// compression / batch_size / prefix. Storage is tenant-bound workspace
// storage; per-connection bucket overrides are rejected. Each shipment is a
// StreamingExportRun. Backend: apps/api/internal/streaming_export.

export type StreamingExportFormat = "parquet" | "avro";
export type StreamingExportCompression = "none" | "snappy" | "gzip" | "zstd";

/** Parsed streaming-export config block (lives in connection.config). */
export interface StreamingExportConfig {
  format?: StreamingExportFormat | string;
  compression?: StreamingExportCompression | string;
  batch_size?: number;
  prefix?: string;
  field_filters?: string[];
}

/** One row from streaming_export_runs — an hourly shipment window. */
export interface StreamingExportRun {
  id: string;
  tenant_id?: string;
  connection_id: string;
  /** completed | running | failed | … */
  status: string;
  format: string;
  compression: string;
  window_start: string;
  window_end: string;
  cursor_from: number;
  cursor_to: number;
  has_more: boolean;
  rows_shipped: number;
  bytes_shipped: number;
  issue_present: boolean;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

export interface StreamingExportRunsResponse {
  items: StreamingExportRun[];
  /** Newest completed window's end, or null if nothing has shipped. */
  last_shipped_at: string | null;
}

/* ---------- SUB-112 Reverse ETL ----------------------------------- */
// Warehouse-managed traits sync BACK onto subscribers as custom fields.
// A mapping belongs to a warehouse connection. Backend:
// apps/api/internal/warehouse/reverse_etl.go.

export type ReverseETLCastType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export interface ReverseETLMapping {
  id?: string;
  tenant_id?: string;
  connection_id?: string;
  source_table: string;
  /** Column in the warehouse row matched against subscribers (default email). */
  profile_key_column: string;
  /** Subscriber field the key matches — backend requires "email". */
  profile_key_target: string;
  source_column: string;
  /** Custom-field key the warehouse value is written to. */
  target_field_key: string;
  cast_type: ReverseETLCastType | string;
  /** draft | active | paused */
  status: string;
  version: number;
  last_synced_at?: string | null;
  last_row_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface ReverseETLMappingInput {
  expected_version: number;
  source_table: string;
  source_column: string;
  target_field_key: string;
  profile_key_column?: string;
  profile_key_target?: string;
  cast_type?: ReverseETLCastType | string;
  status?: string;
}

export interface ReverseETLSyncInput {
  expected_connection_version: number;
  source_table?: string;
  /** Inline staged warehouse rows (v1). */
  rows: Array<Record<string, unknown>>;
}

export interface ReverseETLSyncResult {
  connection_id: string;
  mappings_applied: number;
  rows_scanned: number;
  subscribers_matched: number;
  fields_written: number;
}

// ── Bidirectional integration write-back (reverse-ETL) ──────────────────────
// Pushes a list/segment's membership + each subscriber's computed traits BACK
// into Shopify/HubSpot/Salesforce/Pipedrive/Klaviyo — the direct-API sibling of the
// webhook-delivery audience_destinations. Backend:
// apps/api/internal/integration_writeback/handlers.go.

export interface WritebackProvider {
  provider: string;
  available: boolean;
}

export interface WritebackTarget {
  id: string;
  tenant_id?: string;
  provider: string;
  name: string;
  status: string;
  credentials_ref?: string;
  settings?: Record<string, unknown>;
  sync_interval_minutes: number;
  last_run_at?: string | null;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface WritebackTargetInput {
  provider: string;
  name?: string;
  status?: string;
  credentials_ref: string;
  settings?: Record<string, unknown>;
  sync_interval_minutes?: number;
}

export interface WritebackRunSummary {
  run_id?: string;
  status: string;
  members_seen: number;
  matched: number;
  tags_written: number;
  fields_written: number;
  rows_failed: number;
  error_message?: string;
}

export interface WritebackRun {
  id: string;
  target_id?: string;
  run_mode: string;
  status: string;
  members_seen: number;
  matched: number;
  tags_written: number;
  fields_written: number;
  rows_failed: number;
  error_message?: string;
  started_at: string;
  completed_at?: string | null;
  created_at: string;
}

const WRITEBACK_BASE = "/api/v1/integration-writeback";

export function createWarehouseApis(request: WarehouseRequester) {
  const writebackApi = {
    /** GET /providers (admin) — adapter availability. */
    providers(): Promise<ApiResult<{ items: WritebackProvider[] }>> {
      return request<{ items: WritebackProvider[] }>(
        `${WRITEBACK_BASE}/providers`,
      );
    },
    /** GET /targets → `{items}`. */
    listTargets(): Promise<ApiResult<{ items: WritebackTarget[] }>> {
      return request<{ items: WritebackTarget[] }>(`${WRITEBACK_BASE}/targets`);
    },
    /** POST /targets (admin) — create / upsert. */
    createTarget(
      input: WritebackTargetInput,
    ): Promise<ApiResult<WritebackTarget>> {
      return request<WritebackTarget>(`${WRITEBACK_BASE}/targets`, {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** POST /targets/{id}/run (admin) — run now, returns a RunSummary. */
    runTarget(id: string): Promise<ApiResult<WritebackRunSummary>> {
      return request<WritebackRunSummary>(
        `${WRITEBACK_BASE}/targets/${encodeURIComponent(id)}/run`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** POST /targets/{id}/pause (admin). */
    pauseTarget(id: string): Promise<ApiResult<WritebackTarget>> {
      return request<WritebackTarget>(
        `${WRITEBACK_BASE}/targets/${encodeURIComponent(id)}/pause`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
    /** DELETE /targets/{id} (admin) — disconnect. */
    disconnectTarget(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `${WRITEBACK_BASE}/targets/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
    /** GET /targets/{id}/runs → `{items}` — run history. */
    listRuns(
      id: string,
      limit = 25,
    ): Promise<ApiResult<{ items: WritebackRun[] }>> {
      return request<{ items: WritebackRun[] }>(
        `${WRITEBACK_BASE}/targets/${encodeURIComponent(id)}/runs?limit=${limit}`,
      );
    },
  };

  const warehouseApi = {
    /** GET /api/v1/warehouse/catalog. */
    catalog(): Promise<ApiResult<WarehouseCatalogResponse>> {
      return request<WarehouseCatalogResponse>("/api/v1/warehouse/catalog");
    },
    /** GET /api/v1/warehouse/providers. */
    providers(): Promise<ApiResult<{ items: WarehouseProviderSpec[] }>> {
      return request<{ items: WarehouseProviderSpec[] }>(
        "/api/v1/warehouse/providers",
      );
    },
    /** POST /api/v1/warehouse/validate (admin) — dry connection check. */
    validate(
      input: WarehouseConnectionInput,
    ): Promise<ApiResult<WarehouseValidationResult>> {
      return request<WarehouseValidationResult>("/api/v1/warehouse/validate", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/warehouse/connections[?status=] → `{items}`. */
    listConnections(
      status?: string,
    ): Promise<ApiResult<{ items: WarehouseConnection[] }>> {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<{ items: WarehouseConnection[] }>(
        `/api/v1/warehouse/connections${qs}`,
      );
    },
    /** POST /api/v1/warehouse/connections (admin) — 201, or 400 with the
     *  validation result. */
    createConnection(
      input: WarehouseConnectionInput,
    ): Promise<ApiResult<WarehouseConnection>> {
      return request<WarehouseConnection>("/api/v1/warehouse/connections", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    /** GET /api/v1/warehouse/connections/{id}. */
    getConnection(id: string): Promise<ApiResult<WarehouseConnection>> {
      return request<WarehouseConnection>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}`,
      );
    },
    /** GET /api/v1/warehouse/connections/{id}/health. */
    connectionHealth(
      id: string,
      providerCheck = false,
    ): Promise<ApiResult<Record<string, unknown>>> {
      const query = providerCheck ? "?provider_check=true" : "";
      return request<Record<string, unknown>>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/health${query}`,
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/pause. */
    pauseConnection(
      id: string,
      expectedVersion: number,
    ): Promise<ApiResult<WarehouseConnection>> {
      return request<WarehouseConnection>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/pause`,
        {
          method: "POST",
          body: JSON.stringify({ expected_version: expectedVersion }),
        },
      );
    },
    /** DELETE /api/v1/warehouse/connections/{id}; retains audit evidence. */
    deleteConnection(
      id: string,
      expectedVersion: number,
      confirmationName: string,
    ): Promise<ApiResult<WarehouseDisconnectReceipt>> {
      return request<WarehouseDisconnectReceipt>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expected_version: expectedVersion,
            confirmation_name: confirmationName,
          }),
        },
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/provider-cleanup/acknowledge. */
    acknowledgeProviderCleanup(
      id: string,
      input: WarehouseProviderCleanupAcknowledgementInput,
    ): Promise<ApiResult<WarehouseProviderCleanupAcknowledgementResponse>> {
      return request<WarehouseProviderCleanupAcknowledgementResponse>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/provider-cleanup/acknowledge`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** GET /api/v1/warehouse/connections/{id}/mappings → `{items}`. */
    listMappings(
      id: string,
    ): Promise<ApiResult<{ items: WarehouseImportMapping[] }>> {
      return request<{ items: WarehouseImportMapping[] }>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/mappings`,
      );
    },
    /** PUT /api/v1/warehouse/connections/{id}/mappings/{source_object} (admin). */
    putMapping(
      id: string,
      sourceObject: string,
      input: Partial<WarehouseImportMapping>,
    ): Promise<ApiResult<WarehouseImportMapping>> {
      return request<WarehouseImportMapping>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/mappings/${encodeURIComponent(sourceObject)}`,
        { method: "PUT", body: JSON.stringify(input) },
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/runs (admin) — 202, the run. */
    runConnection(
      id: string,
      expectedConnectionVersion: number,
      input: Record<string, unknown> = {},
    ): Promise<ApiResult<WarehouseSyncRun>> {
      return request<WarehouseSyncRun>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/runs`,
        {
          method: "POST",
          body: JSON.stringify({
            ...input,
            expected_connection_version: expectedConnectionVersion,
          }),
        },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    /** POST /api/v1/warehouse/runs/due?limit= (admin) — 202 {items, count}. */
    runDue(
      limit?: number,
    ): Promise<ApiResult<{ items: WarehouseSyncRun[]; count: number }>> {
      const qs = limit != null ? `?limit=${limit}` : "";
      return request<{ items: WarehouseSyncRun[]; count: number }>(
        `/api/v1/warehouse/runs/due${qs}`,
        { method: "POST", body: JSON.stringify({}) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
    /** GET /api/v1/warehouse/runs?id=<connection> → `{items}`. The Go
     *  handler reads the connection filter from the chi URL param slot,
     *  so pass it as ?id= is NOT supported — list is tenant-wide. */
    listRuns(): Promise<ApiResult<{ items: WarehouseSyncRun[] }>> {
      return request<{ items: WarehouseSyncRun[] }>("/api/v1/warehouse/runs");
    },
    /** GET /api/v1/warehouse/connections/{id}/runs. */
    listConnectionRuns(
      id: string,
    ): Promise<ApiResult<{ items: WarehouseSyncRun[] }>> {
      return request<{ items: WarehouseSyncRun[] }>(
        `/api/v1/warehouse/connections/${encodeURIComponent(id)}/runs`,
      );
    },
    /** GET /api/v1/warehouse/runs/{id}. */
    getRun(id: string): Promise<ApiResult<WarehouseSyncRun>> {
      return request<WarehouseSyncRun>(
        `/api/v1/warehouse/runs/${encodeURIComponent(id)}`,
      );
    },
    /** GET /api/v1/warehouse/runs/{id}/errors → `{items}`. */
    listRunErrors(
      id: string,
    ): Promise<ApiResult<{ items: Record<string, unknown>[] }>> {
      return request<{ items: Record<string, unknown>[] }>(
        `/api/v1/warehouse/runs/${encodeURIComponent(id)}/errors`,
      );
    },

    /* ----- SUB-111 streaming export ----- */

    /** POST /api/v1/warehouse/streaming/validate (admin) — validates a
     *  streaming-export config block; returns {valid, errors?, warnings?}. */
    validateStreaming(
      config: StreamingExportConfig | Record<string, unknown>,
    ): Promise<ApiResult<WarehouseValidationResult>> {
      return request<WarehouseValidationResult>(
        "/api/v1/warehouse/streaming/validate",
        { method: "POST", body: JSON.stringify({ config }) },
      );
    },
    /** GET /api/v1/warehouse/connections/{id}/streaming/runs → runs +
     *  last_shipped_at. */
    listStreamingRuns(
      connectionId: string,
    ): Promise<ApiResult<StreamingExportRunsResponse>> {
      return request<StreamingExportRunsResponse>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/streaming/runs`,
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/streaming/ship (admin) —
     *  ships the next due window synchronously; 200 with the completed run. */
    shipStreaming(
      connectionId: string,
      expectedConnectionVersion: number,
    ): Promise<ApiResult<StreamingExportRun>> {
      return request<StreamingExportRun>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/streaming/ship`,
        {
          method: "POST",
          body: JSON.stringify({
            expected_connection_version: expectedConnectionVersion,
          }),
        },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },

    /* ----- SUB-112 reverse ETL ----- */

    /** GET /api/v1/warehouse/connections/{id}/reverse-etl-mappings → `{items}`. */
    listReverseETLMappings(
      connectionId: string,
    ): Promise<ApiResult<{ items: ReverseETLMapping[] }>> {
      return request<{ items: ReverseETLMapping[] }>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/reverse-etl-mappings`,
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/reverse-etl-mappings (admin)
     *  → 201, a create-only or exact-version mapping. */
    createReverseETLMapping(
      connectionId: string,
      input: ReverseETLMappingInput,
    ): Promise<ApiResult<ReverseETLMapping>> {
      return request<ReverseETLMapping>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/reverse-etl-mappings`,
        { method: "POST", body: JSON.stringify(input) },
      );
    },
    /** DELETE /api/v1/warehouse/connections/{id}/reverse-etl-mappings/{mapping_id}
     *  (admin) → 200 with a versioned delete receipt. */
    deleteReverseETLMapping(
      connectionId: string,
      mappingId: string,
      expectedVersion: number,
      confirmationTarget: string,
    ): Promise<ApiResult<{ ok: true; id: string; previous_version: number }>> {
      return request<{ ok: true; id: string; previous_version: number }>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/reverse-etl-mappings/${encodeURIComponent(mappingId)}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expected_version: expectedVersion,
            confirmation_target: confirmationTarget,
          }),
        },
      );
    },
    /** POST /api/v1/warehouse/connections/{id}/reverse-etl-sync — applies the
     *  connection's active mappings to the staged rows; returns a summary. */
    syncReverseETL(
      connectionId: string,
      input: ReverseETLSyncInput,
    ): Promise<ApiResult<ReverseETLSyncResult>> {
      return request<ReverseETLSyncResult>(
        `/api/v1/warehouse/connections/${encodeURIComponent(connectionId)}/reverse-etl-sync`,
        { method: "POST", body: JSON.stringify(input) },
        { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
      );
    },
  };

  return { writebackApi, warehouseApi };
}
