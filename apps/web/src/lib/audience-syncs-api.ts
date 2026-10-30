// SPDX-License-Identifier: AGPL-3.0-only

/** Strict client for webhook audience-sync management and firewall evidence. */
import { api, fetchTextAuthed } from "@/lib/api";
import {
  AudienceActivationContractError,
  AudienceActivationInputError,
  assertAudienceActivationAuthority,
  assertAudienceActivationId,
  assertAudienceActivationIdempotencyKey,
  type AudienceActivationAdminAuthority,
} from "@/lib/audience-activation-authority";

export const AUDIENCE_SYNC_TYPES = [
  "webhook",
  "meta",
  "google_ads",
  "tiktok",
  "linkedin",
  "snap",
] as const;
export const AUDIENCE_SYNC_SCHEDULES = ["manual", "hourly", "daily"] as const;
export const AUDIENCE_SYNC_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rejected",
  "partial",
  "needs_reconciliation",
] as const;

export type AudienceSyncType = (typeof AUDIENCE_SYNC_TYPES)[number];
export type AudienceSyncSchedule = (typeof AUDIENCE_SYNC_SCHEDULES)[number];
export type AudienceSyncRunStatus =
  (typeof AUDIENCE_SYNC_RUN_STATUSES)[number];

export interface AudienceSyncSource {
  list_id?: string;
  segment_id?: string;
}

export interface AudienceSyncDestination {
  type: AudienceSyncType;
  /** Safe display URL: credentials, query, and fragment are never retained. */
  url: string;
  url_redacted: boolean;
  secret_set: boolean;
  secret_hint?: string;
  config: Record<string, unknown>;
  credential_reference_set: boolean;
}

export interface AudienceSync {
  id: string;
  name: string;
  source: AudienceSyncSource;
  destination: AudienceSyncDestination;
  schedule: AudienceSyncSchedule;
  enabled: boolean;
  last_run_at?: string;
  last_run_status?: AudienceSyncRunStatus;
  required_consent_purpose?: string;
  created_at: string;
  updated_at: string;
}

export interface AudienceSyncRun {
  id: string;
  sync_id: string;
  status: AudienceSyncRunStatus;
  rows_exported: number;
  batches_sent: number;
  started_at: string;
  finished_at?: string;
  error?: string;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  provider_status?: string;
  provider_checked_at?: string;
  provider_next_check_at?: string;
  provider_poll_attempts?: number;
  trigger_kind: string;
  source_members_observed: number;
  cap_exceeded: boolean;
  excluded_count: number;
}

export interface AudienceSyncExclusionPreview {
  audience_count: number;
  excluded_consent: number;
  excluded_suppression: number;
  excluded_total: number;
  purpose: string;
  computed_at: string;
  available: boolean;
}

export interface AudienceSyncCreateInput {
  name: string;
  source: AudienceSyncSource;
  destination: {
    type: AudienceSyncType;
    url?: string;
    secret?: string;
    config?: Record<string, unknown>;
  };
  schedule: AudienceSyncSchedule;
  enabled?: boolean;
}

export interface AudienceSyncUpdateInput {
  name?: string;
  source?: AudienceSyncSource;
  destination?: {
    type?: AudienceSyncType;
    url?: string;
    secret?: string;
    config?: Record<string, unknown>;
  };
  schedule?: AudienceSyncSchedule;
  enabled?: boolean;
}

export interface AudienceSyncDeleteReceipt {
  ok: true;
  sync_id: string;
  verified_absent: true;
  receiver_effects: "retained";
}

export interface AudienceSyncExclusionReceipt {
  run_id: string;
  csv: string;
  excluded_rows: number;
  signature: string;
  filename: string;
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL = /\p{Cc}/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;
const SIGNATURE = /^t=\d{1,20},v1=[0-9a-f]{64}$/u;
const MASK = "••••";
const MAX_ROWS = 50_000;
const MAX_CONFIG_BYTES = 64 * 1024;
const LIST_MAX = 10_000;
const SECRET_KEYS = new Set([
  "access_token",
  "access_token_ref",
  "api_key",
  "api_secret",
  "client_secret",
  "credential_ref",
  "credentials_ref",
  "developer_token",
  "developer_token_ref",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "token",
  "token_ref",
]);
const RAW_SECRET_KEYS = new Set([
  "access_token",
  "api_key",
  "api_secret",
  "client_secret",
  "developer_token",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "token",
  "api_base",
  "base_url",
  "data_manager_api_base",
  "data_manager_base_url",
  "endpoint_url",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function safeText(value: unknown, max = 2_048): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    !CONTROL.test(value) &&
    !BIDI.test(value)
  );
}

function optionalText(value: unknown, max = 2_048): value is string | undefined {
  return value === undefined || safeText(value, max);
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || timestamp(value);
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function strongConcurrencyETag(
  response: Response,
  resource: "audience-sync",
  id: string,
): string | undefined {
  if (!response.ok) return undefined;
  const etag = response.headers.get("etag")?.trim() ?? "";
  const prefix = `"${resource}:${id}:v`;
  const version = etag.startsWith(prefix) && etag.endsWith('"')
    ? etag.slice(prefix.length, -1)
    : "";
  if (!/^[1-9]\d*$/u.test(version)) {
    throw new AudienceActivationContractError(
      "The service did not return a strong sync version.",
    );
  }
  return etag;
}

function syncType(value: unknown): value is AudienceSyncType {
  return AUDIENCE_SYNC_TYPES.includes(value as AudienceSyncType);
}

function schedule(value: unknown): value is AudienceSyncSchedule {
  return AUDIENCE_SYNC_SCHEDULES.includes(value as AudienceSyncSchedule);
}

function runStatus(value: unknown): value is AudienceSyncRunStatus {
  return AUDIENCE_SYNC_RUN_STATUSES.includes(value as AudienceSyncRunStatus);
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_CONFIG_BYTES + 1;
  }
}

function scrubConfig(
  value: unknown,
  mode: "read" | "write",
  depth = 0,
): { value: unknown; credentialSet: boolean } {
  if (depth > 8) {
    throw new AudienceActivationInputError("Configuration is too deeply nested.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { value, credentialSet: false };
  }
  if (typeof value === "string") {
    if (!safeText(value, 8_192)) {
      throw new AudienceActivationInputError("Configuration contains an unsafe value.");
    }
    return { value, credentialSet: false };
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new AudienceActivationInputError("Configuration array is too large.");
    }
    let credentialSet = false;
    const entries = value.map((entry) => {
      const decoded = scrubConfig(entry, mode, depth + 1);
      credentialSet ||= decoded.credentialSet;
      return decoded.value;
    });
    return { value: entries, credentialSet };
  }
  if (!record(value)) {
    throw new AudienceActivationInputError("Configuration must be JSON data.");
  }
  const out: Record<string, unknown> = {};
  let credentialSet = false;
  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (!safeText(rawKey, 128) || key === "") {
      throw new AudienceActivationInputError("Configuration contains an unsafe key.");
    }
    if (mode === "write" && RAW_SECRET_KEYS.has(key)) {
      throw new AudienceActivationInputError(
        `Store a credential reference instead of raw ${rawKey}.`,
      );
    }
    if (mode === "read" && SECRET_KEYS.has(key)) {
      if (child !== MASK) {
        throw new AudienceActivationContractError(
          "The service attempted to return credential material.",
        );
      }
      credentialSet = true;
      continue;
    }
    const decoded = scrubConfig(child, mode, depth + 1);
    credentialSet ||= decoded.credentialSet;
    out[rawKey] = decoded.value;
  }
  return { value: out, credentialSet };
}

function checkedConfig(value: Record<string, unknown>): Record<string, unknown> {
  if (!record(value) || jsonBytes(value) > MAX_CONFIG_BYTES) {
    throw new AudienceActivationInputError("Configuration must be at most 64 KiB.");
  }
  return scrubConfig(value, "write").value as Record<string, unknown>;
}

function decodeSource(value: unknown): AudienceSyncSource {
  if (!record(value) || !exactKeys(value, [], ["list_id", "segment_id"])) {
    throw new AudienceActivationContractError();
  }
  const listID = value.list_id;
  const segmentID = value.segment_id;
  if (
    (listID === undefined) === (segmentID === undefined) ||
    (listID !== undefined && typeof listID !== "string") ||
    (segmentID !== undefined && typeof segmentID !== "string")
  ) {
    throw new AudienceActivationContractError();
  }
  try {
    if (typeof listID === "string") assertAudienceActivationId(listID, "List");
    if (typeof segmentID === "string") {
      assertAudienceActivationId(segmentID, "Segment");
    }
  } catch {
    throw new AudienceActivationContractError();
  }
  return {
    ...(typeof listID === "string" ? { list_id: listID } : {}),
    ...(typeof segmentID === "string" ? { segment_id: segmentID } : {}),
  };
}

function safeURL(raw: string): { value: string; redacted: boolean } {
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname === ""
    ) {
      throw new Error("unsafe");
    }
    const redacted = parsed.search !== "" || parsed.hash !== "";
    parsed.search = "";
    parsed.hash = "";
    return { value: parsed.toString(), redacted };
  } catch {
    throw new AudienceActivationContractError("The service returned an unsafe destination URL.");
  }
}

function decodeDestination(value: unknown): AudienceSyncDestination {
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["type", "url"],
      ["secret", "secret_set", "secret_hint", "config"],
    ) ||
    !syncType(value.type) ||
    typeof value.url !== "string" ||
    Object.prototype.hasOwnProperty.call(value, "secret")
  ) {
    throw new AudienceActivationContractError(
      "The service returned malformed or unmasked destination credentials.",
    );
  }
  const secretSet = value.secret_set ?? false;
  if (
    typeof secretSet !== "boolean" ||
    !optionalText(value.secret_hint, 32) ||
    (value.secret_hint !== undefined && !String(value.secret_hint).startsWith(MASK))
  ) {
    throw new AudienceActivationContractError();
  }
  const rawConfig = value.config ?? {};
  if (!record(rawConfig) || jsonBytes(rawConfig) > MAX_CONFIG_BYTES) {
    throw new AudienceActivationContractError();
  }
  let scrubbed: ReturnType<typeof scrubConfig>;
  try {
    scrubbed = scrubConfig(rawConfig, "read");
  } catch (error) {
    if (error instanceof AudienceActivationContractError) throw error;
    throw new AudienceActivationContractError();
  }
  const url =
    value.type === "webhook"
      ? safeURL(value.url)
      : { value: "", redacted: value.url !== "" && value.url !== value.type };
  return {
    type: value.type,
    url: url.value,
    url_redacted: url.redacted,
    secret_set: secretSet,
    ...(typeof value.secret_hint === "string"
      ? { secret_hint: value.secret_hint }
      : {}),
    config: scrubbed.value as Record<string, unknown>,
    credential_reference_set: scrubbed.credentialSet,
  };
}

function decodeSync(value: unknown): AudienceSync {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "id",
        "name",
        "source",
        "destination",
        "schedule",
        "enabled",
        "created_at",
        "updated_at",
      ],
      ["last_run_at", "last_run_status", "required_consent_purpose"],
    )
  ) {
    throw new AudienceActivationContractError();
  }
  try {
    assertAudienceActivationId(String(value.id), "Sync");
  } catch {
    throw new AudienceActivationContractError();
  }
  if (
    !safeText(value.name, 200) ||
    String(value.name).trim() === "" ||
    !schedule(value.schedule) ||
    typeof value.enabled !== "boolean" ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at) ||
    !optionalTimestamp(value.last_run_at) ||
    (value.last_run_status !== undefined && !runStatus(value.last_run_status)) ||
    !optionalText(value.required_consent_purpose, 128)
  ) {
    throw new AudienceActivationContractError();
  }
  return {
    id: value.id as string,
    name: value.name,
    source: decodeSource(value.source),
    destination: decodeDestination(value.destination),
    schedule: value.schedule,
    enabled: value.enabled,
    ...(typeof value.last_run_at === "string"
      ? { last_run_at: value.last_run_at }
      : {}),
    ...(runStatus(value.last_run_status)
      ? { last_run_status: value.last_run_status }
      : {}),
    ...(typeof value.required_consent_purpose === "string"
      ? { required_consent_purpose: value.required_consent_purpose }
      : {}),
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function decodeRun(value: unknown): AudienceSyncRun {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "id",
        "sync_id",
        "status",
        "rows_exported",
        "batches_sent",
        "started_at",
        "trigger_kind",
        "source_members_observed",
        "cap_exceeded",
        "excluded_count",
      ],
      [
        "finished_at",
        "error",
        "external_job_id",
        "external_audience_id",
        "provider_message",
        "provider_status",
        "provider_checked_at",
        "provider_next_check_at",
        "provider_poll_attempts",
      ],
    )
  ) {
    throw new AudienceActivationContractError();
  }
  try {
    assertAudienceActivationId(String(value.id), "Run");
    assertAudienceActivationId(String(value.sync_id), "Sync");
  } catch {
    throw new AudienceActivationContractError();
  }
  if (
    !runStatus(value.status) ||
    !nonNegativeInt(value.rows_exported) ||
    !nonNegativeInt(value.batches_sent) ||
    !timestamp(value.started_at) ||
    !optionalTimestamp(value.finished_at) ||
    !optionalText(value.error, 4_000) ||
    !optionalText(value.external_job_id) ||
    !optionalText(value.external_audience_id) ||
    !optionalText(value.provider_message) ||
    !optionalText(value.provider_status) ||
    !optionalTimestamp(value.provider_checked_at) ||
    !optionalTimestamp(value.provider_next_check_at) ||
    (value.provider_poll_attempts !== undefined &&
      !nonNegativeInt(value.provider_poll_attempts)) ||
    !safeText(value.trigger_kind, 64) ||
    !nonNegativeInt(value.source_members_observed) ||
    typeof value.cap_exceeded !== "boolean" ||
    !nonNegativeInt(value.excluded_count)
  ) {
    throw new AudienceActivationContractError();
  }
  return value as unknown as AudienceSyncRun;
}

function decodeItems<T>(value: unknown, decoder: (entry: unknown) => T): T[] {
  if (
    !record(value) ||
    !exactKeys(value, ["items"]) ||
    !Array.isArray(value.items) ||
    value.items.length > LIST_MAX
  ) {
    throw new AudienceActivationContractError();
  }
  return value.items.map(decoder);
}

function checkedSource(source: AudienceSyncSource): AudienceSyncSource {
  if (Boolean(source.list_id) === Boolean(source.segment_id)) {
    throw new AudienceActivationInputError("Choose exactly one list or segment.");
  }
  if (source.list_id && !/^\d{1,19}$/u.test(source.list_id)) {
    assertAudienceActivationId(source.list_id, "List");
  }
  if (source.segment_id) assertAudienceActivationId(source.segment_id, "Segment");
  return source;
}

function checkedName(name: string): string {
  const normalized = name.trim();
  if (!safeText(normalized, 200) || normalized === "") {
    throw new AudienceActivationInputError("Name is required and must be at most 200 characters.");
  }
  return normalized;
}

function checkedURL(value: string): string {
  if (value.length > 2_048) {
    throw new AudienceActivationInputError("Webhook URL must be at most 2,048 characters.");
  }
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("unsafe");
    }
    return parsed.toString();
  } catch {
    throw new AudienceActivationInputError(
      "Use an HTTPS webhook URL without embedded credentials.",
    );
  }
}

function checkedDestination(
  destination: AudienceSyncCreateInput["destination"],
): AudienceSyncCreateInput["destination"] {
  if (!syncType(destination.type)) {
    throw new AudienceActivationInputError("Choose a supported destination type.");
  }
  if (destination.type === "webhook") {
    const secret = destination.secret?.trim() ?? "";
    if (!safeText(secret, 4_096) || secret.length < 16) {
      throw new AudienceActivationInputError(
        "Use a webhook signing secret of at least 16 characters.",
      );
    }
    return {
      type: "webhook",
      url: checkedURL(destination.url ?? ""),
      secret,
    };
  }
  if (!destination.config) {
    throw new AudienceActivationInputError("Provider configuration is required.");
  }
  return { type: destination.type, config: checkedConfig(destination.config) };
}

export async function listAudienceSyncs(input: {
  signal?: AbortSignal;
} = {}): Promise<AudienceSync[]> {
  return decodeItems(
    await api.get<unknown>("/api/v1/audience-syncs", { signal: input.signal }),
    decodeSync,
  );
}

export async function getAudienceSync(input: {
  syncId: string;
  signal?: AbortSignal;
}): Promise<AudienceSync> {
  return (await getAudienceSyncVersioned(input)).row;
}

async function getAudienceSyncVersioned(input: {
  syncId: string;
  signal?: AbortSignal;
}): Promise<{ row: AudienceSync; etag: string }> {
  assertAudienceActivationId(input.syncId, "Sync");
  let etag: string | undefined;
  const row = decodeSync(
    await api.get<unknown>(
      `/api/v1/audience-syncs/${encodeURIComponent(input.syncId)}`,
      {
        signal: input.signal,
        onResponse: (response) => {
          etag = strongConcurrencyETag(response, "audience-sync", input.syncId);
        },
      },
    ),
  );
  if (row.id !== input.syncId) throw new AudienceActivationContractError();
  if (!etag) {
    throw new AudienceActivationContractError(
      "The service did not return a strong sync version.",
    );
  }
  return { row, etag };
}

export async function createAudienceSync(input: {
  authority: AudienceActivationAdminAuthority;
  sync: AudienceSyncCreateInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceSync> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  if (!schedule(input.sync.schedule)) {
    throw new AudienceActivationInputError("Choose manual, hourly, or daily.");
  }
  const body: AudienceSyncCreateInput = {
    name: checkedName(input.sync.name),
    source: checkedSource(input.sync.source),
    destination: checkedDestination(input.sync.destination),
    schedule: input.sync.schedule,
    ...(typeof input.sync.enabled === "boolean"
      ? { enabled: input.sync.enabled }
      : {}),
  };
  return decodeSync(
    await api.post<unknown>("/api/v1/audience-syncs", body, {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 1,
    }),
  );
}

export async function updateAudienceSync(input: {
  authority: AudienceActivationAdminAuthority;
  current: AudienceSync;
  patch: AudienceSyncUpdateInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceSync> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Sync");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  const current = await getAudienceSyncVersioned({
    syncId: input.current.id,
    signal: input.signal,
  });
  if (current.row.updated_at !== input.current.updated_at) {
    throw new AudienceActivationInputError(
      "This sync changed after it was loaded. Review the refreshed row before saving.",
    );
  }
  const patch: AudienceSyncUpdateInput = {};
  if (input.patch.name !== undefined) patch.name = checkedName(input.patch.name);
  if (input.patch.source !== undefined) {
    patch.source = checkedSource(input.patch.source);
  }
  if (input.patch.schedule !== undefined) {
    if (!schedule(input.patch.schedule)) {
      throw new AudienceActivationInputError("Choose manual, hourly, or daily.");
    }
    patch.schedule = input.patch.schedule;
  }
  if (input.patch.enabled !== undefined) patch.enabled = input.patch.enabled;
  if (input.patch.destination !== undefined) {
    const destination = input.patch.destination;
    const type = destination.type ?? input.current.destination.type;
    if (!syncType(type)) {
      throw new AudienceActivationInputError("Choose a supported destination type.");
    }
    if (type === "webhook") {
      patch.destination = {
        type,
        ...(destination.url ? { url: checkedURL(destination.url) } : {}),
        ...(destination.secret
          ? { secret: checkedDestination({ type, url: input.current.destination.url, secret: destination.secret }).secret }
          : {}),
      };
    } else {
      patch.destination = {
        type,
        ...(destination.config
          ? { config: checkedConfig(destination.config) }
          : {}),
      };
    }
  }
  const row = decodeSync(
    await api.patch<unknown>(
      `/api/v1/audience-syncs/${encodeURIComponent(input.current.id)}`,
      patch,
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
        headers: { "If-Match": current.etag },
      },
    ),
  );
  if (row.id !== input.current.id) throw new AudienceActivationContractError();
  return row;
}

export async function deleteAudienceSync(input: {
  authority: AudienceActivationAdminAuthority;
  current: AudienceSync;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceSyncDeleteReceipt> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Sync");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  const currentVersion = await getAudienceSyncVersioned({
    syncId: input.current.id,
    signal: input.signal,
  });
  if (currentVersion.row.updated_at !== input.current.updated_at) {
    throw new AudienceActivationInputError(
      "This sync changed after it was loaded. Review the refreshed row before deleting it.",
    );
  }
  await api.delete<void>(
    `/api/v1/audience-syncs/${encodeURIComponent(input.current.id)}`,
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 1,
      headers: { "If-Match": currentVersion.etag },
    },
  );
  const current = await listAudienceSyncs({ signal: input.signal });
  if (current.some((row) => row.id === input.current.id)) {
    throw new AudienceActivationContractError(
      "The delete response could not be verified against current inventory.",
    );
  }
  return {
    ok: true,
    sync_id: input.current.id,
    verified_absent: true,
    receiver_effects: "retained",
  };
}

export async function runAudienceSync(input: {
  authority: AudienceActivationAdminAuthority;
  current: AudienceSync;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceSyncRun> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Sync");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  if (!input.current.enabled) {
    throw new AudienceActivationInputError("Enable the sync before running it.");
  }
  const currentVersion = await getAudienceSyncVersioned({
    syncId: input.current.id,
    signal: input.signal,
  });
  if (
    currentVersion.row.updated_at !== input.current.updated_at ||
    !currentVersion.row.enabled
  ) {
    throw new AudienceActivationInputError(
      "This sync changed after it was loaded. Review the refreshed row before running it.",
    );
  }
  const run = decodeRun(
    await api.post<unknown>(
      `/api/v1/audience-syncs/${encodeURIComponent(input.current.id)}/run`,
      {},
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
        timeoutMs: 65_000,
        headers: { "If-Match": currentVersion.etag },
      },
    ),
  );
  if (run.sync_id !== input.current.id || run.status === "running") {
    throw new AudienceActivationContractError(
      "The service did not return a closed run receipt for this sync.",
    );
  }
  return run;
}

export async function listAudienceSyncRuns(
  id: string,
  input: { signal?: AbortSignal } = {},
): Promise<AudienceSyncRun[]> {
  assertAudienceActivationId(id, "Sync");
  const rows = decodeItems(
    await api.get<unknown>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}/runs`,
      { signal: input.signal },
    ),
    decodeRun,
  );
  if (rows.some((row) => row.sync_id !== id)) {
    throw new AudienceActivationContractError("The service mixed sync run histories.");
  }
  return rows;
}

export async function previewAudienceSyncExclusions(input: {
  syncId: string;
  signal?: AbortSignal;
}): Promise<AudienceSyncExclusionPreview> {
  assertAudienceActivationId(input.syncId, "Sync");
  const value = await api.get<unknown>(
    `/api/v1/audience-syncs/${encodeURIComponent(input.syncId)}/exclusion-preview`,
    { signal: input.signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, [
      "audience_count",
      "excluded_consent",
      "excluded_suppression",
      "excluded_total",
      "purpose",
      "computed_at",
    ]) ||
    !safeText(value.purpose, 128) ||
    !timestamp(value.computed_at)
  ) {
    throw new AudienceActivationContractError();
  }
  const counts = [
    value.audience_count,
    value.excluded_consent,
    value.excluded_suppression,
    value.excluded_total,
  ];
  const unavailable = counts.every((count) => count === -1);
  if (
    (!unavailable && !counts.every(nonNegativeInt)) ||
    (unavailable && !counts.every((count) => count === -1)) ||
    (!unavailable &&
      Number(value.excluded_consent) + Number(value.excluded_suppression) !==
        value.excluded_total) ||
    (!unavailable && Number(value.excluded_total) > Number(value.audience_count))
  ) {
    throw new AudienceActivationContractError();
  }
  return {
    audience_count: value.audience_count as number,
    excluded_consent: value.excluded_consent as number,
    excluded_suppression: value.excluded_suppression as number,
    excluded_total: value.excluded_total as number,
    purpose: value.purpose,
    computed_at: value.computed_at,
    available: !unavailable,
  };
}

function parseCSVRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      if (rows.length > MAX_ROWS + 1) throw new AudienceActivationContractError();
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new AudienceActivationContractError("The receipt CSV is truncated.");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Fetches signed CSV evidence without putting subscriber emails in React Query
 * or local storage. The caller should download and drop the returned string.
 */
export async function getExclusionReceipt(
  runId: string,
  input: { signal?: AbortSignal } = {},
): Promise<AudienceSyncExclusionReceipt> {
  assertAudienceActivationId(runId, "Run");
  let signature = "";
  let filename = "";
  const csv = await fetchTextAuthed(
    `/api/v1/audience-sync-runs/${encodeURIComponent(runId)}/exclusion-receipt`,
    {
      signal: input.signal,
      // The mounted endpoint can return up to 50,000 bounded receipt rows;
      // retain a reviewed ceiling without inheriting the 2 MiB JSON default.
      maxBytes: 32 * 1024 * 1024,
      onResponse: (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        signature = response.headers.get("x-postwave-receipt-signature") ?? "";
        const disposition = response.headers.get("content-disposition") ?? "";
        const match = disposition.match(
          /^attachment; filename="(exclusion-receipt-[A-Za-z0-9_-]+\.csv)"$/u,
        );
        const expectedFilename = `exclusion-receipt-${runId}.csv`;
        if (
          response.ok &&
          (!contentType.toLowerCase().startsWith("text/csv") ||
            !SIGNATURE.test(signature) ||
            !match ||
            match[1] !== expectedFilename)
        ) {
          throw new AudienceActivationContractError(
            "The exclusion receipt was not returned as signed CSV evidence.",
          );
        }
        filename = match?.[1] ?? "";
      },
    },
  );
  const rows = parseCSVRows(csv);
  const header = [
    "subscriber_email",
    "rule_class",
    "rule_reason",
    "purpose",
    "consent_event_id",
    "excluded_at",
    "signature",
  ];
  if (
    rows.length === 0 ||
    rows[0]!.length !== header.length ||
    rows[0]!.some((cell, index) => cell !== header[index])
  ) {
    throw new AudienceActivationContractError("The receipt CSV header is malformed.");
  }
  for (const row of rows.slice(1)) {
    if (
      row.length !== header.length ||
      !safeText(row[0], 320) ||
      !["consent", "suppression", "policy"].includes(row[1] ?? "") ||
      !safeText(row[2], 2_048) ||
      !safeText(row[3], 128) ||
      !/^\d*$/u.test(row[4] ?? "") ||
      !timestamp(row[5]) ||
      !/^[0-9a-f]{64}$/u.test(row[6] ?? "")
    ) {
      throw new AudienceActivationContractError("The receipt CSV contains a malformed row.");
    }
  }
  return {
    run_id: runId,
    csv,
    excluded_rows: rows.length - 1,
    signature,
    filename,
  };
}
