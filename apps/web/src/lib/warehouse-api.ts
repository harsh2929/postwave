// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strict, tenant-bound web client for warehouse, streaming-export, and
 * reverse-ETL operations. Sensitive provider values are never returned by
 * these decoders or placed in query keys. Every write is online-only,
 * single-attempt, caller-idempotent, and exact-versioned.
 */
import { api } from "@/lib/api";

export type WarehouseRole = "owner" | "admin";

export interface WarehouseAuthority {
  tenantId: string;
  userId: string;
  role: WarehouseRole;
}

export interface WarehouseProviderField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  help: string;
}

export interface WarehouseProvider {
  provider: string;
  name: string;
  auth_mode: string;
  managed: boolean;
  runtime_status: string;
  capabilities: string[];
  required_settings: WarehouseProviderField[];
  optional_settings: WarehouseProviderField[];
  sync_objects: string[];
  docs_url: string;
}

export interface WarehouseCatalogItem {
  key: string;
  label: string;
  runtime_status: string;
}

export interface WarehouseCatalog {
  schema_version: string;
  providers: WarehouseCatalogItem[];
  directions: string[];
  cadences: string[];
  objects: WarehouseCatalogItem[];
  import_targets: WarehouseCatalogItem[];
  workers: WarehouseCatalogItem[];
}

export interface WarehouseConnection {
  id: string;
  tenant_id: string;
  name: string;
  provider: string;
  direction: "export" | "import" | "bidirectional";
  status: "draft" | "active" | "paused" | "error" | "disconnected";
  credential_ref_present: boolean;
  config: Record<string, unknown>;
  object_selection: string[];
  cadence: "manual" | "hourly" | "daily" | "weekly";
  backfill_days: number;
  issue_present: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WarehouseConnectionInput {
  name: string;
  provider: string;
  direction: "export" | "import" | "bidirectional";
  status: "draft" | "active" | "paused";
  credentials_ref?: string;
  config: Record<string, unknown>;
  object_selection: string[];
  cadence: "manual" | "hourly" | "daily" | "weekly";
  backfill_days: number;
}

export interface WarehouseValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface WarehouseRun {
  id: string;
  tenant_id: string;
  connection_id: string;
  direction: "export" | "import";
  run_mode: "manual" | "scheduled" | "backfill" | "retry" | "dry_run";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  object_selection: string[];
  rows_scanned: number;
  rows_exported: number;
  rows_imported: number;
  rows_failed: number;
  schema_errors: number;
  retry_count: number;
  issue_present: boolean;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseConnectionHealth {
  connection_id: string;
  provider: string;
  status: string;
  health: string;
  last_run_status: string | null;
  last_run_at: string | null;
  missing_required_settings: string[];
  warning_count: number;
  issue_present: boolean;
  provider_runtime_status: string | null;
  provider_driver_attachment: string | null;
  provider_health: {
    state: string;
    live_state: string | null;
    execution_mode: string | null;
    executable: boolean;
    statements_executed: number;
    missing_required_settings: string[];
    warning_count: number;
    issue_present: boolean;
  } | null;
}

export interface WarehouseImportMapping {
  id: string;
  tenant_id: string;
  connection_id: string;
  source_object: string;
  target_event_name: string;
  profile_key_column: string;
  occurred_at_column: string;
  property_map: Record<string, unknown>;
  validation_rules: Record<string, unknown>;
  status: "draft" | "active" | "paused";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface WarehouseImportMappingInput {
  target_event_name: string;
  profile_key_column: string;
  occurred_at_column: string;
  property_map: Record<string, unknown>;
  validation_rules: Record<string, unknown>;
  status: "draft" | "active" | "paused";
}

export interface ReverseETLMapping {
  id: string;
  tenant_id: string;
  connection_id: string;
  source_table: string;
  profile_key_column: string;
  profile_key_target: "email";
  source_column: string;
  target_field_key: string;
  cast_type: "string" | "number" | "boolean" | "date" | "datetime" | "json";
  status: "draft" | "active" | "paused";
  version: number;
  last_synced_at: string | null;
  last_row_count: number;
  created_at: string;
  updated_at: string;
}

export interface ReverseETLMappingInput {
  source_table: string;
  profile_key_column: string;
  profile_key_target: "email";
  source_column: string;
  target_field_key: string;
  cast_type: ReverseETLMapping["cast_type"];
  status: ReverseETLMapping["status"];
}

export interface ReverseETLSyncResult {
  connection_id: string;
  mappings_applied: number;
  rows_scanned: number;
  subscribers_matched: number;
  fields_written: number;
}

export interface StreamingExportRun {
  id: string;
  connection_id: string;
  status: "running" | "completed" | "failed" | "empty";
  format: "parquet" | "avro";
  compression: "none" | "snappy" | "gzip" | "zstd";
  window_start: string;
  window_end: string;
  cursor_from: number;
  cursor_to: number;
  has_more: boolean;
  rows_shipped: number;
  bytes_shipped: number;
  issue_present: boolean;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface WarehouseDeleteReceipt {
  ok: true;
  id: string;
  previous_version: number;
  version: number;
  status: "disconnected";
}

export interface WarehouseCleanupReceipt {
  ok: true;
  id: string;
  previous_version: number;
  version: number;
}

export interface WarehouseRowErrorEvidence {
  id: number;
  run_id: string;
  source_object: string;
  row_number: number;
  error_code: string;
  message_present: boolean;
  created_at: string;
}

export class WarehouseContractError extends Error {
  readonly code = "warehouse_contract_error";

  constructor(message = "The warehouse service returned an invalid response.") {
    super(message);
    this.name = "WarehouseContractError";
  }
}

export class WarehouseInputError extends Error {
  readonly code = "warehouse_input_error";

  constructor(message: string) {
    super(message);
    this.name = "WarehouseInputError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const SENSITIVE_JSON_KEYS = new Set([
  "accesskeyid",
  "accesstoken",
  "accountkey",
  "apikey",
  "apisecret",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "clientsecret",
  "connectionstring",
  "credentialref",
  "credentialsref",
  "password",
  "pat",
  "personalaccesstoken",
  "privatekey",
  "privatekeyjson",
  "providercleanup",
  "refreshtoken",
  "sastoken",
  "secret",
  "secretaccesskey",
  "serviceaccountjson",
  "sharedkey",
  "storageaccountkey",
  "token",
]);
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_DEPTH = 24;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WarehouseContractError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    Array.from(value).length > max ||
    CONTROL_RE.test(value)
  ) {
    throw new WarehouseContractError(`${label} is invalid.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  max = 256,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return stringValue(value, label, max);
}

function token(value: unknown, label: string): string {
  const out = stringValue(value, label, 256);
  if (!TOKEN_RE.test(out))
    throw new WarehouseContractError(`${label} is unsafe.`);
  return out;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new WarehouseContractError(`${label} is not a canonical UUID.`);
  }
  return value;
}

function inputUuid(value: string, label: string): string {
  if (!UUID_RE.test(value))
    throw new WarehouseInputError(`${label} must be a canonical UUID.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !RFC3339_RE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new WarehouseContractError(`${label} is not a valid timestamp.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : timestamp(value, label);
}

function integer(
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new WarehouseContractError(`${label} is invalid.`);
  }
  return value as number;
}

function positiveVersion(value: unknown, label = "Version"): number {
  return integer(value, label, 1);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new WarehouseContractError(`${label} is invalid.`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new WarehouseContractError(`${label} is invalid.`);
  }
  return value as T;
}

function stringArray(value: unknown, label: string, max = 200): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new WarehouseContractError(`${label} is invalid.`);
  }
  const out = value.map((item, index) => token(item, `${label}[${index}]`));
  if (new Set(out).size !== out.length) {
    throw new WarehouseContractError(`${label} contains duplicates.`);
  }
  return out;
}

function cloneJSON(
  value: unknown,
  label: string,
  rejectSensitive = false,
): Record<string, unknown> {
  const source = record(value ?? {}, label);
  let serialized: string;
  let decoded: unknown;
  try {
    serialized = JSON.stringify(source);
    decoded = JSON.parse(serialized);
  } catch {
    throw new WarehouseContractError(`${label} is not serializable JSON.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw new WarehouseContractError(`${label} exceeds the supported size.`);
  }
  let remaining = MAX_JSON_NODES;
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH || --remaining < 0) {
      throw new WarehouseContractError(
        `${label} exceeds the supported complexity.`,
      );
    }
    if (Array.isArray(node)) {
      if (node.length > 1_024)
        throw new WarehouseContractError(
          `${label} contains an oversized array.`,
        );
      return node.map((item) => visit(item, depth + 1));
    }
    if (node && typeof node === "object") {
      const input = node as Record<string, unknown>;
      const keys = Object.keys(input);
      if (keys.length > 1_024)
        throw new WarehouseContractError(`${label} contains too many keys.`);
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (
          !key ||
          key.length > 128 ||
          CONTROL_RE.test(key) ||
          ["__proto__", "prototype", "constructor"].includes(key)
        ) {
          throw new WarehouseContractError(`${label} contains an unsafe key.`);
        }
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
        if (rejectSensitive && SENSITIVE_JSON_KEYS.has(normalized)) {
          throw new WarehouseContractError(
            `${label} exposed credential material or private cleanup evidence.`,
          );
        }
        Object.defineProperty(out, key, {
          value: visit(input[key], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    if (
      node === null ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node)) ||
      (typeof node === "string" &&
        node.length <= 65_536 &&
        !CONTROL_RE.test(node))
    ) {
      return node;
    }
    throw new WarehouseContractError(`${label} contains a non-JSON value.`);
  };
  return visit(decoded, 0) as Record<string, unknown>;
}

function inputText(value: string, label: string, max: number): string {
  const out = value.trim();
  if (!out || Array.from(out).length > max || CONTROL_RE.test(out)) {
    throw new WarehouseInputError(
      `${label} must be control-free text of at most ${max} characters.`,
    );
  }
  return out;
}

function inputKey(value: string, label: string): string {
  const out = value.trim();
  if (!KEY_RE.test(out))
    throw new WarehouseInputError(`${label} must be a safe field identifier.`);
  return out;
}

function inputJSON(
  value: Record<string, unknown>,
  label: string,
  rejectSensitive = false,
): Record<string, unknown> {
  try {
    return cloneJSON(value, label, rejectSensitive);
  } catch (error) {
    throw new WarehouseInputError(
      error instanceof Error ? error.message : `${label} is invalid.`,
    );
  }
}

function assertAuthority(authority: WarehouseAuthority): void {
  inputUuid(authority.tenantId, "Workspace id");
  inputUuid(authority.userId, "User id");
  if (authority.role !== "owner" && authority.role !== "admin") {
    throw new WarehouseInputError("Administrator access is required.");
  }
}

function assertIdempotencyKey(value: string): void {
  inputUuid(value, "Idempotency key");
}

function assertTenant(value: string, expected: string): void {
  if (value !== expected)
    throw new WarehouseContractError(
      "The response belongs to another workspace.",
    );
}

function decodeProviderField(value: unknown): WarehouseProviderField {
  const row = record(value, "Provider field");
  return {
    key: token(row.key, "Provider field key"),
    label: stringValue(row.label, "Provider field label", 120),
    required:
      row.required === undefined
        ? false
        : booleanValue(row.required, "Provider field required"),
    secret:
      row.secret === undefined
        ? false
        : booleanValue(row.secret, "Provider field secret"),
    help: optionalString(row.help, "Provider field help", 500) ?? "",
  };
}

function decodeProvider(value: unknown): WarehouseProvider {
  const row = record(value, "Provider");
  const fields = (input: unknown, label: string) => {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 100)
      throw new WarehouseContractError(`${label} is invalid.`);
    return input.map(decodeProviderField);
  };
  return {
    provider: token(row.provider, "Provider key"),
    name: stringValue(row.name, "Provider name", 120),
    auth_mode: token(row.auth_mode, "Provider auth mode"),
    managed: booleanValue(row.managed, "Provider managed state"),
    runtime_status: token(row.runtime_status, "Provider runtime status"),
    capabilities: stringArray(
      row.capabilities ?? [],
      "Provider capabilities",
      100,
    ),
    required_settings: fields(row.required_settings, "Required settings"),
    optional_settings: fields(row.optional_settings, "Optional settings"),
    sync_objects: stringArray(
      row.sync_objects ?? [],
      "Provider sync objects",
      100,
    ),
    docs_url: optionalString(row.docs_url, "Provider docs URL", 500) ?? "",
  };
}

function decodeCatalogItem(value: unknown): WarehouseCatalogItem {
  const row = record(value, "Catalog item");
  return {
    key: token(row.key, "Catalog key"),
    label: stringValue(row.label, "Catalog label", 160),
    runtime_status: token(row.runtime_status, "Catalog runtime status"),
  };
}

function decodeCatalog(value: unknown): WarehouseCatalog {
  const row = record(value, "Warehouse catalog");
  const items = (input: unknown, label: string) => {
    if (!Array.isArray(input) || input.length > 200)
      throw new WarehouseContractError(`${label} is invalid.`);
    return input.map(decodeCatalogItem);
  };
  return {
    schema_version: token(row.schema_version, "Catalog schema version"),
    providers: items(row.providers, "Catalog providers"),
    directions: stringArray(row.directions, "Catalog directions", 20),
    cadences: stringArray(row.cadences, "Catalog cadences", 20),
    objects: items(row.objects, "Catalog objects"),
    import_targets: items(row.import_targets, "Catalog import targets"),
    workers: items(row.workers, "Catalog workers"),
  };
}

function decodeConnection(value: unknown): WarehouseConnection {
  const row = record(value, "Warehouse connection");
  if ("credentials_ref" in row || "last_cursor" in row || "error" in row) {
    throw new WarehouseContractError(
      "The service exposed a sensitive warehouse field.",
    );
  }
  return {
    id: uuid(row.id, "Connection id"),
    tenant_id: uuid(row.tenant_id, "Connection workspace id"),
    name: stringValue(row.name, "Connection name", 160),
    provider: token(row.provider, "Connection provider"),
    direction: enumValue(
      row.direction,
      ["export", "import", "bidirectional"],
      "Connection direction",
    ),
    status: enumValue(
      row.status,
      ["draft", "active", "paused", "error", "disconnected"],
      "Connection status",
    ),
    credential_ref_present: booleanValue(
      row.credential_ref_present,
      "Credential reference state",
    ),
    config: cloneJSON(row.config ?? {}, "Connection config", true),
    object_selection: stringArray(
      row.object_selection,
      "Connection objects",
      100,
    ),
    cadence: enumValue(
      row.cadence,
      ["manual", "hourly", "daily", "weekly"],
      "Connection cadence",
    ),
    backfill_days: integer(row.backfill_days, "Backfill days", 1, 3_650),
    issue_present: booleanValue(row.issue_present, "Connection issue state"),
    version: positiveVersion(row.version),
    created_at: timestamp(row.created_at, "Connection created at"),
    updated_at: timestamp(row.updated_at, "Connection updated at"),
  };
}

function decodeRun(value: unknown): WarehouseRun {
  const row = record(value, "Warehouse run");
  if (
    [
      "input_uri",
      "output_uri",
      "cursor_from",
      "cursor_to",
      "metrics",
      "error",
    ].some((key) => key in row)
  ) {
    throw new WarehouseContractError(
      "The service exposed private warehouse run detail.",
    );
  }
  return {
    id: uuid(row.id, "Run id"),
    tenant_id: uuid(row.tenant_id, "Run workspace id"),
    connection_id: uuid(row.connection_id, "Run connection id"),
    direction: enumValue(row.direction, ["export", "import"], "Run direction"),
    run_mode: enumValue(
      row.run_mode,
      ["manual", "scheduled", "backfill", "retry", "dry_run"],
      "Run mode",
    ),
    status: enumValue(
      row.status,
      ["queued", "running", "completed", "failed", "cancelled"],
      "Run status",
    ),
    object_selection: stringArray(row.object_selection, "Run objects", 100),
    rows_scanned: integer(row.rows_scanned, "Rows scanned"),
    rows_exported: integer(row.rows_exported, "Rows exported"),
    rows_imported: integer(row.rows_imported, "Rows imported"),
    rows_failed: integer(row.rows_failed, "Rows failed"),
    schema_errors: integer(row.schema_errors, "Schema errors"),
    retry_count: integer(row.retry_count, "Retry count", 0, 10_000),
    issue_present:
      row.issue_present === undefined
        ? Boolean(row.error)
        : booleanValue(row.issue_present, "Run issue state"),
    started_at: optionalTimestamp(row.started_at, "Run start"),
    completed_at: optionalTimestamp(row.completed_at, "Run completion"),
    created_at: timestamp(row.created_at, "Run created at"),
    updated_at: timestamp(row.updated_at, "Run updated at"),
  };
}

function decodeValidation(value: unknown): WarehouseValidationResult {
  const row = record(value, "Validation result");
  return {
    valid: booleanValue(row.valid, "Validation state"),
    errors: Array.isArray(row.errors)
      ? row.errors
          .slice(0, 100)
          .map((item, index) =>
            stringValue(item, `Validation error ${index + 1}`, 500),
          )
      : [],
    warnings: Array.isArray(row.warnings)
      ? row.warnings
          .slice(0, 100)
          .map((item, index) =>
            stringValue(item, `Validation warning ${index + 1}`, 500),
          )
      : [],
  };
}

function decodeMapping(value: unknown): WarehouseImportMapping {
  const row = record(value, "Import mapping");
  return {
    id: uuid(row.id, "Mapping id"),
    tenant_id: uuid(row.tenant_id, "Mapping workspace id"),
    connection_id: uuid(row.connection_id, "Mapping connection id"),
    source_object: inputKey(
      stringValue(row.source_object, "Source object", 128),
      "Source object",
    ),
    target_event_name: stringValue(row.target_event_name, "Target event", 160),
    profile_key_column: inputKey(
      stringValue(row.profile_key_column, "Profile key column", 128),
      "Profile key column",
    ),
    occurred_at_column: inputKey(
      stringValue(row.occurred_at_column, "Occurred-at column", 128),
      "Occurred-at column",
    ),
    property_map: cloneJSON(row.property_map ?? {}, "Property map"),
    validation_rules: cloneJSON(row.validation_rules ?? {}, "Validation rules"),
    status: enumValue(
      row.status,
      ["draft", "active", "paused"],
      "Mapping status",
    ),
    version: positiveVersion(row.version),
    created_at: timestamp(row.created_at, "Mapping created at"),
    updated_at: timestamp(row.updated_at, "Mapping updated at"),
  };
}

function decodeReverseMapping(value: unknown): ReverseETLMapping {
  const row = record(value, "Reverse ETL mapping");
  return {
    id: uuid(row.id, "Reverse mapping id"),
    tenant_id: uuid(row.tenant_id, "Reverse mapping workspace id"),
    connection_id: uuid(row.connection_id, "Reverse mapping connection id"),
    source_table: stringValue(row.source_table, "Source table", 256),
    profile_key_column: inputKey(
      stringValue(row.profile_key_column, "Profile key column", 128),
      "Profile key column",
    ),
    profile_key_target: enumValue(
      row.profile_key_target,
      ["email"],
      "Profile key target",
    ),
    source_column: stringValue(row.source_column, "Source column", 256),
    target_field_key: inputKey(
      stringValue(row.target_field_key, "Target field", 128),
      "Target field",
    ),
    cast_type: enumValue(
      row.cast_type,
      ["string", "number", "boolean", "date", "datetime", "json"],
      "Cast type",
    ),
    status: enumValue(
      row.status,
      ["draft", "active", "paused"],
      "Reverse mapping status",
    ),
    version: positiveVersion(row.version),
    last_synced_at: optionalTimestamp(row.last_synced_at, "Last sync"),
    last_row_count: integer(row.last_row_count, "Last row count"),
    created_at: timestamp(row.created_at, "Reverse mapping created at"),
    updated_at: timestamp(row.updated_at, "Reverse mapping updated at"),
  };
}

function decodeStreamingRun(value: unknown): StreamingExportRun {
  const row = record(value, "Streaming run");
  if ("object_uri" in row || "error" in row) {
    throw new WarehouseContractError(
      "The service exposed private streaming storage or error detail.",
    );
  }
  return {
    id: uuid(row.id, "Streaming run id"),
    connection_id: uuid(row.connection_id, "Streaming connection id"),
    status: enumValue(
      row.status,
      ["running", "completed", "failed", "empty"],
      "Streaming status",
    ),
    format: enumValue(row.format, ["parquet", "avro"], "Streaming format"),
    compression: enumValue(
      row.compression,
      ["none", "snappy", "gzip", "zstd"],
      "Streaming compression",
    ),
    window_start: timestamp(row.window_start, "Window start"),
    window_end: timestamp(row.window_end, "Window end"),
    cursor_from: integer(row.cursor_from, "Cursor from"),
    cursor_to: integer(row.cursor_to, "Cursor to"),
    has_more: booleanValue(row.has_more, "Has-more state"),
    rows_shipped: integer(row.rows_shipped, "Rows shipped"),
    bytes_shipped: integer(row.bytes_shipped, "Bytes shipped"),
    issue_present:
      row.issue_present === undefined
        ? Boolean(row.error)
        : booleanValue(row.issue_present, "Streaming issue state"),
    started_at: timestamp(row.started_at, "Streaming start"),
    completed_at: optionalTimestamp(row.completed_at, "Streaming completion"),
    created_at: timestamp(row.created_at, "Streaming created at"),
  };
}

function decodeList<T>(
  value: unknown,
  decoder: (item: unknown) => T,
  label: string,
  max = 500,
): T[] {
  const row = record(value, label);
  if (!Array.isArray(row.items) || row.items.length > max) {
    throw new WarehouseContractError(`${label}.items is invalid.`);
  }
  return row.items.map(decoder);
}

function checkedConnectionInput(
  input: WarehouseConnectionInput,
): WarehouseConnectionInput {
  const name = inputText(input.name, "Connection name", 160);
  const provider = inputKey(input.provider, "Provider");
  const credentialsRef = input.credentials_ref?.trim();
  if (
    credentialsRef &&
    (!TOKEN_RE.test(credentialsRef) || credentialsRef.length > 256)
  ) {
    throw new WarehouseInputError(
      "Credential reference must be a safe vault or secret reference, never raw credential material.",
    );
  }
  const objects = input.object_selection.map((value) =>
    inputKey(value, "Object"),
  );
  if (
    !objects.length ||
    objects.length > 100 ||
    new Set(objects).size !== objects.length
  ) {
    throw new WarehouseInputError(
      "Choose between 1 and 100 unique warehouse objects.",
    );
  }
  if (
    !Number.isInteger(input.backfill_days) ||
    input.backfill_days < 1 ||
    input.backfill_days > 3_650
  ) {
    throw new WarehouseInputError("Backfill days must be between 1 and 3,650.");
  }
  if (provider === "streaming_export") {
    if (
      input.direction !== "export" ||
      input.cadence !== "hourly" ||
      credentialsRef
    ) {
      throw new WarehouseInputError(
        "Streaming export uses workspace storage and requires export direction, hourly cadence, and no credential reference.",
      );
    }
  }
  return {
    name,
    provider,
    direction: input.direction,
    status: input.status,
    ...(credentialsRef ? { credentials_ref: credentialsRef } : {}),
    config: inputJSON(input.config, "Connection config", true),
    object_selection: objects,
    cadence: input.cadence,
    backfill_days: input.backfill_days,
  };
}

export async function getWarehouseCatalog(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<WarehouseCatalog> {
  inputUuid(input.tenantId, "Workspace id");
  return decodeCatalog(
    await api.get<unknown>("/api/v1/warehouse/catalog", {
      signal: input.signal,
    }),
  );
}

export async function listWarehouseProviders(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<WarehouseProvider[]> {
  inputUuid(input.tenantId, "Workspace id");
  return decodeList(
    await api.get<unknown>("/api/v1/warehouse/providers", {
      signal: input.signal,
    }),
    decodeProvider,
    "Warehouse providers",
    100,
  );
}

export async function listWarehouseConnections(input: {
  tenantId: string;
  status?: WarehouseConnection["status"];
  signal?: AbortSignal;
}): Promise<WarehouseConnection[]> {
  inputUuid(input.tenantId, "Workspace id");
  const query = input.status
    ? `?status=${encodeURIComponent(input.status)}`
    : "";
  const rows = decodeList(
    await api.get<unknown>(`/api/v1/warehouse/connections${query}`, {
      signal: input.signal,
    }),
    decodeConnection,
    "Warehouse connections",
    200,
  );
  rows.forEach((row) => assertTenant(row.tenant_id, input.tenantId));
  return rows;
}

export async function getWarehouseConnection(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<WarehouseConnection> {
  inputUuid(input.tenantId, "Workspace id");
  const id = inputUuid(input.id, "Connection id");
  const row = decodeConnection(
    await api.get<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(id)}`,
      { signal: input.signal },
    ),
  );
  assertTenant(row.tenant_id, input.tenantId);
  if (row.id !== id)
    throw new WarehouseContractError(
      "The connection response did not match the request.",
    );
  return row;
}

export async function validateWarehouseConnection(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnectionInput;
  signal?: AbortSignal;
}): Promise<WarehouseValidationResult> {
  assertAuthority(input.authority);
  return decodeValidation(
    await api.post<unknown>(
      "/api/v1/warehouse/validate",
      checkedConnectionInput(input.connection),
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: null,
        maxAttempts: 1,
      },
    ),
  );
}

export async function createWarehouseConnection(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnectionInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseConnection> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  const row = decodeConnection(
    await api.post<unknown>(
      "/api/v1/warehouse/connections",
      checkedConnectionInput(input.connection),
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
  );
  assertTenant(row.tenant_id, input.authority.tenantId);
  if (row.provider !== input.connection.provider)
    throw new WarehouseContractError(
      "The create receipt did not match the requested provider.",
    );
  return row;
}

export async function pauseWarehouseConnection(input: {
  authority: WarehouseAuthority;
  current: WarehouseConnection;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseConnection> {
  assertAuthority(input.authority);
  assertTenant(input.current.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const row = decodeConnection(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.current.id, "Connection id"))}/pause`,
      { expected_version: positiveVersion(input.current.version) },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
  );
  assertTenant(row.tenant_id, input.authority.tenantId);
  if (
    row.id !== input.current.id ||
    row.version !== input.current.version + 1 ||
    row.status !== "paused"
  )
    throw new WarehouseContractError(
      "The pause receipt did not match the requested transition.",
    );
  return row;
}

export async function disconnectWarehouseConnection(input: {
  authority: WarehouseAuthority;
  current: WarehouseConnection;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseDeleteReceipt> {
  assertAuthority(input.authority);
  assertTenant(input.current.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const raw = record(
    await api.delete<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.current.id, "Connection id"))}`,
      {
        body: {
          expected_version: positiveVersion(input.current.version),
          confirmation_name: input.current.name,
        },
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
    "Disconnect receipt",
  );
  if (raw.ok !== true)
    throw new WarehouseContractError("Disconnect was not acknowledged.");
  const receipt: WarehouseDeleteReceipt = {
    ok: true,
    id: uuid(raw.id, "Disconnected id"),
    previous_version: positiveVersion(raw.previous_version, "Previous version"),
    version: positiveVersion(raw.version),
    status: enumValue(raw.status, ["disconnected"], "Disconnect status"),
  };
  if (
    receipt.id !== input.current.id ||
    receipt.previous_version !== input.current.version ||
    receipt.version !== input.current.version + 1
  )
    throw new WarehouseContractError(
      "The disconnect receipt did not match the request.",
    );
  return receipt;
}

export async function acknowledgeWarehouseProviderCleanup(input: {
  authority: WarehouseAuthority;
  current: WarehouseConnection;
  completedActions: string[];
  notes: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseCleanupReceipt> {
  assertAuthority(input.authority);
  assertTenant(input.current.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const actions = input.completedActions.map((value) =>
    inputKey(value, "Cleanup action"),
  );
  const result = record(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.current.id, "Connection id"))}/provider-cleanup/acknowledge`,
      {
        expected_version: positiveVersion(input.current.version),
        completed_actions: actions,
        notes: input.notes.trim().slice(0, 2_000),
      },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
    "Cleanup acknowledgement",
  );
  if (result.ok !== true)
    throw new WarehouseContractError("Provider cleanup was not acknowledged.");
  const receipt: WarehouseCleanupReceipt = {
    ok: true,
    id: uuid(result.id, "Cleanup connection id"),
    previous_version: positiveVersion(
      result.previous_version,
      "Previous version",
    ),
    version: positiveVersion(result.version),
  };
  if (
    receipt.id !== input.current.id ||
    receipt.previous_version !== input.current.version ||
    receipt.version !== input.current.version + 1
  ) {
    throw new WarehouseContractError(
      "The cleanup receipt did not match the connection.",
    );
  }
  return receipt;
}

export async function getWarehouseHealth(input: {
  tenantId: string;
  connectionId: string;
  providerCheck?: boolean;
  signal?: AbortSignal;
}): Promise<WarehouseConnectionHealth> {
  inputUuid(input.tenantId, "Workspace id");
  const id = inputUuid(input.connectionId, "Connection id");
  const raw = record(
    await api.get<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(id)}/health${input.providerCheck ? "?provider_check=true" : ""}`,
      { signal: input.signal },
    ),
    "Connection health",
  );
  const providerRaw =
    raw.provider_health === undefined || raw.provider_health === null
      ? null
      : record(raw.provider_health, "Provider health");
  if (
    "error" in raw ||
    "warnings" in raw ||
    (providerRaw &&
      ["error", "message", "statements", "warnings"].some(
        (key) => key in providerRaw,
      ))
  ) {
    throw new WarehouseContractError(
      "The service exposed private provider-health detail.",
    );
  }
  const out: WarehouseConnectionHealth = {
    connection_id: uuid(raw.connection_id, "Health connection id"),
    provider: token(raw.provider, "Health provider"),
    status: token(raw.status, "Connection status"),
    health: token(raw.health, "Health state"),
    last_run_status: optionalString(raw.last_run_status, "Last run status"),
    last_run_at: optionalTimestamp(raw.last_run_at, "Last run at"),
    missing_required_settings: stringArray(
      raw.missing_required_settings ?? [],
      "Missing settings",
      100,
    ),
    warning_count: integer(raw.warning_count ?? 0, "Warning count"),
    issue_present: booleanValue(raw.issue_present, "Health issue state"),
    provider_runtime_status: optionalString(
      raw.provider_runtime_status,
      "Provider runtime status",
    ),
    provider_driver_attachment: optionalString(
      raw.provider_driver_attachment,
      "Provider driver attachment",
    ),
    provider_health: providerRaw
      ? {
          state: token(providerRaw.state, "Provider health state"),
          live_state: optionalString(
            providerRaw.live_state,
            "Provider live state",
          ),
          execution_mode: optionalString(
            providerRaw.execution_mode,
            "Provider execution mode",
          ),
          executable: booleanValue(
            providerRaw.executable,
            "Provider executable state",
          ),
          statements_executed: integer(
            providerRaw.statements_executed ?? 0,
            "Statements executed",
          ),
          missing_required_settings: stringArray(
            providerRaw.missing_required_settings ?? [],
            "Provider missing settings",
            100,
          ),
          warning_count: integer(
            providerRaw.warning_count ?? 0,
            "Provider warning count",
          ),
          issue_present: booleanValue(
            providerRaw.issue_present,
            "Provider issue state",
          ),
        }
      : null,
  };
  if (out.connection_id !== id)
    throw new WarehouseContractError(
      "The health response did not match the connection.",
    );
  return out;
}

export async function listWarehouseRuns(input: {
  tenantId: string;
  connectionId?: string;
  signal?: AbortSignal;
}): Promise<WarehouseRun[]> {
  inputUuid(input.tenantId, "Workspace id");
  const path = input.connectionId
    ? `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connectionId, "Connection id"))}/runs`
    : "/api/v1/warehouse/runs";
  const rows = decodeList(
    await api.get<unknown>(path, { signal: input.signal }),
    decodeRun,
    "Warehouse runs",
    500,
  );
  rows.forEach((row) => {
    assertTenant(row.tenant_id, input.tenantId);
    if (input.connectionId && row.connection_id !== input.connectionId)
      throw new WarehouseContractError(
        "Run history crossed connection boundaries.",
      );
  });
  return rows;
}

export async function runWarehouseConnection(input: {
  authority: WarehouseAuthority;
  current: WarehouseConnection;
  direction?: "export" | "import";
  runMode?: "manual" | "dry_run" | "retry";
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseRun> {
  assertAuthority(input.authority);
  assertTenant(input.current.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const row = decodeRun(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.current.id, "Connection id"))}/runs`,
      {
        expected_connection_version: positiveVersion(input.current.version),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.runMode ? { run_mode: input.runMode } : {}),
      },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
        timeoutMs: 60_000,
      },
    ),
  );
  assertTenant(row.tenant_id, input.authority.tenantId);
  if (row.connection_id !== input.current.id)
    throw new WarehouseContractError(
      "The run receipt did not match the connection.",
    );
  return row;
}

export async function runDueWarehouseConnections(input: {
  authority: WarehouseAuthority;
  limit: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseRun[]> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new WarehouseInputError("Due-run limit must be between 1 and 100.");
  const raw = await api.post<unknown>(
    `/api/v1/warehouse/runs/due?limit=${input.limit}`,
    {},
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 1,
      timeoutMs: 60_000,
    },
  );
  const rows = decodeList(raw, decodeRun, "Due warehouse runs", 100);
  rows.forEach((row) => assertTenant(row.tenant_id, input.authority.tenantId));
  return rows;
}

export async function listWarehouseRunErrors(input: {
  authority: WarehouseAuthority;
  runId: string;
  signal?: AbortSignal;
}): Promise<WarehouseRowErrorEvidence[]> {
  assertAuthority(input.authority);
  const runId = inputUuid(input.runId, "Run id");
  return decodeList(
    await api.get<unknown>(
      `/api/v1/warehouse/runs/${encodeURIComponent(runId)}/errors`,
      { signal: input.signal },
    ),
    (value) => {
      const row = record(value, "Run error evidence");
      return {
        id: integer(row.id, "Error id", 1),
        run_id: uuid(row.run_id, "Error run id"),
        source_object: token(row.source_object, "Error source object"),
        row_number: integer(row.row_number, "Error row number"),
        error_code: token(row.error_code, "Error code"),
        message_present: booleanValue(
          row.message_present,
          "Error message state",
        ),
        created_at: timestamp(row.created_at, "Error created at"),
      };
    },
    "Warehouse run errors",
    500,
  ).map((row) => {
    if (row.run_id !== runId)
      throw new WarehouseContractError(
        "Error evidence crossed run boundaries.",
      );
    return row;
  });
}

export async function listWarehouseMappings(input: {
  tenantId: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<WarehouseImportMapping[]> {
  inputUuid(input.tenantId, "Workspace id");
  const id = inputUuid(input.connectionId, "Connection id");
  const rows = decodeList(
    await api.get<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(id)}/mappings`,
      { signal: input.signal },
    ),
    decodeMapping,
    "Warehouse mappings",
    200,
  );
  rows.forEach((row) => {
    assertTenant(row.tenant_id, input.tenantId);
    if (row.connection_id !== id)
      throw new WarehouseContractError(
        "Mapping response crossed connection boundaries.",
      );
  });
  return rows;
}

export async function putWarehouseMapping(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnection;
  sourceObject: string;
  current?: WarehouseImportMapping;
  mapping: WarehouseImportMappingInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<WarehouseImportMapping> {
  assertAuthority(input.authority);
  assertTenant(input.connection.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const sourceObject = inputKey(input.sourceObject, "Source object");
  const expectedVersion = input.current
    ? positiveVersion(input.current.version)
    : 0;
  if (
    input.current &&
    (input.current.connection_id !== input.connection.id ||
      input.current.source_object !== sourceObject)
  )
    throw new WarehouseInputError("Refresh the mapping before editing it.");
  const row = decodeMapping(
    await api.put<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connection.id, "Connection id"))}/mappings/${encodeURIComponent(sourceObject)}`,
      {
        expected_version: expectedVersion,
        target_event_name: inputText(
          input.mapping.target_event_name,
          "Target event",
          160,
        ),
        profile_key_column: inputKey(
          input.mapping.profile_key_column,
          "Profile key column",
        ),
        occurred_at_column: inputKey(
          input.mapping.occurred_at_column,
          "Occurred-at column",
        ),
        property_map: inputJSON(input.mapping.property_map, "Property map"),
        validation_rules: inputJSON(
          input.mapping.validation_rules,
          "Validation rules",
        ),
        status: input.mapping.status,
      },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
  );
  assertTenant(row.tenant_id, input.authority.tenantId);
  if (
    row.connection_id !== input.connection.id ||
    row.source_object !== sourceObject ||
    row.version !== expectedVersion + 1
  )
    throw new WarehouseContractError(
      "The mapping receipt did not match the request.",
    );
  return row;
}

export async function listReverseETLMappings(input: {
  tenantId: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<ReverseETLMapping[]> {
  inputUuid(input.tenantId, "Workspace id");
  const id = inputUuid(input.connectionId, "Connection id");
  const rows = decodeList(
    await api.get<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(id)}/reverse-etl-mappings`,
      { signal: input.signal },
    ),
    decodeReverseMapping,
    "Reverse ETL mappings",
    500,
  );
  rows.forEach((row) => {
    assertTenant(row.tenant_id, input.tenantId);
    if (row.connection_id !== id)
      throw new WarehouseContractError(
        "Reverse mapping response crossed connection boundaries.",
      );
  });
  return rows;
}

export async function saveReverseETLMapping(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnection;
  current?: ReverseETLMapping;
  mapping: ReverseETLMappingInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ReverseETLMapping> {
  assertAuthority(input.authority);
  assertTenant(input.connection.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const expectedVersion = input.current
    ? positiveVersion(input.current.version)
    : 0;
  const body = {
    expected_version: expectedVersion,
    source_table: inputText(input.mapping.source_table, "Source table", 256),
    profile_key_column: inputKey(
      input.mapping.profile_key_column,
      "Profile key column",
    ),
    profile_key_target: "email",
    source_column: inputText(input.mapping.source_column, "Source column", 256),
    target_field_key: inputKey(input.mapping.target_field_key, "Target field"),
    cast_type: input.mapping.cast_type,
    status: input.mapping.status,
  };
  const row = decodeReverseMapping(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connection.id, "Connection id"))}/reverse-etl-mappings`,
      body,
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
  );
  assertTenant(row.tenant_id, input.authority.tenantId);
  if (
    row.connection_id !== input.connection.id ||
    row.version !== expectedVersion + 1
  )
    throw new WarehouseContractError(
      "The reverse mapping receipt did not match the request.",
    );
  return row;
}

export async function deleteReverseETLMapping(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnection;
  current: ReverseETLMapping;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<void> {
  assertAuthority(input.authority);
  assertTenant(input.connection.tenant_id, input.authority.tenantId);
  assertTenant(input.current.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const raw = record(
    await api.delete<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connection.id, "Connection id"))}/reverse-etl-mappings/${encodeURIComponent(inputUuid(input.current.id, "Mapping id"))}`,
      {
        body: {
          expected_version: positiveVersion(input.current.version),
          confirmation_target: input.current.target_field_key,
        },
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
    "Reverse mapping delete receipt",
  );
  if (
    raw.ok !== true ||
    uuid(raw.id, "Deleted mapping id") !== input.current.id ||
    positiveVersion(raw.previous_version) !== input.current.version
  )
    throw new WarehouseContractError(
      "The delete receipt did not match the mapping.",
    );
}

export async function syncReverseETL(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnection;
  sourceTable?: string;
  rows: Array<Record<string, unknown>>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ReverseETLSyncResult> {
  assertAuthority(input.authority);
  assertTenant(input.connection.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > 1_000
  )
    throw new WarehouseInputError(
      "A browser sync supports between 1 and 1,000 staged rows.",
    );
  const rows = input.rows.map((row, index) =>
    inputJSON(row, `Row ${index + 1}`),
  );
  const raw = record(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connection.id, "Connection id"))}/reverse-etl-sync`,
      {
        expected_connection_version: positiveVersion(input.connection.version),
        ...(input.sourceTable?.trim()
          ? { source_table: inputText(input.sourceTable, "Source table", 256) }
          : {}),
        rows,
      },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
        timeoutMs: 60_000,
      },
    ),
    "Reverse ETL result",
  );
  const result: ReverseETLSyncResult = {
    connection_id: uuid(raw.connection_id, "Sync connection id"),
    mappings_applied: integer(raw.mappings_applied, "Mappings applied"),
    rows_scanned: integer(raw.rows_scanned, "Rows scanned"),
    subscribers_matched: integer(
      raw.subscribers_matched,
      "Subscribers matched",
    ),
    fields_written: integer(raw.fields_written, "Fields written"),
  };
  if (
    result.connection_id !== input.connection.id ||
    result.rows_scanned !== rows.length
  )
    throw new WarehouseContractError(
      "The reverse-ETL receipt did not match the request.",
    );
  return result;
}

export async function validateStreamingConfig(input: {
  authority: WarehouseAuthority;
  config: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<WarehouseValidationResult> {
  assertAuthority(input.authority);
  return decodeValidation(
    await api.post<unknown>(
      "/api/v1/warehouse/streaming/validate",
      { config: inputJSON(input.config, "Streaming config") },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: null,
        maxAttempts: 1,
      },
    ),
  );
}

export async function listStreamingRuns(input: {
  tenantId: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<{ items: StreamingExportRun[]; lastShippedAt: string | null }> {
  inputUuid(input.tenantId, "Workspace id");
  const id = inputUuid(input.connectionId, "Connection id");
  const raw = record(
    await api.get<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(id)}/streaming/runs`,
      { signal: input.signal },
    ),
    "Streaming runs",
  );
  if (!Array.isArray(raw.items) || raw.items.length > 200)
    throw new WarehouseContractError("Streaming runs are invalid.");
  const items = raw.items.map(decodeStreamingRun);
  items.forEach((row) => {
    if (row.connection_id !== id)
      throw new WarehouseContractError(
        "Streaming history crossed connection boundaries.",
      );
  });
  return {
    items,
    lastShippedAt: optionalTimestamp(raw.last_shipped_at, "Last shipped at"),
  };
}

export async function shipStreamingWindow(input: {
  authority: WarehouseAuthority;
  connection: WarehouseConnection;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<StreamingExportRun> {
  assertAuthority(input.authority);
  assertTenant(input.connection.tenant_id, input.authority.tenantId);
  assertIdempotencyKey(input.idempotencyKey);
  const row = decodeStreamingRun(
    await api.post<unknown>(
      `/api/v1/warehouse/connections/${encodeURIComponent(inputUuid(input.connection.id, "Connection id"))}/streaming/ship`,
      {
        expected_connection_version: positiveVersion(input.connection.version),
      },
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
        timeoutMs: 60_000,
      },
    ),
  );
  if (row.connection_id !== input.connection.id)
    throw new WarehouseContractError(
      "The shipment receipt did not match the connection.",
    );
  return row;
}
