import type { ApiErr, ApiResult } from "./result";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_256_RE = /^[0-9a-f]{64}$/;
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SOURCE_KEY_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONSENT_JURISDICTION_RE = /^[A-Z][A-Z0-9-]{1,31}$/;
const CONSENT_EVIDENCE_RE =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;
const SECRET_QUERY_KEY_RE =
  /(?:^|_)(?:key|token|secret|password|passwd|signature|sig|code|credential)(?:$|_)/i;
const MAX_RESPONSE_DEPTH = 12;
const MAX_OBJECT_KEYS = 1_024;
const MAX_ARRAY_ITEMS = 10_000;
const MAX_IMPORT_HEADER_BYTES = 1_024;
const MAX_IMPORT_HEADER_CODE_POINTS = 256;
const MAX_IMPORT_SAMPLE_BYTES = 32 << 10;
const MAX_IMPORT_TAG_CODE_POINTS = 100;
const MAX_IMPORT_TAG_BYTES = 400;

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type SubscriberImportStatus =
  | "preview"
  | "queued"
  | "running"
  | "ready"
  | "failed"
  | "cancelled";

export type SubscriberImportStrategy = "skip" | "update" | "error";
export type SubscriberImportConsentState = "none" | "incomplete" | "complete";
export type SubscriberImportCustomFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "array"
  | "object"
  | "email"
  | "url"
  | "phone"
  | "region";
export type SubscriberImportMappingKind =
  | "email"
  | "name"
  | "tags"
  | "custom"
  | "ignore";

export interface SubscriberImportMappingColumnContract {
  index: number;
  name: string;
  kind: SubscriberImportMappingKind;
  custom_key?: string;
}

export interface SubscriberImportMappingContract {
  path: string;
  headers: string[];
  columns: SubscriberImportMappingColumnContract[];
  rows: number;
}

export interface SubscriberImportDryRunRow {
  row_number: number;
  outcome: "create" | "update" | "skip" | "fail";
  error_code?: string;
  /** Server-controlled category copy. Never an email or raw row value. */
  error?: string;
}

export interface SubscriberImportDryRunResults {
  rows_total: number;
  would_create: number;
  would_update: number;
  would_skip: number;
  would_fail: number;
  file_dupes: number;
  rows: SubscriberImportDryRunRow[];
  detail_capped: boolean;
  validated_at: string;
  authoritative: true;
  preflight_fingerprint: string;
  would_be_sendable: number;
  would_remain_protected: number;
  consent_contract_state: SubscriberImportConsentState;
  state_fingerprint: string;
  catalog_fingerprint: string;
  expires_at: string;
}

/**
 * One verified subscriber-import resource. Preview, confirm, and GET return
 * endpoint-specific subsets; every network wrapper parses its exact shape
 * before exposing this shared view model.
 */
export interface SubscriberImportPreview {
  id: string;
  status: SubscriberImportStatus;
  filename?: string;
  mapping?: SubscriberImportMappingContract;
  sample_rows?: Array<Record<string, string>>;
  rows_total?: number;
  rows_new?: number;
  rows_existing?: number;
  rows_file_dupes?: number;
  on_existing?: SubscriberImportStrategy;
  classification_authoritative?: boolean;
  source_fingerprint?: string;
  source_fingerprint_scheme?: "hmac-sha256-v1";
  source_fingerprint_key_version?: string;
  upload_classification_exact?: boolean;
  configuration_revision?: number;
  sample_values_truncated?: boolean;
  preflight_required?: boolean;
  rows_imported?: number;
  rows_skipped?: number;
  rows_failed?: number;
  processed_rows?: number;
  cancel_requested?: boolean;
  error_code?: string;
  error?: string;
  created_at?: string;
  consent_source?: string;
  consent_source_url?: string;
  consent_captured_at?: string;
  consent_legal_basis?: string;
  consent_jurisdiction?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  consent_evidence_reference?: string;
  consent_scope?: string;
  consent_scope_acknowledged?: boolean;
  consent_contract_version?: string;
  consent_contract_state?: SubscriberImportConsentState;
  tags?: string[];
  auto_create_properties?: boolean;
  schedule_type?: "immediate" | "scheduled";
  schedule_cron?: string;
  scheduled_at?: string;
  next_scheduled_at?: string;
  drip_hours_interval?: number;
  drip_hours_total?: number;
  dry_run?: boolean;
  dry_run_at?: string;
  dry_run_results?: SubscriberImportDryRunResults;
  preflight_fingerprint?: string;
  preflight_at?: string;
  preflight_expires_at?: string;
  preflight_rows_total?: number | null;
  preflight_rows_failed?: number;
  preflight_rows_existing?: number;
  preflight_state_fingerprint?: string;
  preflight_catalog_fingerprint?: string;
  confirmed_consent_fingerprint?: string;
  rows_sendable_after?: number;
  rows_protected_existing?: number;
  consent_receipts_written?: number;
  existing_contact_eligibility_policy?: "preserve";
  last_chunk_at?: string;
  execution_state_fingerprint?: string;
}

export interface SubscriberImportPatchResponse {
  id: string;
  status: "preview";
  updated: boolean;
  configuration_revision: number;
  preflight_required?: true;
}

export interface SubscriberImportCancelResponse {
  id: string;
  status: "running" | "cancelled";
  cancel_requested: true;
}

export interface SubscriberImportProgressEvent {
  status: Exclude<SubscriberImportStatus, "preview">;
  processed_rows: number;
  total_rows: number;
  rows_imported: number;
  rows_skipped: number;
  rows_failed: number;
}

export interface SubscriberImportHeartbeatEvent {
  at: string;
}

export interface SubscriberImportClosedEvent {
  reason: "max_duration";
}

export interface SubscriberImportMergeFieldOption {
  kind: SubscriberImportMappingKind;
  label: string;
}

export interface SubscriberImportCustomFieldOption {
  key: string;
  label: string;
  type: SubscriberImportCustomFieldType;
}

export interface SubscriberImportRemapOptions {
  merge_fields: SubscriberImportMergeFieldOption[];
  custom_fields: SubscriberImportCustomFieldOption[];
}

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** Reject hostile prototypes, excessive depth, and amplification before parsing. */
export function hasSafeSubscriberImportJsonShape(
  value: unknown,
  depth = 0,
): boolean {
  if (depth >= MAX_RESPONSE_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_ARRAY_ITEMS &&
      value.every((item) => hasSafeSubscriberImportJsonShape(item, depth + 1))
    );
  }
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length <= MAX_OBJECT_KEYS &&
    keys.every(
      (key) =>
        !FORBIDDEN_OBJECT_KEYS.has(key) &&
        hasSafeSubscriberImportJsonShape(value[key], depth + 1),
    )
  );
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is PlainRecord {
  if (!isPlainRecord(value) || !hasSafeSubscriberImportJsonShape(value)) {
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isString(value: unknown, max = 4_096): value is string {
  return typeof value === "string" && value.length <= max;
}

function isNonnegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRFC3339(value: unknown, allowEmpty = false): value is string {
  if (allowEmpty && value === "") return true;
  return (
    typeof value === "string" &&
    RFC3339_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isFingerprint(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    ((allowEmpty && value === "") || HEX_256_RE.test(value))
  );
}

function isSourceKeyVersion(value: unknown): value is string {
  return typeof value === "string" && SOURCE_KEY_VERSION_RE.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function unicodeCodePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

function isSafeImportFilename(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    utf8Length(value) > 255 ||
    unicodeCodePointLength(value) > 128 ||
    value === "." ||
    value === ".." ||
    /[\\/]/.test(value)
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0x200e ||
      codePoint === 0x200f
    ) {
      return false;
    }
  }
  return true;
}

function areNormalizedImportTags(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 20) return false;
  const seen = new Set<string>();
  for (const tag of value) {
    if (
      typeof tag !== "string" ||
      tag === "" ||
      tag !== tag.trim() ||
      unicodeCodePointLength(tag) > MAX_IMPORT_TAG_CODE_POINTS ||
      utf8Length(tag) > MAX_IMPORT_TAG_BYTES
    ) {
      return false;
    }
    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
  }
  return true;
}

function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isStatus(value: unknown): value is SubscriberImportStatus {
  return (
    value === "preview" ||
    value === "queued" ||
    value === "running" ||
    value === "ready" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isStrategy(value: unknown): value is SubscriberImportStrategy {
  return value === "skip" || value === "update" || value === "error";
}

function isCustomFieldType(
  value: unknown,
): value is SubscriberImportCustomFieldType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "date" ||
    value === "enum" ||
    value === "array" ||
    value === "object" ||
    value === "email" ||
    value === "url" ||
    value === "phone" ||
    value === "region"
  );
}

function isPositiveConsentSource(value: unknown): value is string {
  return (
    value === "double_optin" ||
    value === "single_optin" ||
    value === "signed_form" ||
    value === "preference_center" ||
    value === "direct_request"
  );
}

function isSafeConsentUrl(value: unknown): value is string {
  if (!isString(value, 2_048) || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.host.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      ![...parsed.searchParams.keys()].some((key) =>
        SECRET_QUERY_KEY_RE.test(key),
      )
    );
  } catch {
    return false;
  }
}

function isMappingKind(value: unknown): value is SubscriberImportMappingKind {
  return (
    value === "email" ||
    value === "name" ||
    value === "tags" ||
    value === "custom" ||
    value === "ignore"
  );
}

function parseMapping(value: unknown): SubscriberImportMappingContract | null {
  if (!hasExactKeys(value, ["path", "headers", "columns", "rows"])) {
    return null;
  }
  if (
    !isString(value.path, 4_096) ||
    !Array.isArray(value.headers) ||
    value.headers.length < 1 ||
    value.headers.length > 512 ||
    !value.headers.every(
      (header) =>
        isString(header, MAX_IMPORT_HEADER_BYTES) &&
        header.length > 0 &&
        utf8Length(header) <= MAX_IMPORT_HEADER_BYTES &&
        unicodeCodePointLength(header) <= MAX_IMPORT_HEADER_CODE_POINTS,
    ) ||
    new Set(value.headers).size !== value.headers.length ||
    !Array.isArray(value.columns) ||
    value.columns.length !== value.headers.length ||
    !isNonnegativeInt(value.rows)
  ) {
    return null;
  }
  const headers = value.headers as string[];
  const columns: SubscriberImportMappingColumnContract[] = [];
  const indexes = new Set<number>();
  const targets = new Set<string>();
  let emailCount = 0;
  for (const raw of value.columns) {
    if (!hasExactKeys(raw, ["index", "name", "kind"], ["custom_key"])) {
      return null;
    }
    if (
      !isNonnegativeInt(raw.index) ||
      raw.index >= headers.length ||
      indexes.has(raw.index) ||
      !isString(raw.name, 1_024) ||
      raw.name !== headers[raw.index] ||
      !isMappingKind(raw.kind)
    ) {
      return null;
    }
    indexes.add(raw.index);
    let customKey: string | undefined;
    if (raw.kind === "custom") {
      if (typeof raw.custom_key !== "string" || !CUSTOM_KEY_RE.test(raw.custom_key)) {
        return null;
      }
      customKey = raw.custom_key;
    } else if (Object.hasOwn(raw, "custom_key")) {
      return null;
    }
    const target = raw.kind === "custom" ? `custom:${customKey}` : raw.kind;
    if (raw.kind !== "ignore") {
      if (targets.has(target)) return null;
      targets.add(target);
    }
    if (raw.kind === "email") emailCount += 1;
    columns.push({
      index: raw.index,
      name: raw.name,
      kind: raw.kind,
      ...(customKey ? { custom_key: customKey } : {}),
    });
  }
  if (indexes.size !== headers.length || emailCount !== 1) return null;
  columns.sort((a, b) => a.index - b.index);
  return { path: value.path, headers, columns, rows: value.rows };
}

function parseSamples(
  value: unknown,
  headers: readonly string[],
): Array<Record<string, string>> | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const allowed = new Set(headers);
  const samples: Array<Record<string, string>> = [];
  let retainedBytes = 0;
  for (const item of value) {
    if (!isPlainRecord(item) || !hasSafeSubscriberImportJsonShape(item)) return null;
    if (Object.keys(item).some((key) => !allowed.has(key))) return null;
    const row: Record<string, string> = {};
    for (const [key, raw] of Object.entries(item)) {
      // The API deliberately limits every retained preview cell to 256 UTF-8
      // bytes. Re-check that boundary before the value can enter React state.
      if (!isString(raw, 256) || utf8Length(raw) > 256) return null;
      retainedBytes += utf8Length(key) + utf8Length(raw);
      if (retainedBytes > MAX_IMPORT_SAMPLE_BYTES) return null;
      row[key] = raw;
    }
    samples.push(row);
  }
  return samples;
}

const DRY_RUN_KEYS = [
  "rows_total",
  "would_create",
  "would_update",
  "would_skip",
  "would_fail",
  "file_dupes",
  "rows",
  "detail_capped",
  "validated_at",
  "authoritative",
  "preflight_fingerprint",
  "would_be_sendable",
  "would_remain_protected",
  "consent_contract_state",
  "state_fingerprint",
  "catalog_fingerprint",
  "expires_at",
] as const;

export function parseSubscriberImportDryRunResults(
  value: unknown,
): SubscriberImportDryRunResults | null {
  if (!hasExactKeys(value, DRY_RUN_KEYS)) return null;
  const countKeys = [
    "rows_total",
    "would_create",
    "would_update",
    "would_skip",
    "would_fail",
    "file_dupes",
    "would_be_sendable",
    "would_remain_protected",
  ] as const;
  if (!countKeys.every((key) => isNonnegativeInt(value[key]))) return null;
  if (
    (value.would_create as number) +
      (value.would_update as number) +
      (value.would_skip as number) +
      (value.would_fail as number) !==
    value.rows_total
  ) {
    return null;
  }
  if (
    (value.file_dupes as number) > (value.rows_total as number) ||
    (value.would_be_sendable as number) > (value.rows_total as number) ||
    (value.would_remain_protected as number) > (value.rows_total as number)
  ) {
    return null;
  }
  if (
    typeof value.detail_capped !== "boolean" ||
    value.authoritative !== true ||
    !isRFC3339(value.validated_at) ||
    !isRFC3339(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.validated_at) ||
    !isFingerprint(value.preflight_fingerprint) ||
    !isFingerprint(value.state_fingerprint) ||
    !isFingerprint(value.catalog_fingerprint) ||
    (value.consent_contract_state !== "none" &&
      value.consent_contract_state !== "complete") ||
    !Array.isArray(value.rows) ||
    value.rows.length > 500 ||
    (!value.detail_capped && value.rows.length !== value.rows_total)
  ) {
    return null;
  }
  const rows: SubscriberImportDryRunRow[] = [];
  const rowNumbers = new Set<number>();
  for (const raw of value.rows) {
    if (
      !hasExactKeys(raw, ["row_number", "outcome"], ["error_code", "error"]) ||
      !Number.isSafeInteger(raw.row_number) ||
      (raw.row_number as number) < 1 ||
      (raw.row_number as number) > (value.rows_total as number) ||
      rowNumbers.has(raw.row_number as number) ||
      (raw.outcome !== "create" &&
        raw.outcome !== "update" &&
        raw.outcome !== "skip" &&
        raw.outcome !== "fail") ||
      (Object.hasOwn(raw, "error_code") &&
        (!isString(raw.error_code, 100) || !/^[a-z][a-z0-9_]{0,99}$/.test(raw.error_code))) ||
      (Object.hasOwn(raw, "error") && !isString(raw.error, 500))
    ) {
      return null;
    }
    rowNumbers.add(raw.row_number as number);
    rows.push({
      row_number: raw.row_number as number,
      outcome: raw.outcome as SubscriberImportDryRunRow["outcome"],
      ...(typeof raw.error_code === "string" ? { error_code: raw.error_code } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
  }
  return {
    rows_total: value.rows_total as number,
    would_create: value.would_create as number,
    would_update: value.would_update as number,
    would_skip: value.would_skip as number,
    would_fail: value.would_fail as number,
    file_dupes: value.file_dupes as number,
    rows,
    detail_capped: value.detail_capped,
    validated_at: value.validated_at,
    authoritative: true,
    preflight_fingerprint: value.preflight_fingerprint,
    would_be_sendable: value.would_be_sendable as number,
    would_remain_protected: value.would_remain_protected as number,
    consent_contract_state: value.consent_contract_state,
    state_fingerprint: value.state_fingerprint,
    catalog_fingerprint: value.catalog_fingerprint,
    expires_at: value.expires_at,
  };
}

const PREVIEW_KEYS = [
  "id",
  "status",
  "mapping",
  "sample_rows",
  "rows_total",
  "rows_new",
  "rows_existing",
  "rows_file_dupes",
  "on_existing",
  "classification_authoritative",
  "upload_classification_exact",
  "source_fingerprint",
  "source_fingerprint_scheme",
  "source_fingerprint_key_version",
  "preflight_required",
  "configuration_revision",
  "sample_values_truncated",
] as const;

export function parseSubscriberImportPreview(
  value: unknown,
): SubscriberImportPreview | null {
  if (!hasExactKeys(value, PREVIEW_KEYS)) return null;
  const mapping = parseMapping(value.mapping);
  if (
    !isUUID(value.id) ||
    value.status !== "preview" ||
    !mapping ||
    !isNonnegativeInt(value.rows_total) ||
    !isNonnegativeInt(value.rows_new) ||
    !isNonnegativeInt(value.rows_existing) ||
    !isNonnegativeInt(value.rows_file_dupes) ||
    mapping.rows !== value.rows_total ||
    (value.rows_new as number) + (value.rows_existing as number) >
      (value.rows_total as number) ||
    (value.rows_file_dupes as number) > (value.rows_total as number) ||
    value.on_existing !== "skip" ||
    value.classification_authoritative !== false ||
    value.upload_classification_exact !== true ||
    !isFingerprint(value.source_fingerprint) ||
    value.source_fingerprint_scheme !== "hmac-sha256-v1" ||
    !isSourceKeyVersion(value.source_fingerprint_key_version) ||
    value.preflight_required !== true ||
    value.configuration_revision !== 0 ||
    typeof value.sample_values_truncated !== "boolean"
  ) {
    return null;
  }
  const samples = parseSamples(value.sample_rows, mapping.headers);
  if (!samples) return null;
  return {
    id: value.id,
    status: "preview",
    mapping,
    sample_rows: samples,
    rows_total: value.rows_total,
    rows_new: value.rows_new,
    rows_existing: value.rows_existing,
    rows_file_dupes: value.rows_file_dupes,
    on_existing: value.on_existing,
    classification_authoritative: false,
    upload_classification_exact: true,
    source_fingerprint: value.source_fingerprint,
    source_fingerprint_scheme: "hmac-sha256-v1",
    source_fingerprint_key_version: value.source_fingerprint_key_version,
    preflight_required: true,
    configuration_revision: 0,
    sample_values_truncated: value.sample_values_truncated,
  };
}

const GET_REQUIRED_KEYS = [
  "id",
  "filename",
  "status",
  "mapping",
  "sample_rows",
  "sample_values_truncated",
  "rows_total",
  "rows_new",
  "rows_existing",
  "rows_file_dupes",
  "rows_imported",
  "rows_skipped",
  "rows_failed",
  "processed_rows",
  "cancel_requested",
  "last_chunk_at",
  "on_existing",
  "error_code",
  "error",
  "created_at",
  "configuration_revision",
  "consent_source",
  "consent_source_url",
  "consent_captured_at",
  "consent_legal_basis",
  "consent_jurisdiction",
  "consent_reason",
  "consent_policy_version",
  "consent_evidence_reference",
  "consent_scope",
  "consent_scope_acknowledged",
  "consent_contract_version",
  "consent_contract_state",
  "source_fingerprint",
  "source_fingerprint_scheme",
  "source_fingerprint_key_version",
  "tags",
  "auto_create_properties",
  "schedule_type",
  "schedule_cron",
  "scheduled_at",
  "next_scheduled_at",
  "drip_hours_interval",
  "drip_hours_total",
  "dry_run",
  "dry_run_at",
  "classification_authoritative",
  "preflight_required",
  "preflight_fingerprint",
  "preflight_at",
  "preflight_expires_at",
  "preflight_rows_total",
  "preflight_rows_failed",
  "preflight_rows_existing",
  "preflight_state_fingerprint",
  "preflight_catalog_fingerprint",
  "execution_state_fingerprint",
  "confirmed_consent_fingerprint",
  "rows_sendable_after",
  "rows_protected_existing",
  "consent_receipts_written",
  "existing_contact_eligibility_policy",
] as const;

const GET_OPTIONAL_KEYS = ["dry_run_results"] as const;

export function parseSubscriberImportResource(
  value: unknown,
): SubscriberImportPreview | null {
  if (!hasExactKeys(value, GET_REQUIRED_KEYS, GET_OPTIONAL_KEYS)) return null;
  const mapping = parseMapping(value.mapping);
  if (!isUUID(value.id) || !isStatus(value.status) || !mapping) return null;
  const samples = parseSamples(value.sample_rows, mapping.headers);
  if (!samples) return null;
  const integerKeys = [
    "rows_total",
    "rows_new",
    "rows_existing",
    "rows_file_dupes",
    "rows_imported",
    "rows_skipped",
    "rows_failed",
    "processed_rows",
    "configuration_revision",
    "drip_hours_interval",
    "drip_hours_total",
    "preflight_rows_failed",
    "preflight_rows_existing",
    "rows_sendable_after",
    "rows_protected_existing",
    "consent_receipts_written",
  ] as const;
  if (!integerKeys.every((key) => isNonnegativeInt(value[key]))) return null;
  if (
    !isSafeImportFilename(value.filename) ||
    !isStrategy(value.on_existing) ||
    !isString(value.error_code, 100) ||
    (value.error_code !== "" && !/^[a-z][a-z0-9_]{0,99}$/.test(value.error_code)) ||
    !isString(value.error, 1_024) ||
    !isRFC3339(value.created_at) ||
    !isString(value.consent_source, 64) ||
    !isString(value.consent_source_url, 2_048) ||
    !isRFC3339(value.consent_captured_at, true) ||
    !isString(value.consent_legal_basis, 32) ||
    !isString(value.consent_jurisdiction, 32) ||
    !isString(value.consent_reason, 500) ||
    !isString(value.consent_policy_version, 100) ||
    !isString(value.consent_evidence_reference, 288) ||
    !isString(value.consent_scope, 32) ||
    typeof value.consent_scope_acknowledged !== "boolean" ||
    !isString(value.consent_contract_version, 100) ||
    (value.consent_contract_state !== "none" &&
      value.consent_contract_state !== "incomplete" &&
      value.consent_contract_state !== "complete") ||
    !isFingerprint(value.source_fingerprint) ||
    value.source_fingerprint_scheme !== "hmac-sha256-v1" ||
    !isSourceKeyVersion(value.source_fingerprint_key_version) ||
    !areNormalizedImportTags(value.tags) ||
    typeof value.auto_create_properties !== "boolean" ||
    (value.schedule_type !== "immediate" && value.schedule_type !== "scheduled") ||
    value.schedule_cron !== "" ||
    !isRFC3339(value.scheduled_at, true) ||
    !isRFC3339(value.next_scheduled_at, true) ||
    value.drip_hours_interval !== 0 ||
    value.drip_hours_total !== 0 ||
    typeof value.dry_run !== "boolean" ||
    !isRFC3339(value.dry_run_at, true) ||
    typeof value.classification_authoritative !== "boolean" ||
    typeof value.preflight_required !== "boolean" ||
    !isFingerprint(value.preflight_fingerprint, true) ||
    !isRFC3339(value.preflight_at, true) ||
    !isRFC3339(value.preflight_expires_at, true) ||
    (value.preflight_rows_total !== null && !isNonnegativeInt(value.preflight_rows_total)) ||
    !isFingerprint(value.preflight_state_fingerprint, true) ||
    !isFingerprint(value.preflight_catalog_fingerprint, true) ||
    !isFingerprint(value.execution_state_fingerprint, true) ||
    !isFingerprint(value.confirmed_consent_fingerprint, true) ||
    value.existing_contact_eligibility_policy !== "preserve" ||
    typeof value.cancel_requested !== "boolean" ||
    !isRFC3339(value.last_chunk_at, true) ||
    typeof value.sample_values_truncated !== "boolean"
  ) {
    return null;
  }
  if (
    mapping.rows !== (value.rows_total as number) ||
    (value.rows_new as number) + (value.rows_existing as number) >
      (value.rows_total as number) ||
    (value.rows_file_dupes as number) > (value.rows_total as number) ||
    (value.processed_rows as number) > (value.rows_total as number) ||
    (value.rows_imported as number) +
      (value.rows_skipped as number) +
      (value.rows_failed as number) >
      (value.processed_rows as number)
  ) {
    return null;
  }
  if (
    (value.preflight_rows_failed as number) > (value.rows_total as number) ||
    (value.preflight_rows_existing as number) > (value.rows_total as number) ||
    (value.rows_sendable_after as number) > (value.rows_total as number) ||
    (value.rows_protected_existing as number) > (value.rows_total as number) ||
    (value.consent_receipts_written as number) > (value.rows_total as number)
  ) {
    return null;
  }
  const classificationAuthoritative = value.classification_authoritative as boolean;
  const preflightRequired = value.preflight_required as boolean;
  if (
    (value.status !== "preview" &&
      (classificationAuthoritative || preflightRequired)) ||
    (value.status === "preview" &&
      preflightRequired === classificationAuthoritative)
  ) {
    return null;
  }
  if (value.consent_contract_state === "none") {
    if (
      value.consent_scope_acknowledged !== false ||
      [
        value.consent_source,
        value.consent_source_url,
        value.consent_captured_at,
        value.consent_legal_basis,
        value.consent_jurisdiction,
        value.consent_reason,
        value.consent_policy_version,
        value.consent_evidence_reference,
        value.consent_scope,
      ].some((item) => item !== "") ||
      value.consent_contract_version !== "subscriber-import-consent/v1"
    ) {
      return null;
    }
  } else if (
    value.consent_contract_state === "complete" &&
    (!isPositiveConsentSource(value.consent_source) ||
      !isSafeConsentUrl(value.consent_source_url) ||
      !isRFC3339(value.consent_captured_at) ||
      !CONSENT_JURISDICTION_RE.test(value.consent_jurisdiction as string) ||
      (value.consent_reason as string).trim() === "" ||
      (value.consent_policy_version as string).trim() === "" ||
      !CONSENT_EVIDENCE_RE.test(value.consent_evidence_reference as string) ||
      value.consent_scope_acknowledged !== true ||
      value.consent_legal_basis !== "consent" ||
      value.consent_scope !== "email_marketing" ||
      value.consent_contract_version !== "subscriber-import-consent/v1")
  ) {
    return null;
  }
  let dryRunResults: SubscriberImportDryRunResults | undefined;
  if (Object.hasOwn(value, "dry_run_results")) {
    dryRunResults = parseSubscriberImportDryRunResults(value.dry_run_results) ?? undefined;
    if (
      !dryRunResults ||
      !value.dry_run ||
      dryRunResults.rows_total !== value.preflight_rows_total ||
      dryRunResults.preflight_fingerprint !== value.preflight_fingerprint ||
      dryRunResults.state_fingerprint !== value.preflight_state_fingerprint ||
      dryRunResults.catalog_fingerprint !== value.preflight_catalog_fingerprint ||
      dryRunResults.validated_at !== value.preflight_at ||
      dryRunResults.validated_at !== value.dry_run_at ||
      dryRunResults.expires_at !== value.preflight_expires_at ||
      dryRunResults.consent_contract_state !== value.consent_contract_state
    ) {
      return null;
    }
  }
  if (
    value.status === "ready" &&
    ((value.processed_rows as number) !== (value.rows_total as number) ||
      (value.rows_imported as number) +
        (value.rows_skipped as number) +
        (value.rows_failed as number) !==
        (value.rows_total as number))
  ) {
    return null;
  }
  return {
    id: value.id as string,
    filename: value.filename as string,
    status: value.status as SubscriberImportStatus,
    mapping,
    sample_rows: samples,
    sample_values_truncated: value.sample_values_truncated as boolean,
    rows_total: value.rows_total as number,
    rows_new: value.rows_new as number,
    rows_existing: value.rows_existing as number,
    rows_file_dupes: value.rows_file_dupes as number,
    rows_imported: value.rows_imported as number,
    rows_skipped: value.rows_skipped as number,
    rows_failed: value.rows_failed as number,
    processed_rows: value.processed_rows as number,
    cancel_requested: value.cancel_requested as boolean,
    last_chunk_at: value.last_chunk_at as string,
    on_existing: value.on_existing as SubscriberImportStrategy,
    error_code: value.error_code as string,
    error: value.error as string,
    created_at: value.created_at as string,
    configuration_revision: value.configuration_revision as number,
    consent_source: value.consent_source as string,
    consent_source_url: value.consent_source_url as string,
    consent_captured_at: value.consent_captured_at as string,
    consent_legal_basis: value.consent_legal_basis as string,
    consent_jurisdiction: value.consent_jurisdiction as string,
    consent_reason: value.consent_reason as string,
    consent_policy_version: value.consent_policy_version as string,
    consent_evidence_reference: value.consent_evidence_reference as string,
    consent_scope: value.consent_scope as string,
    consent_scope_acknowledged: value.consent_scope_acknowledged as boolean,
    consent_contract_version: value.consent_contract_version as string,
    consent_contract_state:
      value.consent_contract_state as SubscriberImportConsentState,
    source_fingerprint: value.source_fingerprint as string,
    source_fingerprint_scheme: "hmac-sha256-v1",
    source_fingerprint_key_version:
      value.source_fingerprint_key_version as string,
    tags: value.tags as string[],
    auto_create_properties: value.auto_create_properties as boolean,
    schedule_type: value.schedule_type as "immediate" | "scheduled",
    schedule_cron: value.schedule_cron as string,
    scheduled_at: value.scheduled_at as string,
    next_scheduled_at: value.next_scheduled_at as string,
    drip_hours_interval: value.drip_hours_interval as number,
    drip_hours_total: value.drip_hours_total as number,
    dry_run: value.dry_run as boolean,
    dry_run_at: value.dry_run_at as string,
    classification_authoritative:
      value.classification_authoritative as boolean,
    preflight_required: value.preflight_required as boolean,
    preflight_fingerprint: value.preflight_fingerprint as string,
    preflight_at: value.preflight_at as string,
    preflight_expires_at: value.preflight_expires_at as string,
    preflight_rows_total: value.preflight_rows_total as number | null,
    preflight_rows_failed: value.preflight_rows_failed as number,
    preflight_rows_existing: value.preflight_rows_existing as number,
    preflight_state_fingerprint: value.preflight_state_fingerprint as string,
    preflight_catalog_fingerprint:
      value.preflight_catalog_fingerprint as string,
    execution_state_fingerprint: value.execution_state_fingerprint as string,
    confirmed_consent_fingerprint:
      value.confirmed_consent_fingerprint as string,
    rows_sendable_after: value.rows_sendable_after as number,
    rows_protected_existing: value.rows_protected_existing as number,
    consent_receipts_written: value.consent_receipts_written as number,
    existing_contact_eligibility_policy: "preserve",
    ...(dryRunResults ? { dry_run_results: dryRunResults } : {}),
  };
}

export function parseSubscriberImportPatchResponse(
  value: unknown,
): SubscriberImportPatchResponse | null {
  if (
    !hasExactKeys(
      value,
      ["id", "status", "updated", "configuration_revision"],
      ["preflight_required"],
    ) ||
    !isUUID(value.id) ||
    value.status !== "preview" ||
    typeof value.updated !== "boolean" ||
    !isNonnegativeInt(value.configuration_revision)
  ) {
    return null;
  }
  if (
    value.updated
      ? value.preflight_required !== true ||
        (value.configuration_revision as number) < 1
      : Object.hasOwn(value, "preflight_required")
  ) {
    return null;
  }
  return {
    id: value.id,
    status: "preview",
    updated: value.updated,
    configuration_revision: value.configuration_revision,
    ...(value.updated ? { preflight_required: true as const } : {}),
  };
}

export function parseSubscriberImportConfirmResponse(
  value: unknown,
): SubscriberImportPreview | null {
  if (hasExactKeys(value, ["id", "status", "dry_run", "dry_run_results"])) {
    const results = parseSubscriberImportDryRunResults(value.dry_run_results);
    return isUUID(value.id) && value.status === "preview" && value.dry_run === true && results
      ? { id: value.id, status: "preview", dry_run: true, dry_run_results: results }
      : null;
  }
  if (
    !hasExactKeys(
      value,
      [
        "id",
        "status",
        "preflight_fingerprint",
        "classification_authoritative",
        "consent_contract_state",
      ],
      ["scheduled", "next_scheduled_at"],
    )
  ) {
    return null;
  }
  if (
    !isUUID(value.id) ||
    value.status !== "queued" ||
    !isFingerprint(value.preflight_fingerprint) ||
    value.classification_authoritative !== true ||
    (value.consent_contract_state !== "none" && value.consent_contract_state !== "complete") ||
    (Object.hasOwn(value, "scheduled") && value.scheduled !== true) ||
    (Object.hasOwn(value, "next_scheduled_at") && !isRFC3339(value.next_scheduled_at)) ||
    Object.hasOwn(value, "scheduled") !==
      Object.hasOwn(value, "next_scheduled_at")
  ) {
    return null;
  }
  return {
    id: value.id,
    status: "queued",
    preflight_fingerprint: value.preflight_fingerprint,
    classification_authoritative: true,
    consent_contract_state: value.consent_contract_state,
    ...(typeof value.next_scheduled_at === "string"
      ? { next_scheduled_at: value.next_scheduled_at }
      : {}),
  };
}

export function parseSubscriberImportCancelResponse(
  value: unknown,
): SubscriberImportCancelResponse | null {
  return hasExactKeys(value, ["id", "status", "cancel_requested"]) &&
    isUUID(value.id) &&
    (value.status === "running" || value.status === "cancelled") &&
    value.cancel_requested === true
    ? { id: value.id, status: value.status, cancel_requested: true }
    : null;
}

export function parseSubscriberImportProgressEvent(
  value: unknown,
): SubscriberImportProgressEvent | null {
  if (
    !hasExactKeys(value, [
      "status",
      "processed_rows",
      "total_rows",
      "rows_imported",
      "rows_skipped",
      "rows_failed",
    ])
  ) {
    return null;
  }
  const status = value.status;
  if (
    status === "preview" ||
    !isStatus(status) ||
    ![
      value.processed_rows,
      value.total_rows,
      value.rows_imported,
      value.rows_skipped,
      value.rows_failed,
    ].every(isNonnegativeInt) ||
    (value.processed_rows as number) > (value.total_rows as number) ||
    (value.rows_imported as number) > (value.total_rows as number) ||
    (value.rows_skipped as number) > (value.total_rows as number) ||
    (value.rows_failed as number) > (value.total_rows as number) ||
    (value.rows_imported as number) +
      (value.rows_skipped as number) +
      (value.rows_failed as number) >
      (value.processed_rows as number)
  ) {
    return null;
  }
  return value as unknown as SubscriberImportProgressEvent;
}

export function parseSubscriberImportHeartbeatEvent(
  value: unknown,
): SubscriberImportHeartbeatEvent | null {
  return hasExactKeys(value, ["at"]) && isRFC3339(value.at)
    ? { at: value.at }
    : null;
}

export function parseSubscriberImportClosedEvent(
  value: unknown,
): SubscriberImportClosedEvent | null {
  return hasExactKeys(value, ["reason"]) && value.reason === "max_duration"
    ? { reason: "max_duration" }
    : null;
}

export function parseSubscriberImportRemapOptions(
  value: unknown,
): SubscriberImportRemapOptions | null {
  if (!hasExactKeys(value, ["merge_fields", "custom_fields"])) return null;
  if (!Array.isArray(value.merge_fields) || !Array.isArray(value.custom_fields)) {
    return null;
  }
  const mergeFields: SubscriberImportMergeFieldOption[] = [];
  const seenKinds = new Set<string>();
  for (const raw of value.merge_fields) {
    if (
      !hasExactKeys(raw, ["kind", "label"]) ||
      !isMappingKind(raw.kind) ||
      seenKinds.has(raw.kind) ||
      !isString(raw.label, 100) ||
      raw.label.trim() === ""
    ) {
      return null;
    }
    seenKinds.add(raw.kind);
    mergeFields.push({ kind: raw.kind, label: raw.label });
  }
  if (
    seenKinds.size !== 5 ||
    !["email", "name", "tags", "custom", "ignore"].every((kind) =>
      seenKinds.has(kind),
    )
  ) {
    return null;
  }
  const customFields: SubscriberImportCustomFieldOption[] = [];
  const seenKeys = new Set<string>();
  for (const raw of value.custom_fields) {
    if (
      !hasExactKeys(raw, ["key", "label", "type"]) ||
      typeof raw.key !== "string" ||
      !CUSTOM_KEY_RE.test(raw.key) ||
      seenKeys.has(raw.key) ||
      !isString(raw.label, 100) ||
      raw.label.trim() === "" ||
      !isCustomFieldType(raw.type)
    ) {
      return null;
    }
    seenKeys.add(raw.key);
    customFields.push({ key: raw.key, label: raw.label, type: raw.type });
  }
  return { merge_fields: mergeFields, custom_fields: customFields };
}

export function subscriberImportContractError(): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_subscriber_import_response_contract",
      message:
        "The server returned an unverified subscriber-import response. The previous reviewed state was kept; retry the request.",
    },
    retryability: "manual",
  };
}

export async function parseSubscriberImportResult<T>(
  result: ApiResult<unknown>,
  parser: (value: unknown) => T | null,
): Promise<ApiResult<T>> {
  if (result.error) return result;
  const parsed = parser(result.data);
  return parsed === null ? subscriberImportContractError() : { data: parsed };
}
