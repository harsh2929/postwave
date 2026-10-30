/**
 * Pure helpers for the Data Platform → Warehouse section (#35).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire notes (WIRING-WRAPPERS.md #35): lists → {items}; POST
 * /warehouse/connections returns 201 with the row OR 400 whose JSON
 * body IS the ValidationResult ({valid, errors?, warnings?}) — that
 * body surfaces through res.error.message, recovered here.
 */

import type {
  StreamingExportConfig,
  StreamingExportRun,
  WarehouseConnection,
  WarehouseImportMapping,
  WarehouseSyncRun,
  WarehouseValidationResult,
} from "../../lib/api-client";

/* ---------- connection editor draft ---------- */

export interface ConnectionDraft {
  name: string;
  provider: string;
  direction: string;
  cadence: string;
  backfillDays: string;
  credentialsRef: string;
  /** Raw JSON for the provider config object. Empty = {}. */
  configText: string;
  objectSelection: string[];
}

export function emptyConnectionDraft(): ConnectionDraft {
  return {
    name: "",
    provider: "",
    direction: "export",
    cadence: "manual",
    backfillDays: "30",
    credentialsRef: "",
    configText: "",
    objectSelection: [],
  };
}

export function connectionDraftErrors(
  d: ConnectionDraft,
): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (!d.provider.trim()) e.provider = "Pick a provider";
  if (d.objectSelection.length === 0) {
    e.objectSelection = "Select at least one object to sync";
  }
  const days = Number(d.backfillDays.trim());
  // GAP-1#10: the server has no zero-backfill sentinel — it silently
  // converts backfill_days 0 → a 90-day default. Accepting "0" here would
  // export 90 days of history against the operator's intent, so require ≥ 1
  // and say so rather than promising a zero-backfill the backend won't honor.
  if (
    d.backfillDays.trim() === "" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3650
  ) {
    e.backfillDays =
      "Backfill days must be a whole number from 1 to 3,650 (0 isn't zero-backfill — the server applies a 90-day default)";
  }
  if (d.configText.trim()) {
    try {
      const parsed: unknown = JSON.parse(d.configText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        e.config = "Config must be a JSON object";
      }
    } catch {
      e.config = "Config is not valid JSON";
    }
  }
  return e;
}

export function connectionDraftToInput(
  d: ConnectionDraft,
): Partial<WarehouseConnection> {
  let config: Record<string, unknown> | undefined;
  if (d.configText.trim()) {
    try {
      const parsed: unknown = JSON.parse(d.configText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      /* validated upstream; omit on parse failure */
    }
  }
  return {
    name: d.name.trim(),
    provider: d.provider.trim(),
    direction: d.direction,
    cadence: d.cadence,
    // GAP-1#3: the server defaults status to "draft", and every downstream
    // path (reverse-ETL mutations, scheduled runs, streaming shipments)
    // requires status = "active". With no activate control in the UI, a
    // draft connection dead-ends the whole surface, so create it active. The
    // server still rejects "active" for planned providers (surfaced as a
    // validation error), so this only activates connections that can run.
    status: "active",
    backfill_days: Number(d.backfillDays.trim()) || 0,
    object_selection: d.objectSelection,
    ...(d.credentialsRef.trim()
      ? { credentials_ref: d.credentialsRef.trim() }
      : {}),
    ...(config ? { config } : {}),
  };
}

export function toggleSelection(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

/* ---------- 400-body validation recovery ---------- */

/**
 * The create endpoint's 400 body IS the ValidationResult (deviation
 * #5 in WIRING-WRAPPERS.md). The JSON lands in res.error.message;
 * recover the structured form when possible and immediately map every
 * untrusted server string to bounded local copy. Null means the message
 * was not a validation body; callers must use a generic transport failure.
 *
 * GAP-1#13: the client core truncates unenveloped error bodies to 200
 * chars (api-client.ts errorFromResponse), so a large errors+warnings
 * ValidationResult arrives here as unparseable, truncated JSON and this
 * returns null. Callers MUST NOT dump that truncated blob at the user —
 * on null they should re-fetch the full structured result from the
 * validate endpoint (POST /warehouse/validate, which always answers 200
 * with the complete, untruncated ValidationResult). See
 * WarehouseSection.save() / StreamingExportForm for the fallback.
 */
export function extractWarehouseValidation(
  message: string | undefined,
): WarehouseValidationResult | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.valid !== "boolean") return null;
  return {
    valid: o.valid,
    errors: safeValidationCopy(o.errors, "error"),
    warnings: safeValidationCopy(o.warnings, "warning"),
  };
}

const MAX_VALIDATION_MESSAGES = 12;
const PROVIDER_FIELD_LABELS = [
  ["account_id", "account ID"],
  ["account_url", "account URL"],
  ["workspace_url", "workspace URL"],
  ["warehouse_id", "warehouse ID"],
  ["import_table", "import table"],
  ["credentials_ref", "credentials reference"],
  ["database", "database"],
  ["dataset", "dataset"],
  ["location", "location"],
  ["container", "container"],
  ["sslmode", "SSL mode"],
  ["warehouse", "warehouse"],
  ["bucket", "bucket"],
  ["region", "region"],
  ["account", "account"],
  ["schema", "schema"],
  ["catalog", "catalog"],
  ["stage", "stage"],
  ["role", "role"],
  ["host", "host"],
  ["port", "port"],
] as const;

function classifiedValidationCopy(
  value: string,
  kind: "error" | "warning",
): string {
  const lower = value.toLowerCase();
  if (
    /raw credential|password|private key|access token|secret key/.test(lower)
  ) {
    return "Remove raw credential material and provide only an approved credentials reference.";
  }
  if (/endpoint|base_url|api_base/.test(lower)) {
    return "Remove custom endpoint overrides; trusted provider drivers derive their endpoints.";
  }
  if (/name is required/.test(lower)) return "Add a connection name.";
  if (/provider must/.test(lower)) return "Choose a supported provider.";
  if (/direction must/.test(lower))
    return "Choose a supported movement direction.";
  if (/status must/.test(lower)) return "Choose a supported connection status.";
  if (/cadence must/.test(lower)) return "Choose a supported run cadence.";
  if (/backfill_days/.test(lower)) {
    return "Choose a backfill window between 1 and 3,650 days.";
  }
  if (/unsupported object/.test(lower)) {
    return "Choose only objects advertised by the verified warehouse catalog.";
  }
  if (/missing required provider settings/.test(lower)) {
    return "Complete every required provider setting before activation.";
  }
  if (/planned|not executable|driver/.test(lower)) {
    return "This provider runtime is not attached for live execution yet.";
  }
  if (/storage adapter|object.storage/.test(lower)) {
    return "Object-storage movement uses the workspace storage adapter; destination fields remain readiness metadata until a tenant driver is attached.";
  }
  if (/manifest|managed sql/.test(lower)) {
    return "This provider records an auditable manifest until its live movement worker is attached.";
  }
  const providerField = PROVIDER_FIELD_LABELS.find(([field]) =>
    new RegExp(
      `(^|[^a-z0-9_])${field.replace("_", "[_ ]")}([^a-z0-9_]|$)`,
    ).test(lower),
  );
  if (providerField) {
    return `Review the ${providerField[1]} field; it does not match the provider's accepted format.`;
  }
  return kind === "error"
    ? "The server rejected part of this connection configuration. Review the highlighted fields."
    : "The server reported a connection-readiness warning. Review provider availability before saving.";
}

function safeValidationCopy(
  value: unknown,
  kind: "error" | "warning",
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const copy: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const classified = classifiedValidationCopy(item, kind);
    if (!copy.includes(classified)) copy.push(classified);
    if (copy.length >= MAX_VALIDATION_MESSAGES) break;
  }
  return copy;
}

/* ---------- mapping editor draft ---------- */

export interface MappingDraft {
  sourceObject: string;
  targetEventName: string;
  profileKeyColumn: string;
  occurredAtColumn: string;
  /** Raw JSON for property_map. Empty = omit. */
  propertyMapText: string;
  status: string;
}

export function mappingDraftFrom(
  sourceObject: string,
  m?: WarehouseImportMapping | null,
): MappingDraft {
  return {
    sourceObject,
    targetEventName: m?.target_event_name ?? "",
    profileKeyColumn: m?.profile_key_column ?? "",
    occurredAtColumn: m?.occurred_at_column ?? "",
    propertyMapText:
      m?.property_map && Object.keys(m.property_map).length > 0
        ? JSON.stringify(m.property_map, null, 2)
        : "",
    status: m?.status ?? "active",
  };
}

export function mappingDraftErrors(d: MappingDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.targetEventName.trim())
    e.targetEventName = "Target event name is required";
  if (!d.profileKeyColumn.trim())
    e.profileKeyColumn = "Profile-key column is required";
  if (!d.occurredAtColumn.trim())
    e.occurredAtColumn = "Occurred-at column is required";
  if (d.propertyMapText.trim()) {
    try {
      const parsed: unknown = JSON.parse(d.propertyMapText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        e.propertyMap = "Property map must be a JSON object";
      }
    } catch {
      e.propertyMap = "Property map is not valid JSON";
    }
  }
  return e;
}

export function mappingDraftToInput(
  d: MappingDraft,
): Partial<WarehouseImportMapping> {
  let propertyMap: Record<string, unknown> | undefined;
  if (d.propertyMapText.trim()) {
    try {
      const parsed: unknown = JSON.parse(d.propertyMapText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        propertyMap = parsed as Record<string, unknown>;
      }
    } catch {
      /* validated upstream */
    }
  }
  return {
    source_object: d.sourceObject,
    target_event_name: d.targetEventName.trim(),
    profile_key_column: d.profileKeyColumn.trim(),
    occurred_at_column: d.occurredAtColumn.trim(),
    status: d.status,
    ...(propertyMap ? { property_map: propertyMap } : {}),
  };
}

/* ---------- run display ---------- */

export type BadgeTone = "success" | "warning" | "danger" | "neutral";

export function runStatusTone(status: string): BadgeTone {
  const s = (status || "").toLowerCase();
  if (["succeeded", "success", "completed"].includes(s)) return "success";
  if (["running", "queued", "pending"].includes(s)) return "warning";
  if (["failed", "error"].includes(s)) return "danger";
  return "neutral";
}

/** "12,340 scanned · 12,001 exported · 4 failed" — only segments that
 *  carry signal for this run's direction. */
export function runRowCounts(r: WarehouseSyncRun): string {
  const parts: string[] = [];
  if (r.rows_scanned > 0)
    parts.push(`${r.rows_scanned.toLocaleString()} scanned`);
  if (r.rows_exported > 0)
    parts.push(`${r.rows_exported.toLocaleString()} exported`);
  if (r.rows_imported > 0)
    parts.push(`${r.rows_imported.toLocaleString()} imported`);
  if (r.rows_failed > 0) parts.push(`${r.rows_failed.toLocaleString()} failed`);
  if (r.schema_errors > 0)
    parts.push(`${r.schema_errors.toLocaleString()} schema errors`);
  return parts.length > 0 ? parts.join(" · ") : "no rows";
}

/**
 * Honest response copy for the current warehouse handler. It answers 202, but
 * performs the provider/storage work inline before returning; do not call the
 * response merely "queued" or imply background progress that does not exist.
 */
export function runQueuedMessage(r: WarehouseSyncRun): string {
  return `Run ${r.id.slice(0, 8)}… returned after inline execution (HTTP 202) — status “${r.status}”; ${runRowCounts(r)}.`;
}

/** Sort the catalog's well-known columns out of an arbitrary error
 *  row, so the per-run errors table renders stable columns first. */
export function runErrorColumns(
  rows: Array<Record<string, unknown>>,
): string[] {
  const preferred = [
    "row",
    "line",
    "source_object",
    "field",
    "code",
    "message",
    "error",
  ];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  const cols = preferred.filter((c) => seen.has(c));
  for (const k of [...seen].sort()) if (!cols.includes(k)) cols.push(k);
  return cols;
}

export function cellText(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* =====================================================================
 * SUB-111 — Streaming export (Currents-style) helpers.
 *
 * A streaming-export destination is a warehouse_connection with
 * provider="streaming_export"; the streaming-specific knobs (format,
 * compression, batch_size, prefix, and field filters live in connection.config.
 * These pure helpers drive the StreamingExportForm + StreamingExportStatus
 * components — render-free so they unit-test under node vitest.
 * =================================================================== */

export const STREAMING_PROVIDER = "streaming_export";

export const STREAMING_FORMATS = ["parquet", "avro"] as const;
export const STREAMING_COMPRESSIONS = [
  "snappy",
  "gzip",
  "zstd",
  "none",
] as const;
/** Batch interval maps to a cadence on the underlying connection. */
export const STREAMING_INTERVALS = ["hourly"] as const;

/** Backend clamp bounds (streaming_export.go). */
export const STREAMING_MIN_BATCH = 100;
export const STREAMING_MAX_BATCH = 1_000_000;
export const STREAMING_DEFAULT_BATCH = 10_000;

export interface StreamingExportDraft {
  name: string;
  prefix: string;
  format: string;
  compression: string;
  /** "hourly" | "daily" — maps to the connection cadence. */
  interval: string;
  batchSize: string;
  /** Comma-separated optional event-type filters. Empty = all. */
  fieldFilters: string;
}

export function emptyStreamingExportDraft(): StreamingExportDraft {
  return {
    name: "",
    prefix: "streaming-export",
    format: "parquet",
    compression: "snappy",
    interval: "hourly",
    batchSize: String(STREAMING_DEFAULT_BATCH),
    fieldFilters: "",
  };
}

export function streamingDraftErrors(
  d: StreamingExportDraft,
): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (
    !STREAMING_FORMATS.includes(d.format as (typeof STREAMING_FORMATS)[number])
  ) {
    e.format = "Format must be parquet or avro";
  }
  if (
    !STREAMING_COMPRESSIONS.includes(
      d.compression as (typeof STREAMING_COMPRESSIONS)[number],
    )
  ) {
    e.compression = "Pick a supported compression";
  }
  const bs = Number(d.batchSize.trim());
  if (
    d.batchSize.trim() === "" ||
    !Number.isInteger(bs) ||
    bs < STREAMING_MIN_BATCH ||
    bs > STREAMING_MAX_BATCH
  ) {
    e.batchSize = `Batch size must be between ${STREAMING_MIN_BATCH.toLocaleString()} and ${STREAMING_MAX_BATCH.toLocaleString()}`;
  }
  return e;
}

/** Builds the streaming-export config block from a draft. */
export function streamingDraftToConfig(
  d: StreamingExportDraft,
): StreamingExportConfig & Record<string, unknown> {
  const cfg: StreamingExportConfig & Record<string, unknown> = {
    format: d.format,
    compression: d.compression,
    batch_size: Number(d.batchSize.trim()) || STREAMING_DEFAULT_BATCH,
  };
  if (d.prefix.trim()) cfg.prefix = d.prefix.trim();
  const filters = streamingFilterList(d.fieldFilters);
  if (filters.length > 0) cfg.field_filters = filters;
  return cfg;
}

/** Maps a draft to the warehouse-connection create payload (provider is
 *  pinned to streaming_export; cadence carries the batch interval). */
export function streamingDraftToConnectionInput(
  d: StreamingExportDraft,
): Partial<WarehouseConnection> {
  return {
    name: d.name.trim(),
    provider: STREAMING_PROVIDER,
    direction: "export",
    cadence: "hourly",
    // GAP-1#3: streaming exports must be active for the worker's
    // ListDueConnections to pick them up on the configured interval;
    // otherwise the "worker ships on the configured interval" promise is
    // false and only manual "Ship window now" works.
    status: "active",
    backfill_days: 1,
    // Streaming export prepares subscriber events + profile context; the
    // object selection is fixed for this provider.
    object_selection: ["events", "profiles"],
    config: streamingDraftToConfig(d),
  };
}

/** Splits the comma/newline-separated field-filter input into a clean list. */
export function streamingFilterList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Is this connection a streaming-export destination? */
export function isStreamingConnection(c: WarehouseConnection): boolean {
  return c.provider === STREAMING_PROVIDER;
}

/** Reads the streaming config block off a connection (defaults applied). */
export function streamingConfigOf(
  c: WarehouseConnection,
): StreamingExportConfig {
  const cfg = (c.config ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof cfg[k] === "string" ? (cfg[k] as string) : undefined;
  const num = (k: string): number | undefined =>
    typeof cfg[k] === "number" ? (cfg[k] as number) : undefined;
  return {
    format: str("format") ?? "parquet",
    compression: str("compression") ?? "snappy",
    batch_size: num("batch_size") ?? STREAMING_DEFAULT_BATCH,
    prefix: str("prefix"),
    field_filters: Array.isArray(cfg.field_filters)
      ? cfg.field_filters.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}

/** Hourly throughput in rows/second for one completed run window. */
export function streamingThroughput(run: StreamingExportRun): number {
  const start = Date.parse(run.window_start);
  const end = Date.parse(run.window_end);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return run.rows_shipped / ((end - start) / 1000);
}

/** Cumulative rows across a run list. */
export function streamingCumulativeRows(runs: StreamingExportRun[]): number {
  return runs.reduce((sum, r) => sum + (r.rows_shipped || 0), 0);
}

/** Compact bytes formatter (KB/MB/GB) for shipped-bytes display. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
