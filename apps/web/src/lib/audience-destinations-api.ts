// SPDX-License-Identifier: AGPL-3.0-only

/** Strict web boundary for the mounted ad-platform audience-destination API. */
import { api } from "@/lib/api";
import {
  AudienceActivationContractError,
  AudienceActivationInputError,
  assertAudienceActivationAuthority,
  assertAudienceActivationId,
  assertAudienceActivationIdempotencyKey,
  type AudienceActivationAdminAuthority,
} from "@/lib/audience-activation-authority";

export const AUDIENCE_DESTINATION_PROVIDERS = [
  "meta",
  "google_ads",
  "tiktok",
  "linkedin",
  "snap",
] as const;
export const AUDIENCE_DESTINATION_STATUSES = [
  "draft",
  "active",
  "paused",
  "syncing",
  "error",
  "disconnected",
] as const;
export const AUDIENCE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rejected",
  "partial",
  "needs_reconciliation",
] as const;

export type AudienceDestinationProvider =
  (typeof AUDIENCE_DESTINATION_PROVIDERS)[number];
export type AudienceDestinationStatus =
  (typeof AUDIENCE_DESTINATION_STATUSES)[number];
export type AudienceRunStatus = (typeof AUDIENCE_RUN_STATUSES)[number];

export interface DestinationCapability {
  configured: boolean;
  diagnostics: boolean;
}

export interface DestinationProviders {
  capabilities: Partial<
    Record<AudienceDestinationProvider, DestinationCapability>
  >;
  providers: AudienceDestinationProvider[];
}

export interface AudienceDestination {
  id: string;
  tenant_id: string;
  provider: AudienceDestinationProvider;
  list_id?: string;
  segment_id?: string;
  external_audience_id?: string;
  status: AudienceDestinationStatus;
  last_synced_at?: string;
  /** Non-secret provider configuration only. Credential fields are discarded. */
  config: Record<string, unknown>;
  credential_reference_set: boolean;
  created_at: string;
  updated_at: string;
}

export interface AudienceDestinationJob {
  id: string;
  tenant_id: string;
  destination_id: string;
  started_at: string;
  finished_at?: string;
  status: AudienceRunStatus;
  error?: string;
  members_synced: number;
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
  created_at: string;
}

export interface AudienceDestinationReadiness {
  provider: AudienceDestinationProvider;
  ready: boolean;
  status: string;
  detail: string;
  missing: string[];
  docs: string[];
}

export interface AudienceDestinationPreview {
  destination_id: string;
  provider: AudienceDestinationProvider;
  total_members: number;
  excluded_count: number;
  deliverable: number;
  truncated: boolean;
  firewall_active: boolean;
}

export interface AudienceDestinationSyncReceipt {
  status: AudienceRunStatus;
  replayed: boolean;
  destination: AudienceDestination;
  job: AudienceDestinationJob;
  provider?: AudienceDestinationProvider;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  total_members?: number;
  excluded_count?: number;
  members_sent?: number;
  source_members_at_least?: number;
  cap_exceeded?: boolean;
}

export interface AudienceDestinationDiagnostics {
  destination: AudienceDestination;
  job: AudienceDestinationJob;
  diagnostics: {
    provider: AudienceDestinationProvider;
    external_job_id?: string;
    external_audience_id?: string;
    provider_message?: string;
    provider_status?: string;
  };
}

export interface AudienceDestinationCreateInput {
  provider: AudienceDestinationProvider;
  list_id?: string;
  segment_id?: string;
  external_audience_id?: string;
  config: Record<string, unknown>;
}

export interface AudienceDestinationUpdateInput {
  status?: "active" | "paused";
  external_audience_id?: string;
  config?: Record<string, unknown>;
}

export interface AudienceDestinationDisconnectReceipt {
  ok: true;
  provider_cleanup: {
    provider: AudienceDestinationProvider;
    status: "operator_action_required";
    recorded_at: string;
    postwave_status: "disconnected";
    provider_cleanup_posture: "operator_managed_provider_console";
    managed_provider_cleanup: false;
    provider_scope_type?: string;
    provider_scope_id?: string;
    external_audience_id?: string;
    credential_ref_present?: boolean;
    audience_cleanup_status: string;
    audience_membership_cleanup_status: string;
    credential_cleanup_status: string;
    postwave_effects: string[];
    provider_console_actions: string[];
    provider_cleanup_evidence: string[];
  };
}

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CONTROL = /\p{Cc}/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;
const TOKEN_MAX = 2_048;
const CONFIG_MAX_BYTES = 64 * 1024;
// The mounted inventory endpoints are currently unpaginated. Bound decoding
// by the shared response-size limit, without inventing a false 100-row cap.
const LIST_MAX = 10_000;
const MASK = "••••";
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
const WRITE_FORBIDDEN_KEYS = new Set([
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

function provider(value: unknown): value is AudienceDestinationProvider {
  return AUDIENCE_DESTINATION_PROVIDERS.includes(
    value as AudienceDestinationProvider,
  );
}

function destinationStatus(value: unknown): value is AudienceDestinationStatus {
  return AUDIENCE_DESTINATION_STATUSES.includes(
    value as AudienceDestinationStatus,
  );
}

function runStatus(value: unknown): value is AudienceRunStatus {
  return AUDIENCE_RUN_STATUSES.includes(value as AudienceRunStatus);
}

function safeToken(value: unknown, max = TOKEN_MAX): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    !CONTROL.test(value) &&
    !BIDI.test(value)
  );
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalToken(value: unknown): value is string | undefined {
  return value === undefined || safeToken(value);
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || timestamp(value);
}

function strongConcurrencyETag(
  response: Response,
  resource: "audience-destination",
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
      "The service did not return a strong destination version.",
    );
  }
  return etag;
}

function sanitizeJSON(
  value: unknown,
  mode: "read" | "write",
  depth = 0,
): unknown {
  if (depth > 8) {
    throw new AudienceActivationInputError("Configuration is too deeply nested.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (!safeToken(value, 8_192)) {
      throw new AudienceActivationInputError("Configuration contains an unsafe value.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new AudienceActivationInputError("Configuration array is too large.");
    }
    return value.map((entry) => sanitizeJSON(entry, mode, depth + 1));
  }
  if (!record(value)) {
    throw new AudienceActivationInputError("Configuration must be JSON data.");
  }
  const out: Record<string, unknown> = {};
  for (const [rawKey, child] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (!safeToken(rawKey, 128) || key === "") {
      throw new AudienceActivationInputError("Configuration contains an unsafe key.");
    }
    if (mode === "write" && WRITE_FORBIDDEN_KEYS.has(key)) {
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
      continue;
    }
    out[rawKey] = sanitizeJSON(child, mode, depth + 1);
  }
  return out;
}

function configBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return CONFIG_MAX_BYTES + 1;
  }
}

function decodeConfig(value: unknown): {
  config: Record<string, unknown>;
  credentialReferenceSet: boolean;
} {
  if (!record(value) || configBytes(value) > CONFIG_MAX_BYTES) {
    throw new AudienceActivationContractError();
  }
  const credentialReferenceSet = Object.entries(value).some(
    ([key, child]) => SECRET_KEYS.has(key.trim().toLowerCase()) && child === MASK,
  );
  try {
    return {
      config: sanitizeJSON(value, "read") as Record<string, unknown>,
      credentialReferenceSet,
    };
  } catch (error) {
    if (error instanceof AudienceActivationContractError) throw error;
    throw new AudienceActivationContractError();
  }
}

function decodeDestination(value: unknown): AudienceDestination {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "id",
        "tenant_id",
        "provider",
        "status",
        "config",
        "created_at",
        "updated_at",
      ],
      ["list_id", "segment_id", "external_audience_id", "last_synced_at"],
    )
  ) {
    throw new AudienceActivationContractError();
  }
  try {
    assertAudienceActivationId(String(value.id), "Destination");
    assertAudienceActivationId(String(value.tenant_id), "Workspace");
  } catch {
    throw new AudienceActivationContractError();
  }
  const listID = value.list_id;
  const segmentID = value.segment_id;
  if (
    !provider(value.provider) ||
    !destinationStatus(value.status) ||
    (listID === undefined) === (segmentID === undefined) ||
    (listID !== undefined && typeof listID !== "string") ||
    (segmentID !== undefined && typeof segmentID !== "string") ||
    !optionalToken(value.external_audience_id) ||
    !optionalTimestamp(value.last_synced_at) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at)
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
  const decoded = decodeConfig(value.config);
  return {
    id: value.id as string,
    tenant_id: value.tenant_id as string,
    provider: value.provider,
    ...(typeof listID === "string" ? { list_id: listID } : {}),
    ...(typeof segmentID === "string" ? { segment_id: segmentID } : {}),
    ...(typeof value.external_audience_id === "string"
      ? { external_audience_id: value.external_audience_id }
      : {}),
    status: value.status,
    ...(typeof value.last_synced_at === "string"
      ? { last_synced_at: value.last_synced_at }
      : {}),
    config: decoded.config,
    credential_reference_set: decoded.credentialReferenceSet,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function decodeJob(value: unknown): AudienceDestinationJob {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "id",
        "tenant_id",
        "destination_id",
        "started_at",
        "status",
        "members_synced",
        "trigger_kind",
        "source_members_observed",
        "cap_exceeded",
        "created_at",
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
    for (const [id, label] of [
      [value.id, "Job"],
      [value.tenant_id, "Workspace"],
      [value.destination_id, "Destination"],
    ] as const) {
      assertAudienceActivationId(String(id), label);
    }
  } catch {
    throw new AudienceActivationContractError();
  }
  if (
    !timestamp(value.started_at) ||
    !timestamp(value.created_at) ||
    !optionalTimestamp(value.finished_at) ||
    !runStatus(value.status) ||
    !nonNegativeInt(value.members_synced) ||
    !nonNegativeInt(value.source_members_observed) ||
    typeof value.cap_exceeded !== "boolean" ||
    !safeToken(value.trigger_kind, 64) ||
    !optionalToken(value.error) ||
    !optionalToken(value.external_job_id) ||
    !optionalToken(value.external_audience_id) ||
    !optionalToken(value.provider_message) ||
    !optionalToken(value.provider_status) ||
    !optionalTimestamp(value.provider_checked_at) ||
    !optionalTimestamp(value.provider_next_check_at) ||
    (value.provider_poll_attempts !== undefined &&
      !nonNegativeInt(value.provider_poll_attempts))
  ) {
    throw new AudienceActivationContractError();
  }
  return value as unknown as AudienceDestinationJob;
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

function assertTenant(destination: AudienceDestination, tenantId: string): void {
  if (destination.tenant_id !== tenantId) {
    throw new AudienceActivationContractError(
      "The service returned a destination for a different workspace.",
    );
  }
}

function checkedConfig(input: Record<string, unknown>): Record<string, unknown> {
  if (!record(input) || configBytes(input) > CONFIG_MAX_BYTES) {
    throw new AudienceActivationInputError("Configuration must be at most 64 KiB.");
  }
  return sanitizeJSON(input, "write") as Record<string, unknown>;
}

function checkedCreate(
  input: AudienceDestinationCreateInput,
): AudienceDestinationCreateInput {
  if (!provider(input.provider)) {
    throw new AudienceActivationInputError("Choose a supported provider.");
  }
  if (Boolean(input.list_id) === Boolean(input.segment_id)) {
    throw new AudienceActivationInputError("Choose exactly one list or segment.");
  }
  if (
    input.list_id &&
    !/^\d{1,19}$/u.test(input.list_id)
  ) {
    assertAudienceActivationId(input.list_id, "List");
  }
  if (input.segment_id) assertAudienceActivationId(input.segment_id, "Segment");
  if (!optionalToken(input.external_audience_id)) {
    throw new AudienceActivationInputError("External audience id is unsafe.");
  }
  return { ...input, config: checkedConfig(input.config) };
}

export async function getDestinationProviders(
  input: { signal?: AbortSignal } = {},
): Promise<DestinationProviders> {
  const value = await api.get<unknown>(
    "/api/v1/audience-destinations/providers",
    { signal: input.signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, ["providers", "capabilities"]) ||
    !Array.isArray(value.providers) ||
    !value.providers.every(provider) ||
    new Set(value.providers).size !== value.providers.length ||
    !record(value.capabilities)
  ) {
    throw new AudienceActivationContractError();
  }
  const capabilities: DestinationProviders["capabilities"] = {};
  for (const offered of value.providers) {
    const raw = value.capabilities[offered];
    if (
      !record(raw) ||
      !exactKeys(raw, ["configured", "diagnostics"]) ||
      typeof raw.configured !== "boolean" ||
      typeof raw.diagnostics !== "boolean"
    ) {
      throw new AudienceActivationContractError();
    }
    capabilities[offered] = {
      configured: raw.configured,
      diagnostics: raw.diagnostics,
    };
  }
  if (Object.keys(value.capabilities).some((key) => !provider(key))) {
    throw new AudienceActivationContractError();
  }
  return { providers: [...value.providers], capabilities };
}

export async function listAudienceDestinations(
  input: {
    tenantId?: string;
    provider?: AudienceDestinationProvider;
    signal?: AbortSignal;
  } = {},
): Promise<AudienceDestination[]> {
  const query = input.provider
    ? `?provider=${encodeURIComponent(input.provider)}`
    : "";
  const value = await api.get<unknown>(
    `/api/v1/audience-destinations${query}`,
    { signal: input.signal },
  );
  const rows = decodeItems(value, decodeDestination);
  if (input.tenantId) {
    rows.forEach((row) => assertTenant(row, input.tenantId!));
  }
  return rows;
}

export async function getAudienceDestination(input: {
  tenantId: string;
  destinationId: string;
  signal?: AbortSignal;
}): Promise<AudienceDestination> {
  return (await getAudienceDestinationVersioned(input)).row;
}

async function getAudienceDestinationVersioned(input: {
  tenantId: string;
  destinationId: string;
  signal?: AbortSignal;
}): Promise<{ row: AudienceDestination; etag: string }> {
  assertAudienceActivationId(input.tenantId, "Workspace");
  assertAudienceActivationId(input.destinationId, "Destination");
  let etag: string | undefined;
  const row = decodeDestination(
    await api.get<unknown>(
      `/api/v1/audience-destinations/${encodeURIComponent(input.destinationId)}`,
      {
        signal: input.signal,
        onResponse: (response) => {
          etag = strongConcurrencyETag(
            response,
            "audience-destination",
            input.destinationId,
          );
        },
      },
    ),
  );
  assertTenant(row, input.tenantId);
  if (!etag) {
    throw new AudienceActivationContractError(
      "The service did not return a strong destination version.",
    );
  }
  return { row, etag };
}

export async function createAudienceDestination(input: {
  authority: AudienceActivationAdminAuthority;
  destination: AudienceDestinationCreateInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceDestination> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  const row = decodeDestination(
    await api.post<unknown>(
      "/api/v1/audience-destinations",
      checkedCreate(input.destination),
      {
        signal: input.signal,
        requireOnline: true,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: 1,
      },
    ),
  );
  assertTenant(row, input.authority.tenantId);
  if (row.provider !== input.destination.provider) {
    throw new AudienceActivationContractError(
      "The create receipt did not match the requested provider.",
    );
  }
  return row;
}

export async function updateAudienceDestination(input: {
  authority: AudienceActivationAdminAuthority;
  current: Pick<AudienceDestination, "id" | "tenant_id" | "updated_at">;
  patch: AudienceDestinationUpdateInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceDestination> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Destination");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  if (
    input.current.tenant_id !== input.authority.tenantId ||
    !timestamp(input.current.updated_at)
  ) {
    throw new AudienceActivationInputError(
      "Refresh the destination before editing it.",
    );
  }
  const current = await getAudienceDestinationVersioned({
    tenantId: input.authority.tenantId,
    destinationId: input.current.id,
    signal: input.signal,
  });
  if (current.row.updated_at !== input.current.updated_at) {
    throw new AudienceActivationInputError(
      "This destination changed after it was loaded. Review the refreshed row before saving.",
    );
  }
  if (
    input.patch.status !== undefined &&
    input.patch.status !== "active" &&
    input.patch.status !== "paused"
  ) {
    throw new AudienceActivationInputError("Status must be active or paused.");
  }
  if (!optionalToken(input.patch.external_audience_id)) {
    throw new AudienceActivationInputError("External audience id is unsafe.");
  }
  const patch = {
    ...input.patch,
    ...(input.patch.config
      ? { config: checkedConfig(input.patch.config) }
      : {}),
  };
  const row = decodeDestination(
    await api.patch<unknown>(
      `/api/v1/audience-destinations/${encodeURIComponent(input.current.id)}`,
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
  assertTenant(row, input.authority.tenantId);
  if (row.id !== input.current.id) {
    throw new AudienceActivationContractError();
  }
  return row;
}

export async function disconnectAudienceDestination(input: {
  authority: AudienceActivationAdminAuthority;
  current: Pick<
    AudienceDestination,
    "id" | "tenant_id" | "provider" | "updated_at"
  >;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceDestinationDisconnectReceipt> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Destination");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  if (
    input.current.tenant_id !== input.authority.tenantId ||
    !timestamp(input.current.updated_at)
  ) {
    throw new AudienceActivationInputError(
      "Refresh the destination before disconnecting it.",
    );
  }
  const current = await getAudienceDestinationVersioned({
    tenantId: input.authority.tenantId,
    destinationId: input.current.id,
    signal: input.signal,
  });
  if (
    current.row.updated_at !== input.current.updated_at ||
    current.row.provider !== input.current.provider
  ) {
    throw new AudienceActivationInputError(
      "This destination changed after it was loaded. Review the refreshed row before disconnecting it.",
    );
  }
  const value = await api.delete<unknown>(
    `/api/v1/audience-destinations/${encodeURIComponent(input.current.id)}`,
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 1,
      headers: { "If-Match": current.etag },
    },
  );
  if (
    !record(value) ||
    !exactKeys(value, ["ok", "provider_cleanup"]) ||
    value.ok !== true ||
    !record(value.provider_cleanup)
  ) {
    throw new AudienceActivationContractError(
      "The service did not return an exact disconnect receipt.",
    );
  }
  const cleanup = value.provider_cleanup;
  if (
    !exactKeys(
      cleanup,
      [
        "provider",
        "status",
        "recorded_at",
        "postwave_status",
        "provider_cleanup_posture",
        "managed_provider_cleanup",
        "audience_cleanup_status",
        "audience_membership_cleanup_status",
        "credential_cleanup_status",
      ],
      [
        "provider_scope_type",
        "provider_scope_id",
        "external_audience_id",
        "credential_ref_present",
        "postwave_effects",
        "provider_console_actions",
        "provider_cleanup_evidence",
      ],
    ) ||
    cleanup.provider !== input.current.provider ||
    cleanup.status !== "operator_action_required" ||
    cleanup.postwave_status !== "disconnected" ||
    cleanup.provider_cleanup_posture !== "operator_managed_provider_console" ||
    cleanup.managed_provider_cleanup !== false ||
    !timestamp(cleanup.recorded_at) ||
    !optionalToken(cleanup.provider_scope_type) ||
    !optionalToken(cleanup.provider_scope_id) ||
    !optionalToken(cleanup.external_audience_id) ||
    (cleanup.credential_ref_present !== undefined &&
      typeof cleanup.credential_ref_present !== "boolean") ||
    !safeToken(cleanup.audience_cleanup_status) ||
    !safeToken(cleanup.audience_membership_cleanup_status) ||
    !safeToken(cleanup.credential_cleanup_status)
  ) {
    throw new AudienceActivationContractError(
      "The disconnect receipt is malformed.",
    );
  }
  for (const key of [
    "postwave_effects",
    "provider_console_actions",
    "provider_cleanup_evidence",
  ] as const) {
    const entries = cleanup[key] ?? [];
    if (
      !Array.isArray(entries) ||
      entries.length > 20 ||
      !entries.every((entry) => safeToken(entry, 2_000))
    ) {
      throw new AudienceActivationContractError(
        "The disconnect receipt is malformed.",
      );
    }
  }
  return {
    ok: true,
    provider_cleanup: {
      ...(cleanup as AudienceDestinationDisconnectReceipt["provider_cleanup"]),
      postwave_effects: (cleanup.postwave_effects ?? []) as string[],
      provider_console_actions: (cleanup.provider_console_actions ?? []) as string[],
      provider_cleanup_evidence: (cleanup.provider_cleanup_evidence ?? []) as string[],
    },
  };
}

export async function testAudienceDestinationReadiness(input: {
  provider: AudienceDestinationProvider;
  config: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<AudienceDestinationReadiness> {
  if (!provider(input.provider)) {
    throw new AudienceActivationInputError("Choose a supported provider.");
  }
  const value = await api.post<unknown>(
    `/api/v1/audience-destinations/${encodeURIComponent(input.provider)}/readiness`,
    { config: checkedConfig(input.config) },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: null,
      maxAttempts: 1,
    },
  );
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["provider", "ready", "status", "detail"],
      ["missing", "docs"],
    ) ||
    value.provider !== input.provider ||
    typeof value.ready !== "boolean" ||
    !safeToken(value.status, 128) ||
    !safeToken(value.detail, 4_000)
  ) {
    throw new AudienceActivationContractError();
  }
  const missing = value.missing ?? [];
  const docs = value.docs ?? [];
  if (
    !Array.isArray(missing) ||
    !Array.isArray(docs) ||
    missing.length > 50 ||
    docs.length > 50 ||
    !missing.every((entry) => safeToken(entry, 256)) ||
    !docs.every((entry) => safeToken(entry, 2_048))
  ) {
    throw new AudienceActivationContractError();
  }
  return {
    provider: input.provider,
    ready: value.ready,
    status: value.status,
    detail: value.detail,
    missing,
    docs,
  };
}

export async function previewAudienceDestination(input: {
  tenantId: string;
  destinationId: string;
  signal?: AbortSignal;
}): Promise<AudienceDestinationPreview> {
  assertAudienceActivationId(input.tenantId, "Workspace");
  assertAudienceActivationId(input.destinationId, "Destination");
  const value = await api.get<unknown>(
    `/api/v1/audience-destinations/${encodeURIComponent(input.destinationId)}/preview`,
    { signal: input.signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, [
      "destination_id",
      "provider",
      "total_members",
      "excluded_count",
      "deliverable",
      "truncated",
      "firewall_active",
    ]) ||
    value.destination_id !== input.destinationId ||
    !provider(value.provider) ||
    !nonNegativeInt(value.total_members) ||
    !nonNegativeInt(value.excluded_count) ||
    !nonNegativeInt(value.deliverable) ||
    value.excluded_count + value.deliverable !== value.total_members ||
    typeof value.truncated !== "boolean" ||
    typeof value.firewall_active !== "boolean"
  ) {
    throw new AudienceActivationContractError();
  }
  return value as unknown as AudienceDestinationPreview;
}

export async function syncAudienceDestination(input: {
  authority: AudienceActivationAdminAuthority;
  current: Pick<
    AudienceDestination,
    "id" | "tenant_id" | "provider" | "updated_at"
  >;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AudienceDestinationSyncReceipt> {
  assertAudienceActivationAuthority(input.authority);
  assertAudienceActivationId(input.current.id, "Destination");
  assertAudienceActivationIdempotencyKey(input.idempotencyKey);
  if (
    input.current.tenant_id !== input.authority.tenantId ||
    !timestamp(input.current.updated_at)
  ) {
    throw new AudienceActivationInputError(
      "Refresh the destination before syncing it.",
    );
  }
  const current = await getAudienceDestinationVersioned({
    tenantId: input.authority.tenantId,
    destinationId: input.current.id,
    signal: input.signal,
  });
  if (
    current.row.updated_at !== input.current.updated_at ||
    current.row.provider !== input.current.provider
  ) {
    throw new AudienceActivationInputError(
      "This destination changed after it was loaded. Review the refreshed row before syncing it.",
    );
  }
  const value = await api.post<unknown>(
    `/api/v1/audience-destinations/${encodeURIComponent(input.current.id)}/sync`,
    {},
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: 1,
      timeoutMs: 65_000,
      headers: { "If-Match": current.etag },
    },
  );
  if (
    !record(value) ||
    !exactKeys(
      value,
      ["status", "destination", "job"],
      [
        "replayed",
        "provider",
        "external_job_id",
        "external_audience_id",
        "provider_message",
        "total_members",
        "excluded_count",
        "members_sent",
        "source_members_at_least",
        "cap_exceeded",
      ],
    ) ||
    !record(value.destination) ||
    !record(value.job) ||
    !runStatus(value.status) ||
    (value.replayed !== undefined && typeof value.replayed !== "boolean") ||
    (value.provider !== undefined && !provider(value.provider)) ||
    !optionalToken(value.external_job_id) ||
    !optionalToken(value.external_audience_id) ||
    !optionalToken(value.provider_message) ||
    (value.total_members !== undefined &&
      !nonNegativeInt(value.total_members)) ||
    (value.excluded_count !== undefined &&
      !nonNegativeInt(value.excluded_count)) ||
    (value.members_sent !== undefined && !nonNegativeInt(value.members_sent)) ||
    (value.source_members_at_least !== undefined &&
      !nonNegativeInt(value.source_members_at_least)) ||
    (value.cap_exceeded !== undefined &&
      typeof value.cap_exceeded !== "boolean")
  ) {
    throw new AudienceActivationContractError(
      "The service did not return a closed sync receipt.",
    );
  }
  const destination = decodeDestination(value.destination);
  const job = decodeJob(value.job);
  assertTenant(destination, input.authority.tenantId);
  if (
    destination.id !== input.current.id ||
    job.destination_id !== input.current.id ||
    job.tenant_id !== input.authority.tenantId ||
    job.status !== value.status
  ) {
    throw new AudienceActivationContractError(
      "The sync receipt did not match the requested destination.",
    );
  }
  return {
    status: value.status,
    replayed: value.replayed === true,
    destination,
    job,
    ...(provider(value.provider) ? { provider: value.provider } : {}),
    ...(safeToken(value.external_job_id)
      ? { external_job_id: value.external_job_id }
      : {}),
    ...(safeToken(value.external_audience_id)
      ? { external_audience_id: value.external_audience_id }
      : {}),
    ...(safeToken(value.provider_message)
      ? { provider_message: value.provider_message }
      : {}),
    ...(nonNegativeInt(value.total_members)
      ? { total_members: value.total_members }
      : {}),
    ...(nonNegativeInt(value.excluded_count)
      ? { excluded_count: value.excluded_count }
      : {}),
    ...(nonNegativeInt(value.members_sent)
      ? { members_sent: value.members_sent }
      : {}),
    ...(nonNegativeInt(value.source_members_at_least)
      ? { source_members_at_least: value.source_members_at_least }
      : {}),
    ...(typeof value.cap_exceeded === "boolean"
      ? { cap_exceeded: value.cap_exceeded }
      : {}),
  };
}

export async function listAudienceDestinationJobs(input: {
  tenantId: string;
  destinationId: string;
  signal?: AbortSignal;
}): Promise<AudienceDestinationJob[]> {
  assertAudienceActivationId(input.tenantId, "Workspace");
  assertAudienceActivationId(input.destinationId, "Destination");
  const jobs = decodeItems(
    await api.get<unknown>(
      `/api/v1/audience-destinations/${encodeURIComponent(input.destinationId)}/jobs`,
      { signal: input.signal },
    ),
    decodeJob,
  );
  if (
    jobs.some(
      (job) =>
        job.tenant_id !== input.tenantId ||
        job.destination_id !== input.destinationId,
    )
  ) {
    throw new AudienceActivationContractError(
      "The service mixed destination job histories.",
    );
  }
  return jobs;
}

export async function getAudienceDestinationJobDiagnostics(input: {
  tenantId: string;
  destinationId: string;
  jobId: string;
  signal?: AbortSignal;
}): Promise<AudienceDestinationDiagnostics> {
  assertAudienceActivationId(input.tenantId, "Workspace");
  assertAudienceActivationId(input.destinationId, "Destination");
  assertAudienceActivationId(input.jobId, "Job");
  const value = await api.get<unknown>(
    `/api/v1/audience-destinations/${encodeURIComponent(input.destinationId)}/jobs/${encodeURIComponent(input.jobId)}/diagnostics`,
    { signal: input.signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, ["destination", "job", "diagnostics"]) ||
    !record(value.diagnostics)
  ) {
    throw new AudienceActivationContractError();
  }
  const destination = decodeDestination(value.destination);
  const job = decodeJob(value.job);
  const diagnostics = value.diagnostics;
  if (
    !exactKeys(
      diagnostics,
      ["provider"],
      [
        "external_job_id",
        "external_audience_id",
        "provider_message",
        "provider_status",
        "provider_response",
      ],
    ) ||
    destination.tenant_id !== input.tenantId ||
    destination.id !== input.destinationId ||
    job.id !== input.jobId ||
    job.destination_id !== input.destinationId ||
    !provider(diagnostics.provider) ||
    diagnostics.provider !== destination.provider ||
    !optionalToken(diagnostics.external_job_id) ||
    !optionalToken(diagnostics.external_audience_id) ||
    !optionalToken(diagnostics.provider_message) ||
    !optionalToken(diagnostics.provider_status) ||
    (diagnostics.provider_response !== undefined &&
      !record(diagnostics.provider_response))
  ) {
    throw new AudienceActivationContractError();
  }
  if (
    diagnostics.provider_response !== undefined &&
    configBytes(diagnostics.provider_response) > CONFIG_MAX_BYTES
  ) {
    throw new AudienceActivationContractError();
  }
  if (diagnostics.provider_response !== undefined) {
    // Provider response bodies are not rendered by this surface. Validate them
    // for secret echoes, then deliberately drop them before React Query can
    // retain an opaque provider payload in memory.
    decodeConfig(diagnostics.provider_response);
  }
  return {
    destination,
    job,
    diagnostics: {
      provider: diagnostics.provider,
      ...(typeof diagnostics.external_job_id === "string"
        ? { external_job_id: diagnostics.external_job_id }
        : {}),
      ...(typeof diagnostics.external_audience_id === "string"
        ? { external_audience_id: diagnostics.external_audience_id }
        : {}),
      ...(typeof diagnostics.provider_message === "string"
        ? { provider_message: diagnostics.provider_message }
        : {}),
      ...(typeof diagnostics.provider_status === "string"
        ? { provider_status: diagnostics.provider_status }
        : {}),
    },
  };
}

/** Control groups are a separate read-only feature retained on this route. */
export async function listControlGroups(): Promise<unknown[]> {
  const response = await api.get<unknown>("/api/v1/control-groups");
  if (
    !record(response) ||
    !Array.isArray(response.items) ||
    response.items.length > LIST_MAX
  ) {
    throw new AudienceActivationContractError();
  }
  return response.items;
}

export function withoutDiagnostics(
  capabilities: Partial<
    Record<AudienceDestinationProvider, DestinationCapability>
  >,
): string[] {
  return Object.entries(capabilities)
    .filter((entry): entry is [string, DestinationCapability] =>
      Boolean(entry[1]),
    )
    .filter(([, capability]) => capability.configured && !capability.diagnostics)
    .map(([name]) => name);
}
