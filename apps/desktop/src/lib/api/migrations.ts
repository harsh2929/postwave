import type { ApiErr, ApiResult } from "./result";

/** Mirrors `canonical.SourcePlatform`. UI extra: "other". */
export type MigrationSource =
  | "mailchimp"
  | "klaviyo"
  | "customerio"
  | "constant-contact"
  | "aweber"
  | "drip"
  | "campaign-monitor"
  | "omnisend"
  | "loops"
  | "flodesk"
  | "bento"
  | "activecampaign"
  | "hubspot"
  | "convertkit"
  | "substack"
  | "beehiiv"
  | "brevo"
  | "mailerlite"
  | "csv"
  | "sendy"
  | "other";

/** Mirrors `canonical.AdapterCapabilities`. */
export interface MigrationSourceCapability {
  source: MigrationSource;
  /** "oauth2" | "api_key" | "csv_upload" */
  auth_method: string;
  /** Deployment-level truth; false means setup may not accept credentials/files. */
  intake_available?: boolean;
  intake_unavailable_code?: "durable_upload_storage_unavailable";
  /** Deployment-level truth for a real import after dry-run. */
  commit_available?: boolean;
  commit_unavailable_code?: "tenant_destination_not_isolated";
  supports?: {
    subscribers?: boolean;
    segments?: boolean;
    automations?: boolean;
    automation_mode?: "runtime" | "rebuild_review" | "none";
    campaign_archive?: boolean;
    paid_subs?: boolean;
    consent_timestamps?: boolean;
    templates?: boolean;
    campaigns?: boolean;
    reports?: boolean;
    groups?: boolean;
    forms?: boolean;
    landing_pages?: boolean;
    ecommerce?: boolean;
    crm?: boolean;
    custom_objects?: boolean;
    sms?: boolean;
  };
}

/**
 * Validate the capability collection before UI consumers call array methods.
 * The service returns a bare array; `{items}` remains accepted for legacy
 * gateways and deterministic renderer fixtures. Invalid rows fail closed.
 */
const MIGRATION_SOURCES = new Set<MigrationSource>([
  "mailchimp",
  "klaviyo",
  "customerio",
  "constant-contact",
  "aweber",
  "drip",
  "campaign-monitor",
  "omnisend",
  "loops",
  "flodesk",
  "bento",
  "activecampaign",
  "hubspot",
  "convertkit",
  "substack",
  "beehiiv",
  "brevo",
  "mailerlite",
  "csv",
  "sendy",
  "other",
]);

const MIGRATION_AUTH_METHODS = new Set(["oauth2", "api_key", "csv_upload"]);

const BOOLEAN_SUPPORT_FIELDS = [
  "subscribers",
  "segments",
  "automations",
  "campaign_archive",
  "paid_subs",
  "consent_timestamps",
  "templates",
  "campaigns",
  "reports",
  "groups",
  "forms",
  "landing_pages",
  "ecommerce",
  "crm",
  "custom_objects",
  "sms",
] as const;

/**
 * Parse the capability catalog without collapsing malformed data into a
 * verified empty collection. The returned error contains only fixed client
 * copy and a bounded diagnostic code; no reflected provider payload escapes.
 */
export function parseMigrationSourceCapabilities(
  value: unknown,
): ApiResult<MigrationSourceCapability[]> {
  const wrapped =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as { items?: unknown; sources?: unknown })
      : null;
  const hasItems = Array.isArray(wrapped?.items);
  const hasSources = Array.isArray(wrapped?.sources);
  if (hasItems && hasSources) {
    return migrationCapabilityParseError(
      "migration_sources_ambiguous_envelope",
    );
  }
  let candidates: unknown[] | null = null;
  if (Array.isArray(value)) candidates = value;
  else if (hasItems) candidates = wrapped!.items as unknown[];
  else if (hasSources) candidates = wrapped!.sources as unknown[];
  if (candidates === null || candidates.length > MIGRATION_SOURCES.size) {
    return migrationCapabilityParseError("migration_sources_invalid_envelope");
  }

  const parsed: MigrationSourceCapability[] = [];
  const seen = new Set<MigrationSource>();
  for (const candidate of candidates) {
    const capability = parseMigrationSourceCapability(candidate);
    if (!capability || seen.has(capability.source)) {
      return migrationCapabilityParseError("migration_sources_invalid_item");
    }
    seen.add(capability.source);
    parsed.push(capability);
  }
  return { data: parsed };
}

function parseMigrationSourceCapability(
  value: unknown,
): MigrationSourceCapability | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const source =
    typeof candidate.source === "string" ? candidate.source.trim() : "";
  const authMethod =
    typeof candidate.auth_method === "string"
      ? candidate.auth_method.trim()
      : "";
  if (
    !MIGRATION_SOURCES.has(source as MigrationSource) ||
    !MIGRATION_AUTH_METHODS.has(authMethod)
  ) {
    return null;
  }

  const rawSupports = candidate.supports;
  if (
    rawSupports !== undefined &&
    (!rawSupports ||
      typeof rawSupports !== "object" ||
      Array.isArray(rawSupports))
  ) {
    return null;
  }
  const supportsRecord = (rawSupports ?? {}) as Record<string, unknown>;
  const supports: NonNullable<MigrationSourceCapability["supports"]> = {};
  for (const field of BOOLEAN_SUPPORT_FIELDS) {
    const fieldValue = supportsRecord[field];
    if (fieldValue !== undefined && typeof fieldValue !== "boolean") {
      return null;
    }
    if (typeof fieldValue === "boolean") supports[field] = fieldValue;
  }
  const automationMode = supportsRecord.automation_mode;
  if (
    automationMode !== undefined &&
    automationMode !== "runtime" &&
    automationMode !== "rebuild_review" &&
    automationMode !== "none"
  ) {
    return null;
  }
  if (automationMode !== undefined) supports.automation_mode = automationMode;

  const intakeAvailable = candidate.intake_available;
  const intakeUnavailableCode = candidate.intake_unavailable_code;
  const commitAvailable = candidate.commit_available;
  const commitUnavailableCode = candidate.commit_unavailable_code;
  if (
    (intakeAvailable !== undefined && typeof intakeAvailable !== "boolean") ||
    (commitAvailable !== undefined && typeof commitAvailable !== "boolean") ||
    (intakeUnavailableCode !== undefined &&
      intakeUnavailableCode !== "durable_upload_storage_unavailable") ||
    (commitUnavailableCode !== undefined &&
      commitUnavailableCode !== "tenant_destination_not_isolated") ||
    (intakeAvailable === true && intakeUnavailableCode !== undefined) ||
    (intakeAvailable === false && intakeUnavailableCode === undefined) ||
    (commitAvailable === true && commitUnavailableCode !== undefined) ||
    (commitAvailable === false && commitUnavailableCode === undefined)
  ) {
    return null;
  }

  return {
    source: source as MigrationSource,
    auth_method: authMethod,
    ...(typeof intakeAvailable === "boolean"
      ? { intake_available: intakeAvailable }
      : {}),
    ...(intakeUnavailableCode === "durable_upload_storage_unavailable"
      ? { intake_unavailable_code: intakeUnavailableCode }
      : {}),
    ...(typeof commitAvailable === "boolean"
      ? { commit_available: commitAvailable }
      : {}),
    ...(commitUnavailableCode === "tenant_destination_not_isolated"
      ? { commit_unavailable_code: commitUnavailableCode }
      : {}),
    ...(Object.keys(supports).length > 0 ? { supports } : {}),
  };
}

function migrationCapabilityParseError(code: string): ApiErr {
  return {
    error: {
      message: "The migration source catalog could not be verified.",
      kind: "parse",
      code,
    },
    retryability: "manual",
  };
}

/** Response from `POST /api/v1/migrations/{source}/discover`. */
export interface MigrationDiscoveryReport {
  job_id: string;
  source: MigrationSource;
  subscribers_count: number;
  /**
   * HubSpot reports one combined inventory of list snapshots and active email
   * subscription-definition targeting boundaries, not a lists-only count.
   */
  segments_count: number;
  automations_count: number;
  archive_count: number;
  paid_subs_count: number;
  templates_count?: number;
  campaigns_count?: number;
  reports_count?: number;
  groups_count?: number;
  forms_count?: number;
  landing_pages_count?: number;
  ecommerce_count?: number;
  crm_count?: number;
  deals_count?: number;
  pipelines_count?: number;
  custom_objects_count?: number;
  /** Exact Customer.io subscription-center channel-definition count. */
  subscription_channels_count?: number;
  /**
   * Source profiles excluded because they have no usable current primary
   * email; provider notes define the exact stable-API boundary.
   */
  profiles_without_email_count?: number;
  /**
   * Exact HubSpot additional-email values retained as non-sendable
   * identity/reconciliation evidence, never independent subscribers.
   */
  additional_email_identities_count?: number;
  /** Non-runtime Klaviyo archive/rebuild evidence records discovered. */
  source_archive_count?: number;
  sms_campaigns_count?: number;
  push_campaigns_count?: number;
  custom_fields?: string[];
  warnings?: string[];
  audiences?: Array<{
    id: string;
    name?: string;
    subscribers_total: number;
  }>;
}

export interface MigrationDryRunAcknowledgement {
  job_id: string;
}

/**
 * Finite renderer-owned bounds for migration discovery wire data. These are
 * deliberately below the transport response-size ceiling so a structurally
 * valid response cannot turn into an unbounded React collection.
 */
export const MIGRATION_DISCOVERY_WIRE_LIMITS = {
  count: 1_000_000_000,
  audiences: 1_000,
  customFields: 1_000,
  warnings: 1_000,
  jobIdLength: 512,
  audienceIdLength: 512,
  audienceNameLength: 512,
  customFieldLength: 512,
  warningLength: 4_096,
} as const;

const REQUIRED_DISCOVERY_COUNT_FIELDS = [
  "subscribers_count",
  "segments_count",
  "automations_count",
  "archive_count",
  "paid_subs_count",
] as const;

const OPTIONAL_DISCOVERY_COUNT_FIELDS = [
  "templates_count",
  "campaigns_count",
  "reports_count",
  "groups_count",
  "forms_count",
  "landing_pages_count",
  "ecommerce_count",
  "crm_count",
  "deals_count",
  "pipelines_count",
  "custom_objects_count",
  "subscription_channels_count",
  "profiles_without_email_count",
  "additional_email_identities_count",
  "source_archive_count",
  "sms_campaigns_count",
  "push_campaigns_count",
] as const;

type OptionalDiscoveryCountField =
  (typeof OPTIONAL_DISCOVERY_COUNT_FIELDS)[number];

interface MigrationDiscoveryIdentity {
  source: MigrationSource;
  jobId: string;
}

/**
 * Decode discovery as untrusted wire data and return a renderer-safe copy.
 * Identity must match the initiating route and job exactly; absent identity
 * intentionally fails closed during the coordinated service/client rollout.
 */
export function parseMigrationDiscoveryReport(
  value: unknown,
  expected: MigrationDiscoveryIdentity,
): ApiResult<MigrationDiscoveryReport> {
  if (!isWireRecord(value) || Object.keys(value).length > 64) {
    return migrationDiscoveryParseError("migration_discovery_invalid_response");
  }
  if (
    !isBoundedIdentity(value.job_id) ||
    value.job_id !== expected.jobId ||
    value.source !== expected.source
  ) {
    return migrationDiscoveryParseError(
      "migration_discovery_identity_mismatch",
    );
  }

  for (const field of REQUIRED_DISCOVERY_COUNT_FIELDS) {
    if (!isBoundedDiscoveryCount(value[field])) {
      return migrationDiscoveryParseError(
        "migration_discovery_invalid_response",
      );
    }
  }
  for (const field of OPTIONAL_DISCOVERY_COUNT_FIELDS) {
    if (value[field] !== undefined && !isBoundedDiscoveryCount(value[field])) {
      return migrationDiscoveryParseError(
        "migration_discovery_invalid_response",
      );
    }
  }

  const customFields = parseBoundedStringArray(
    value.custom_fields,
    MIGRATION_DISCOVERY_WIRE_LIMITS.customFields,
    MIGRATION_DISCOVERY_WIRE_LIMITS.customFieldLength,
  );
  const warnings = parseBoundedStringArray(
    value.warnings,
    MIGRATION_DISCOVERY_WIRE_LIMITS.warnings,
    MIGRATION_DISCOVERY_WIRE_LIMITS.warningLength,
  );
  const audiences = parseDiscoveryAudiences(value.audiences);
  if (customFields === null || warnings === null || audiences === null) {
    return migrationDiscoveryParseError("migration_discovery_invalid_response");
  }

  const report: MigrationDiscoveryReport = {
    job_id: value.job_id,
    source: expected.source,
    subscribers_count: value.subscribers_count as number,
    segments_count: value.segments_count as number,
    automations_count: value.automations_count as number,
    archive_count: value.archive_count as number,
    paid_subs_count: value.paid_subs_count as number,
    ...(customFields === undefined ? {} : { custom_fields: customFields }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(audiences === undefined ? {} : { audiences }),
  };
  const mutableReport = report as MigrationDiscoveryReport &
    Record<OptionalDiscoveryCountField, number | undefined>;
  for (const field of OPTIONAL_DISCOVERY_COUNT_FIELDS) {
    if (value[field] !== undefined) {
      mutableReport[field] = value[field] as number;
    }
  }
  return { data: report };
}

/** Decode and identity-bind the 202 response before runtime code reads it. */
export function parseMigrationDryRunAcknowledgement(
  value: unknown,
  expectedJobId: string,
): ApiResult<MigrationDryRunAcknowledgement> {
  if (
    !isWireRecord(value) ||
    Object.keys(value).length !== 1 ||
    !isBoundedIdentity(value.job_id) ||
    value.job_id !== expectedJobId
  ) {
    return migrationDryRunParseError();
  }
  return { data: { job_id: value.job_id } };
}

function parseDiscoveryAudiences(
  value: unknown,
): MigrationDiscoveryReport["audiences"] | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MIGRATION_DISCOVERY_WIRE_LIMITS.audiences
  ) {
    return null;
  }
  const parsed: NonNullable<MigrationDiscoveryReport["audiences"]> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isWireRecord(item) ||
      Object.keys(item).length > 8 ||
      !isBoundedIdentifier(
        item.id,
        MIGRATION_DISCOVERY_WIRE_LIMITS.audienceIdLength,
      ) ||
      seen.has(item.id) ||
      (item.name !== undefined &&
        !isBoundedWireString(
          item.name,
          MIGRATION_DISCOVERY_WIRE_LIMITS.audienceNameLength,
        )) ||
      !isBoundedDiscoveryCount(item.subscribers_total)
    ) {
      return null;
    }
    seen.add(item.id);
    parsed.push({
      id: item.id,
      ...(item.name === undefined ? {} : { name: item.name }),
      subscribers_total: item.subscribers_total,
    });
  }
  return parsed;
}

function parseBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const parsed: string[] = [];
  for (const item of value) {
    if (!isBoundedWireString(item, maxLength)) return null;
    parsed.push(item);
  }
  return parsed;
}

function isWireRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedWireString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isBoundedIdentity(value: unknown): value is string {
  return isBoundedIdentifier(
    value,
    MIGRATION_DISCOVERY_WIRE_LIMITS.jobIdLength,
  );
}

function isBoundedIdentifier(
  value: unknown,
  maxLength: number,
): value is string {
  if (!isBoundedWireString(value, maxLength) || value.trim() !== value) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      return false;
    }
  }
  return true;
}

function isBoundedDiscoveryCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MIGRATION_DISCOVERY_WIRE_LIMITS.count
  );
}

function migrationDiscoveryParseError(code: string): ApiErr {
  return {
    error: {
      kind: "parse",
      code,
      message: "The migration discovery response could not be verified.",
    },
    retryability: "manual",
  };
}

function migrationDryRunParseError(): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "migration_preview_invalid_ack",
      message: "The migration dry-run response could not be verified.",
    },
    retryability: "manual",
  };
}

export interface MigrationUploadServerStatus {
  upload_id: string;
  received: number;
  total: number;
  updated_at: string;
}

type MigrationRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<ApiResult<T>>;

interface ReconcileMigrationUploadInput {
  source: MigrationSource;
  uploadId: string;
  fileSize: number;
  hasLocalLedger: boolean;
  request: MigrationRequest;
  newUploadId: () => string;
}

interface ReconciledMigrationUpload {
  uploadId: string;
  offset: number;
}

function parseError(code: string, message: string): ApiErr {
  return { error: { kind: "parse", code, message } };
}

/**
 * Reconcile a local resumable-upload hint with server-owned byte state.
 * A missing remote upload restarts safely; malformed offsets fail closed.
 */
export async function reconcileMigrationUpload({
  source,
  uploadId,
  fileSize,
  hasLocalLedger,
  request,
  newUploadId,
}: ReconcileMigrationUploadInput): Promise<
  ApiResult<ReconciledMigrationUpload>
> {
  if (!hasLocalLedger) return { data: { uploadId, offset: 0 } };
  const remote = await request<MigrationUploadServerStatus>(
    `/api/v1/migrations/${encodeURIComponent(
      source,
    )}/uploads/${encodeURIComponent(uploadId)}`,
    { method: "GET" },
  );
  if (remote.error) {
    return remote.error.status === 404
      ? { data: { uploadId, offset: 0 } }
      : { error: remote.error };
  }
  if (
    !Number.isSafeInteger(remote.data.received) ||
    !Number.isSafeInteger(remote.data.total) ||
    remote.data.received < 0 ||
    remote.data.total <= 0 ||
    remote.data.received > remote.data.total
  ) {
    return parseError(
      "invalid_upload_status",
      "Migration upload status contained invalid byte offsets.",
    );
  }
  return remote.data.total === fileSize
    ? { data: { uploadId, offset: remote.data.received } }
    : { data: { uploadId: newUploadId(), offset: 0 } };
}

/** Reject impossible server acknowledgements before advancing the ledger. */
export function migrationUploadAckError(
  received: number | undefined,
  fileSize: number,
): ApiErr | null {
  if (
    received === undefined ||
    (Number.isSafeInteger(received) && received >= 0 && received <= fileSize)
  ) {
    return null;
  }
  return parseError(
    "invalid_upload_ack",
    `Migration upload acknowledgement contained an invalid byte offset: ${received}.`,
  );
}
