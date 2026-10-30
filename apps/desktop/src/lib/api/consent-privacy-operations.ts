import type { ApiErr, ApiResult } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";
import { DEMO_DATA_FALLBACK_ENABLED } from "../config";

export interface ConsentPrivacyRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  requireOnline?: boolean;
  signal?: AbortSignal;
}

export type ConsentPrivacyRequester = <T>(
  path: string,
  init?: RequestInit,
  opts?: ConsentPrivacyRequestOptions,
) => Promise<ApiResult<T>>;

export interface ConsentPrivacyDownloadController {
  signal: AbortSignal;
  dispose: () => void;
}

export interface ConsentPrivacyOperationsDependencies {
  request: ConsentPrivacyRequester;
  createDownloadController: (
    callerSignal?: AbortSignal | null,
  ) => ConsentPrivacyDownloadController;
  normalizeApiKey: (key: string | null | undefined) => string | null;
  getApiKey: () => string | null;
  nativeAwareFetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  apiUrl: (path: string) => string;
  errorFromResponse: (response: Response) => Promise<ApiErr["error"]>;
  transportError: (error: unknown) => ApiErr["error"];
}

/**
 * Canonical incident states — mirrors `validIncidentStates` in
 * apps/api/internal/privacy/incidents.go. The client-side state matrix
 * (see PrivacyIncidents.tsx) is the same data; surfacing it as a typed
 * union here means the api-client can't silently fall behind.
 */
export type PrivacyIncidentState =
  | "open"
  | "contained"
  | "notifications_pending"
  | "closed";

export type PrivacyIncidentSeverity =
  | "investigating"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type PrivacyIncidentAudience = "authority" | "customer" | "data_subject";

/** Safe jurisdiction metadata for data capture; it makes no legal claim. */
export interface PrivacyJurisdictionReference {
  code: string;
  name: string;
}

/** Explicit release hold returned instead of an obligation determination. */
export interface PrivacyJurisdictionResolution {
  status: "release_held";
  release_hold_code: "jurisdiction_rules_release_hold";
  recognized: PrivacyJurisdictionReference[];
  unknown_jurisdictions?: string[];
}

/** Mirrors privacy.incidentRow (the wire shape). */
export interface PrivacyIncident {
  id: string;
  severity: PrivacyIncidentSeverity;
  status: PrivacyIncidentState;
  detected_at: string;
  discovered_at?: string;
  clock_started_at?: string;
  gdpr_72h_deadline?: string;
  counsel_signoff_at?: string;
  signoff_by?: string;
  template_version: string;
  affected_regions: string[];
  affected_data_categories: string[];
  affected_subject_count?: number;
  notification_decisions: Record<string, unknown>;
  jurisdictions: string[];
  summary: string;
  created_at: string;
  updated_at: string;
  /** Present on create/detail responses and deliberately absent on list rows. */
  jurisdiction_resolution?: PrivacyJurisdictionResolution;
}

export interface PrivacyIncidentListResponse {
  incidents: PrivacyIncident[];
  known_jurisdictions: PrivacyJurisdictionReference[];
  nextCursor?: string;
}

export interface PrivacyIncidentCreateInput {
  severity?: PrivacyIncidentSeverity;
  summary: string;
  detected_at?: string;
  discovered_at?: string | null;
  affected_regions?: string[];
  affected_data_categories?: string[];
  affected_subject_count?: number | null;
  jurisdictions?: string[];
}

export interface PrivacyIncidentTransitionResponse {
  incident_id: string;
  from: PrivacyIncidentState;
  to: PrivacyIncidentState;
  at: string;
}

export interface PrivacyIncidentNotificationInput {
  audience: PrivacyIncidentAudience;
  template_key?: string;
  recipient_ref?: string;
  body_sha256?: string;
}

/** One row in the merged transition+notification ledger. */
export interface PrivacyIncidentEvent {
  event_id: string;
  source: "incident_state_transitions" | "incident_notifications";
  schema_version: 1;
  kind: "transition" | "notification";
  at: string;
  from_state?: PrivacyIncidentState;
  to_state?: PrivacyIncidentState;
  actor?: string;
  reason?: string;
  audience?: PrivacyIncidentAudience;
  template_key?: string;
  body_sha256?: string;
  recipient_ref?: string;
}

export interface PrivacyIncidentEventsResponse {
  incident_id: string;
  events: PrivacyIncidentEvent[];
}

const PRIVACY_INCIDENT_STATES = new Set<PrivacyIncidentState>([
  "open",
  "contained",
  "notifications_pending",
  "closed",
]);
const PRIVACY_INCIDENT_SEVERITIES = new Set<PrivacyIncidentSeverity>([
  "investigating",
  "low",
  "medium",
  "high",
  "critical",
]);
const PRIVACY_INCIDENT_AUDIENCES = new Set<PrivacyIncidentAudience>([
  "authority",
  "customer",
  "data_subject",
]);
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const OPAQUE_CURSOR = /^[A-Za-z0-9+/_=-]+$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/iu;
const CONTROL_CHARACTER = /\p{Cc}/u;
const NUL_CHARACTER = /\u0000/u;
// Exact server deny-list. Do not broaden this to every Unicode Cf character:
// U+200D ZERO WIDTH JOINER is valid in emoji sequences and is not bidi text.
const BIDI_FORMATTING_CONTROL =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/u;
const PRIVACY_INCIDENT_LIST_MAX_ITEMS = 200;
const PRIVACY_INCIDENT_SCOPE_MAX_ITEMS = 64;
const PRIVACY_INCIDENT_SCOPE_TOKEN_MAX_RUNES = 256;
const PRIVACY_INCIDENT_SUMMARY_MAX_RUNES = 4_000;
const PRIVACY_INCIDENT_EVENT_MAX_ITEMS = 10_000;
const PRIVACY_INCIDENT_EVENT_ACTOR_MAX_RUNES = 320;
const PRIVACY_INCIDENT_EVENT_REASON_MAX_RUNES = 2_000;
const PRIVACY_INCIDENT_EVENT_TEMPLATE_MAX_RUNES = 256;
const PRIVACY_INCIDENT_EVENT_RECIPIENT_MAX_RUNES = 2_048;
const PRIVACY_INCIDENT_DECISIONS_MAX_BYTES = 65_536;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function runeLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedNonEmptyString(
  value: unknown,
  maxRunes: number,
): value is string {
  return (
    isNonEmptyString(value) &&
    runeLength(value) <= maxRunes &&
    !NUL_CHARACTER.test(value) &&
    !BIDI_FORMATTING_CONTROL.test(value)
  );
}

function isBoundedToken(value: unknown, maxRunes: number): value is string {
  return (
    isBoundedNonEmptyString(value, maxRunes) && !CONTROL_CHARACTER.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isTimestamp(value);
}

function isIncidentScopeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= PRIVACY_INCIDENT_SCOPE_MAX_ITEMS &&
    value.every((entry) =>
      isBoundedToken(entry, PRIVACY_INCIDENT_SCOPE_TOKEN_MAX_RUNES),
    ) &&
    new Set(value).size === value.length
  );
}

function isSortedStringArray(value: unknown): value is string[] {
  return (
    isIncidentScopeArray(value) &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}

function isBoundedRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      PRIVACY_INCIDENT_DECISIONS_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function isIncidentState(value: unknown): value is PrivacyIncidentState {
  return (
    typeof value === "string" &&
    PRIVACY_INCIDENT_STATES.has(value as PrivacyIncidentState)
  );
}

function isIncidentSeverity(value: unknown): value is PrivacyIncidentSeverity {
  return (
    typeof value === "string" &&
    PRIVACY_INCIDENT_SEVERITIES.has(value as PrivacyIncidentSeverity)
  );
}

function isIncidentAudience(value: unknown): value is PrivacyIncidentAudience {
  return (
    typeof value === "string" &&
    PRIVACY_INCIDENT_AUDIENCES.has(value as PrivacyIncidentAudience)
  );
}

const PRIVACY_JURISDICTION_REFERENCE_KEYS = new Set(["code", "name"]);

function isJurisdictionReference(
  value: unknown,
): value is PrivacyJurisdictionReference {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, PRIVACY_JURISDICTION_REFERENCE_KEYS) &&
    isBoundedToken(value.code, PRIVACY_INCIDENT_SCOPE_TOKEN_MAX_RUNES) &&
    isBoundedToken(value.name, PRIVACY_INCIDENT_SCOPE_TOKEN_MAX_RUNES)
  );
}

function isJurisdictionReferenceArray(
  value: unknown,
): value is PrivacyJurisdictionReference[] {
  if (
    !Array.isArray(value) ||
    value.length > PRIVACY_INCIDENT_SCOPE_MAX_ITEMS ||
    !value.every((entry) => isJurisdictionReference(entry)) ||
    new Set(value.map((entry) => entry.code)).size !== value.length
  ) {
    return false;
  }
  return value.every(
    (entry, index) => index === 0 || value[index - 1]!.code < entry.code,
  );
}

const PRIVACY_JURISDICTION_RESOLUTION_KEYS = new Set([
  "status",
  "release_hold_code",
  "recognized",
  "unknown_jurisdictions",
]);

function isJurisdictionResolution(
  value: unknown,
): value is PrivacyJurisdictionResolution {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, PRIVACY_JURISDICTION_RESOLUTION_KEYS) &&
    value.status === "release_held" &&
    value.release_hold_code === "jurisdiction_rules_release_hold" &&
    isJurisdictionReferenceArray(value.recognized) &&
    (value.unknown_jurisdictions === undefined ||
      isSortedStringArray(value.unknown_jurisdictions))
  );
}

function jurisdictionResolutionMatchesIncident(
  jurisdictions: readonly string[],
  resolution: PrivacyJurisdictionResolution,
): boolean {
  const normalized = jurisdictions.map((value) => value.trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) return false;
  normalized.sort();

  const recognized = resolution.recognized.map((entry) => entry.code);
  const unknown = resolution.unknown_jurisdictions ?? [];
  const recognizedSet = new Set(recognized);
  if (unknown.some((code) => recognizedSet.has(code))) return false;
  const resolved = [...recognized, ...unknown].sort();
  return (
    resolved.length === normalized.length &&
    resolved.every((code, index) => code === normalized[index])
  );
}

const PRIVACY_INCIDENT_KEYS = new Set([
  "id",
  "severity",
  "status",
  "detected_at",
  "discovered_at",
  "clock_started_at",
  "gdpr_72h_deadline",
  "counsel_signoff_at",
  "signoff_by",
  "template_version",
  "affected_regions",
  "affected_data_categories",
  "affected_subject_count",
  "notification_decisions",
  "jurisdictions",
  "summary",
  "created_at",
  "updated_at",
  "jurisdiction_resolution",
]);

function isPrivacyIncident(
  value: unknown,
  resolutionMode: "required" | "absent",
): value is PrivacyIncident {
  if (!isRecord(value) || !hasOnlyKeys(value, PRIVACY_INCIDENT_KEYS)) {
    return false;
  }
  const baseValid =
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    isIncidentSeverity(value.severity) &&
    isIncidentState(value.status) &&
    isTimestamp(value.detected_at) &&
    isOptionalTimestamp(value.discovered_at) &&
    isOptionalTimestamp(value.clock_started_at) &&
    isOptionalTimestamp(value.gdpr_72h_deadline) &&
    isOptionalTimestamp(value.counsel_signoff_at) &&
    (value.signoff_by === undefined ||
      isBoundedToken(
        value.signoff_by,
        PRIVACY_INCIDENT_EVENT_ACTOR_MAX_RUNES,
      )) &&
    isBoundedToken(value.template_version, 64) &&
    isIncidentScopeArray(value.affected_regions) &&
    isIncidentScopeArray(value.affected_data_categories) &&
    (value.affected_subject_count === undefined ||
      (Number.isSafeInteger(value.affected_subject_count) &&
        (value.affected_subject_count as number) >= 0 &&
        (value.affected_subject_count as number) <= 2_147_483_647)) &&
    isBoundedRecord(value.notification_decisions) &&
    isIncidentScopeArray(value.jurisdictions) &&
    isBoundedNonEmptyString(
      value.summary,
      PRIVACY_INCIDENT_SUMMARY_MAX_RUNES,
    ) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at);
  if (!baseValid) return false;
  if (resolutionMode === "absent") {
    return value.jurisdiction_resolution === undefined;
  }
  return (
    isJurisdictionResolution(value.jurisdiction_resolution) &&
    jurisdictionResolutionMatchesIncident(
      value.jurisdictions as string[],
      value.jurisdiction_resolution,
    )
  );
}

const PRIVACY_TRANSITION_EVENT_KEYS = new Set([
  "event_id",
  "source",
  "schema_version",
  "kind",
  "at",
  "from_state",
  "to_state",
  "actor",
  "reason",
]);
const PRIVACY_NOTIFICATION_EVENT_KEYS = new Set([
  "event_id",
  "source",
  "schema_version",
  "kind",
  "at",
  "audience",
  "actor",
  "template_key",
  "body_sha256",
  "recipient_ref",
]);

function isPrivacyIncidentEvent(value: unknown): value is PrivacyIncidentEvent {
  if (
    !isRecord(value) ||
    typeof value.event_id !== "string" ||
    !UUID.test(value.event_id) ||
    value.schema_version !== 1 ||
    !isTimestamp(value.at)
  ) {
    return false;
  }
  if (
    (value.actor !== undefined &&
      !isBoundedToken(value.actor, PRIVACY_INCIDENT_EVENT_ACTOR_MAX_RUNES)) ||
    (value.reason !== undefined &&
      !isBoundedNonEmptyString(
        value.reason,
        PRIVACY_INCIDENT_EVENT_REASON_MAX_RUNES,
      )) ||
    (value.template_key !== undefined &&
      !isBoundedToken(
        value.template_key,
        PRIVACY_INCIDENT_EVENT_TEMPLATE_MAX_RUNES,
      )) ||
    (value.body_sha256 !== undefined &&
      (typeof value.body_sha256 !== "string" ||
        !SHA256_HEX.test(value.body_sha256))) ||
    (value.recipient_ref !== undefined &&
      !isBoundedToken(
        value.recipient_ref,
        PRIVACY_INCIDENT_EVENT_RECIPIENT_MAX_RUNES,
      ))
  ) {
    return false;
  }
  if (value.kind === "transition") {
    return (
      hasOnlyKeys(value, PRIVACY_TRANSITION_EVENT_KEYS) &&
      value.source === "incident_state_transitions" &&
      (value.from_state === undefined || isIncidentState(value.from_state)) &&
      isIncidentState(value.to_state)
    );
  }
  if (value.kind === "notification") {
    return (
      hasOnlyKeys(value, PRIVACY_NOTIFICATION_EVENT_KEYS) &&
      value.source === "incident_notifications" &&
      isIncidentAudience(value.audience) &&
      value.from_state === undefined &&
      value.to_state === undefined
    );
  }
  return false;
}

function privacyIncidentContractFailure(): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_privacy_incident_response_contract",
      message:
        "The privacy incident service returned an invalid response. The previous verified incident data was kept; retry the request.",
    },
    retryability: "manual",
  };
}

function privacyIncidentIdentityMismatch(): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "privacy_incident_response_identity_mismatch",
      message:
        "The privacy incident service returned data for a different incident. The previous verified incident data was kept; retry the request.",
    },
    retryability: "manual",
  };
}

function privacyIncidentIdempotencyKeyFailure(): ApiErr {
  return {
    error: {
      code: "invalid_privacy_incident_idempotency_key",
      message:
        "The incident retry key must be one trimmed, non-empty value of at most 255 UTF-8 bytes without control characters.",
    },
    retryability: "not-retryable",
  };
}

function isValidPrivacyIncidentIdempotencyKey(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= 255 &&
    !CONTROL_CHARACTER.test(value)
  );
}

function validateIncidentResult(
  response: ApiResult<PrivacyIncident>,
  expectedId?: string,
): ApiResult<PrivacyIncident> {
  if (response.error) return response;
  if (!isPrivacyIncident(response.data, "required"))
    return privacyIncidentContractFailure();
  if (
    expectedId !== undefined &&
    !responseIdentityMatches(expectedId, response.data.id)
  ) {
    return privacyIncidentIdentityMismatch();
  }
  return response;
}

/* ---------- consent types ------------------------------------------ */

/**
 * One row in the consent receipt log. Mirrors the Go `Receipt` shape
 * returned by `apps/api/internal/consent/consent.go`.
 */
export interface ConsentReceipt {
  /** Text id — the ledger UNIONs consent_receipts (bigint) with
   *  consent_records (uuid), so ids are strings now (D05#6). */
  id: string;
  subscriber_email: string;
  prev_state?: string;
  new_state: string;
  source: string;
  source_detail?: string;
  ip?: string;
  user_agent?: string;
  privacy_policy_version?: string;
  captured_text?: string;
  at: string;
  /** Server-recorded chronology used for stable snapshot pagination. */
  recorded_at: string;
  /** "receipt" = state-change stream, "proof" = structured consent_records
   *  proof (form/import/API capture). Present since D05#6. */
  kind: "receipt" | "proof";
}

export interface ConsentReceiptsResponse {
  schema_version: 1;
  workspace_id: string;
  snapshot_at: string;
  source_planes: ["consent_receipts", "consent_records"];
  receipts: ConsentReceipt[];
  email?: string;
  /** Number of rows in this page, never a workspace-wide total. */
  count: number;
  has_more: boolean;
  next_cursor?: string;
}

/**
 * Broader consent_events ledger entry — visitor / user / subscriber /
 * workspace subject. The read decoder treats this as forensic evidence:
 * unknown keys, enum drift, malformed timestamps, and unsafe text fail closed.
 */
export interface ConsentEvent {
  id: string;
  decision_id?: string;
  subject_type: "visitor" | "user" | "subscriber" | "workspace";
  subject_id?: string;
  subject_email?: string;
  channel: "web" | "mobile" | "desktop" | "email" | "import" | "api";
  category:
    | "essential"
    | "analytics"
    | "marketing"
    | "email_marketing"
    | "email_tracking"
    | "sale_share"
    | "targeted_advertising"
    | "ai_processing"
    | "sensitive_data";
  action: "granted" | "denied" | "revoked" | "opted_out" | "imported";
  source: string;
  policy_version: string;
  ip?: string;
  user_agent?: string;
  preferences?: Record<string, unknown>;
  proof_text?: string;
  /** Reviewed occurrence time. */
  created_at: string;
  /** Server-recorded chronology used for stable snapshot pagination. */
  recorded_at: string;
}

export interface ConsentEventsResponse {
  schema_version: 1;
  workspace_id: string;
  snapshot_at: string;
  source_planes: ["consent_events"];
  events: ConsentEvent[];
  /** Number of rows in this page, never a workspace-wide total. */
  count: number;
  has_more: boolean;
  next_cursor?: string;
}

export interface ConsentReceiptListOptions {
  workspaceId: string;
  since?: string;
  limit?: number;
  source?: string;
  cursor?: string;
}

export interface ConsentEventListOptions {
  workspaceId: string;
  limit?: number;
  subjectType?: ConsentEvent["subject_type"];
  category?: ConsentEvent["category"];
  action?: ConsentEvent["action"];
  since?: string;
  cursor?: string;
}

const CONSENT_RECEIPT_KEYS = new Set([
  "id",
  "subscriber_email",
  "prev_state",
  "new_state",
  "source",
  "source_detail",
  "ip",
  "user_agent",
  "privacy_policy_version",
  "captured_text",
  "at",
  "recorded_at",
  "kind",
]);
const CONSENT_EVENT_KEYS = new Set([
  "id",
  "decision_id",
  "subject_type",
  "subject_id",
  "subject_email",
  "channel",
  "category",
  "action",
  "source",
  "policy_version",
  "preferences",
  "proof_text",
  "ip",
  "user_agent",
  "created_at",
  "recorded_at",
]);
const CONSENT_RECEIPT_RESPONSE_KEYS = new Set([
  "schema_version",
  "workspace_id",
  "snapshot_at",
  "source_planes",
  "receipts",
  "count",
  "has_more",
  "next_cursor",
]);
const CONSENT_RECEIPT_BY_EMAIL_RESPONSE_KEYS = new Set([
  ...CONSENT_RECEIPT_RESPONSE_KEYS,
  "email",
]);
const CONSENT_EVENT_RESPONSE_KEYS = new Set([
  "schema_version",
  "workspace_id",
  "snapshot_at",
  "source_planes",
  "events",
  "count",
  "has_more",
  "next_cursor",
]);
const CONSENT_RECEIPT_STATES = new Set([
  "subscribed",
  "unsubscribed",
  "bounced",
  "complained",
  "pending",
]);
const CONSENT_PROOF_STATES = new Set([
  "granted",
  "withdrawn",
  "pending",
  "expired",
]);
const CONSENT_SUBJECT_TYPES = new Set<ConsentEvent["subject_type"]>([
  "visitor",
  "user",
  "subscriber",
  "workspace",
]);
const CONSENT_CHANNELS = new Set<ConsentEvent["channel"]>([
  "web",
  "mobile",
  "desktop",
  "email",
  "import",
  "api",
]);
const CONSENT_CATEGORIES = new Set<ConsentEvent["category"]>([
  "essential",
  "analytics",
  "marketing",
  "email_marketing",
  "email_tracking",
  "sale_share",
  "targeted_advertising",
  "ai_processing",
  "sensitive_data",
]);
const CONSENT_ACTIONS = new Set<ConsentEvent["action"]>([
  "granted",
  "denied",
  "revoked",
  "opted_out",
  "imported",
]);
const POSITIVE_DECIMAL = /^[1-9]\d*$/u;
// Consent evidence cursors are a canonical base64url payload plus a
// base64url HMAC-SHA256 signature. Accept exactly that two-part wire shape;
// clients still treat both parts as opaque and never decode or log them.
const CONSENT_OPAQUE_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const CONSENT_MAX_PAGE_ROWS = 1_000;
const CONSENT_MAX_CURSOR_LENGTH = 8_192;
const CONSENT_BYTE_ORDER_MARK = /\uFEFF/u;

function isConsentBoundedNarrative(
  value: unknown,
  maxBytesAndRunes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    new TextEncoder().encode(value).byteLength <= maxBytesAndRunes &&
    runeLength(value) <= maxBytesAndRunes &&
    !NUL_CHARACTER.test(value) &&
    !BIDI_FORMATTING_CONTROL.test(value) &&
    !CONSENT_BYTE_ORDER_MARK.test(value)
  );
}

function isConsentBoundedToken(
  value: unknown,
  maxBytesAndRunes: number,
): value is string {
  return (
    isConsentBoundedNarrative(value, maxBytesAndRunes) &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isOptionalConsentToken(
  value: unknown,
  maxRunes: number,
): value is string | undefined {
  return value === undefined || isConsentBoundedToken(value, maxRunes);
}

function isOptionalConsentNarrative(
  value: unknown,
  maxRunes: number,
): value is string | undefined {
  return value === undefined || isConsentBoundedNarrative(value, maxRunes);
}

function isConsentEmail(value: unknown): value is string {
  if (!isConsentBoundedToken(value, 320)) return false;
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function isOptionalConsentEmail(value: unknown): value is string | undefined {
  return value === undefined || isConsentEmail(value);
}

function isConsentCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CONSENT_MAX_CURSOR_LENGTH &&
    CONSENT_OPAQUE_CURSOR.test(value)
  );
}

function isPageCursorContract(
  hasMore: unknown,
  nextCursor: unknown,
): hasMore is boolean {
  return (
    typeof hasMore === "boolean" &&
    (hasMore ? isConsentCursor(nextCursor) : nextCursor === undefined)
  );
}

function timestampFractionRemainder(value: string): number {
  const match = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return 0;
  const nanos = match[1]!.padEnd(9, "0");
  return Number(nanos.slice(3));
}

function compareConsentTimestamp(a: string, b: string): number {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis !== 0) return millis;
  return timestampFractionRemainder(a) - timestampFractionRemainder(b);
}

function isConsentReceipt(value: unknown): value is ConsentReceipt {
  if (!isRecord(value) || !hasOnlyKeys(value, CONSENT_RECEIPT_KEYS)) {
    return false;
  }
  if (value.kind !== "receipt" && value.kind !== "proof") return false;
  const idIsValid =
    value.kind === "receipt"
      ? typeof value.id === "string" &&
        value.id.length <= 20 &&
        POSITIVE_DECIMAL.test(value.id)
      : typeof value.id === "string" && UUID.test(value.id);
  if (!idIsValid || !isConsentEmail(value.subscriber_email)) return false;

  const stateIsValid =
    typeof value.new_state === "string" &&
    (value.kind === "receipt"
      ? CONSENT_RECEIPT_STATES.has(value.new_state)
      : CONSENT_PROOF_STATES.has(value.new_state));
  return (
    stateIsValid &&
    isOptionalConsentToken(value.prev_state, 128) &&
    isConsentBoundedToken(value.source, 512) &&
    isOptionalConsentNarrative(value.source_detail, 16_384) &&
    isOptionalConsentToken(value.ip, 64) &&
    isOptionalConsentToken(value.user_agent, 2_048) &&
    isOptionalConsentToken(value.privacy_policy_version, 256) &&
    isOptionalConsentNarrative(value.captured_text, 65_536) &&
    isTimestamp(value.at) &&
    isTimestamp(value.recorded_at)
  );
}

function isConsentEvent(value: unknown): value is ConsentEvent {
  if (!isRecord(value) || !hasOnlyKeys(value, CONSENT_EVENT_KEYS)) return false;
  return (
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    (value.decision_id === undefined ||
      (typeof value.decision_id === "string" &&
        UUID.test(value.decision_id))) &&
    typeof value.subject_type === "string" &&
    CONSENT_SUBJECT_TYPES.has(
      value.subject_type as ConsentEvent["subject_type"],
    ) &&
    (value.subject_id !== undefined || value.subject_email !== undefined) &&
    isOptionalConsentToken(value.subject_id, 512) &&
    isOptionalConsentEmail(value.subject_email) &&
    typeof value.channel === "string" &&
    CONSENT_CHANNELS.has(value.channel as ConsentEvent["channel"]) &&
    typeof value.category === "string" &&
    CONSENT_CATEGORIES.has(value.category as ConsentEvent["category"]) &&
    typeof value.action === "string" &&
    CONSENT_ACTIONS.has(value.action as ConsentEvent["action"]) &&
    isConsentBoundedToken(value.source, 512) &&
    isConsentBoundedToken(value.policy_version, 256) &&
    (value.preferences === undefined || isBoundedRecord(value.preferences)) &&
    isOptionalConsentNarrative(value.proof_text, 65_536) &&
    isOptionalConsentToken(value.ip, 64) &&
    isOptionalConsentToken(value.user_agent, 2_048) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.recorded_at)
  );
}

function receiptsAreStrictlyOrdered(
  receipts: readonly ConsentReceipt[],
): boolean {
  const identities = new Set<string>();
  for (let index = 0; index < receipts.length; index += 1) {
    const row = receipts[index]!;
    const identity = `${row.kind}:${row.id}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    if (index === 0) continue;
    const previous = receipts[index - 1]!;
    const chronology = compareConsentTimestamp(
      previous.recorded_at,
      row.recorded_at,
    );
    if (chronology < 0) return false;
    if (chronology > 0) continue;
    if (previous.kind < row.kind) return false;
    if (previous.kind > row.kind) continue;
    if (previous.id <= row.id) return false;
  }
  return true;
}

function eventsAreStrictlyOrdered(events: readonly ConsentEvent[]): boolean {
  const identities = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const row = events[index]!;
    if (identities.has(row.id)) return false;
    identities.add(row.id);
    if (index === 0) continue;
    const previous = events[index - 1]!;
    const chronology = compareConsentTimestamp(
      previous.recorded_at,
      row.recorded_at,
    );
    if (chronology < 0 || (chronology === 0 && previous.id <= row.id)) {
      return false;
    }
  }
  return true;
}

function consentContractFailure(kind: "receipt" | "event"): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "invalid_consent_evidence_response_contract",
      message: `The consent service returned an invalid ${kind} evidence page. The previous verified workspace snapshot was kept; retry the request.`,
    },
    retryability: "manual",
  };
}

function validateConsentReceiptsResponse(
  response: ApiResult<unknown>,
  expectedWorkspaceId: string,
  expectedEmail?: string,
): ApiResult<ConsentReceiptsResponse> {
  if (response.error) return response;
  const value = response.data;
  const keys =
    expectedEmail === undefined
      ? CONSENT_RECEIPT_RESPONSE_KEYS
      : CONSENT_RECEIPT_BY_EMAIL_RESPONSE_KEYS;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, keys) ||
    value.schema_version !== 1 ||
    typeof value.workspace_id !== "string" ||
    !UUID.test(value.workspace_id) ||
    !isTimestamp(value.snapshot_at) ||
    !Array.isArray(value.source_planes) ||
    value.source_planes.length !== 2 ||
    value.source_planes[0] !== "consent_receipts" ||
    value.source_planes[1] !== "consent_records" ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > CONSENT_MAX_PAGE_ROWS ||
    !value.receipts.every((row) => isConsentReceipt(row)) ||
    !Number.isSafeInteger(value.count) ||
    value.count !== value.receipts.length ||
    !isPageCursorContract(value.has_more, value.next_cursor) ||
    !receiptsAreStrictlyOrdered(value.receipts) ||
    value.receipts.some(
      (row) =>
        compareConsentTimestamp(row.recorded_at, value.snapshot_at as string) >
        0,
    ) ||
    (expectedEmail !== undefined && !isConsentEmail(value.email))
  ) {
    return consentContractFailure("receipt");
  }
  if (!responseIdentityMatches(expectedWorkspaceId, value.workspace_id)) {
    return consentContractFailure("receipt");
  }
  if (
    expectedEmail !== undefined &&
    (!responseIdentityMatches(expectedEmail, value.email as string) ||
      value.receipts.some(
        (row) => !responseIdentityMatches(expectedEmail, row.subscriber_email),
      ))
  ) {
    return responseIdentityMismatch("subscriber");
  }
  return response as ApiResult<ConsentReceiptsResponse>;
}

function validateConsentEventsResponse(
  response: ApiResult<unknown>,
  expectedWorkspaceId: string,
): ApiResult<ConsentEventsResponse> {
  if (response.error) return response;
  const value = response.data;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, CONSENT_EVENT_RESPONSE_KEYS) ||
    value.schema_version !== 1 ||
    typeof value.workspace_id !== "string" ||
    !UUID.test(value.workspace_id) ||
    !isTimestamp(value.snapshot_at) ||
    !Array.isArray(value.source_planes) ||
    value.source_planes.length !== 1 ||
    value.source_planes[0] !== "consent_events" ||
    !Array.isArray(value.events) ||
    value.events.length > CONSENT_MAX_PAGE_ROWS ||
    !value.events.every((row) => isConsentEvent(row)) ||
    !Number.isSafeInteger(value.count) ||
    value.count !== value.events.length ||
    !isPageCursorContract(value.has_more, value.next_cursor) ||
    !eventsAreStrictlyOrdered(value.events) ||
    value.events.some(
      (row) =>
        compareConsentTimestamp(row.recorded_at, value.snapshot_at as string) >
        0,
    )
  ) {
    return consentContractFailure("event");
  }
  if (!responseIdentityMatches(expectedWorkspaceId, value.workspace_id)) {
    return consentContractFailure("event");
  }
  return response as ApiResult<ConsentEventsResponse>;
}

/**
 * Per-subscriber email-tracking eligibility — the read shape returned
 * by `GET /tracking`. Open + click opt-outs are surfaced as nullable
 * timestamps (server marks them with `*_opt_out_at` ISO strings).
 */
export interface SubscriberTrackingPrefs {
  subscriber_id: string;
  subscriber_email: string;
  open_opt_out_at?: string | null;
  click_opt_out_at?: string | null;
  effective_open_opt_out: boolean;
  effective_click_opt_out: boolean;
  source: string;
  gpc: boolean;
  policy_version: string;
  updated_at: string;
}

/**
 * PATCH body for `/tracking`. Pointer fields semantically: pass
 * `true` to opt-out, `false` to grant, omit to leave alone. At least
 * one of `open_opt_out` / `click_opt_out` is required server-side.
 */
export interface SubscriberTrackingPrefsPatch {
  open_opt_out?: boolean;
  click_opt_out?: boolean;
  source?: string;
  policy_version?: string;
  gpc?: boolean;
}

function validateTrackingConsentResponse(
  response: ApiResult<SubscriberTrackingPrefs>,
  subscriberId: string | number,
  incompleteMessage: string,
): ApiResult<SubscriberTrackingPrefs> {
  if (response.error) return response;
  if (
    typeof response.data.subscriber_id !== "string" ||
    typeof response.data.subscriber_email !== "string" ||
    response.data.subscriber_email.trim() === "" ||
    typeof response.data.effective_open_opt_out !== "boolean" ||
    typeof response.data.effective_click_opt_out !== "boolean" ||
    typeof response.data.gpc !== "boolean" ||
    typeof response.data.source !== "string" ||
    typeof response.data.policy_version !== "string" ||
    typeof response.data.updated_at !== "string" ||
    !response.serverVersion?.trim()
  ) {
    return responseContractFailure(incompleteMessage);
  }
  if (!responseIdentityMatches(subscriberId, response.data.subscriber_id)) {
    return responseIdentityMismatch("subscriber");
  }
  return response;
}

/**
 * GET /api/v1/consent/receipts?since=&limit=&source=
 *
 * Tenant-scoped receipt/proof projection. It does not include the separate
 * consent-events, SMS, import-approval, or projection ledgers and therefore
 * must never be presented as the workspace's complete consent history.
 */
export function createListConsentReceipts({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function listConsentReceipts(
    opts: ConsentReceiptListOptions,
  ): Promise<ApiResult<ConsentReceiptsResponse>> {
    if (!UUID.test(opts.workspaceId)) return consentContractFailure("receipt");
    const params = new URLSearchParams();
    if (opts.since) params.set("since", opts.since);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.source) params.set("source", opts.source);
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (DEMO_DATA_FALLBACK_ENABLED) {
      params.set("workspace_id", opts.workspaceId);
    }
    const qs = params.toString();
    const response = await request<unknown>(
      `/api/v1/consent/receipts${qs ? `?${qs}` : ""}`,
    );
    return validateConsentReceiptsResponse(response, opts.workspaceId);
  };
}

/**
 * GET /api/v1/consent/receipts/by-email/{email}
 *
 * Per-subscriber consent history. Used by the subscriber slide-over.
 */
export function createGetConsentReceiptsByEmail({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function getConsentReceiptsByEmail(
    email: string,
    opts: Pick<ConsentReceiptListOptions, "workspaceId" | "limit" | "cursor">,
  ): Promise<ApiResult<ConsentReceiptsResponse>> {
    if (!UUID.test(opts.workspaceId) || !isConsentEmail(email)) {
      return consentContractFailure("receipt");
    }
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const response = await request<unknown>(
      `/api/v1/consent/receipts/by-email/${encodeURIComponent(email)}${qs ? `?${qs}` : ""}`,
    );
    return validateConsentReceiptsResponse(response, opts.workspaceId, email);
  };
}

/**
 * GET /api/v1/consent/events — admin-scoped broader ledger covering
 * visitors, users, subscribers, and workspaces. Same data sensitivity
 * as receipts; surface filter chips client-side.
 */
export function createListConsentEvents({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function listConsentEvents(
    opts: ConsentEventListOptions,
  ): Promise<ApiResult<ConsentEventsResponse>> {
    if (!UUID.test(opts.workspaceId)) return consentContractFailure("event");
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.subjectType) params.set("subject_type", opts.subjectType);
    if (opts.category) params.set("category", opts.category);
    if (opts.action) params.set("action", opts.action);
    if (opts.since) params.set("since", opts.since);
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (DEMO_DATA_FALLBACK_ENABLED) {
      params.set("workspace_id", opts.workspaceId);
    }
    const qs = params.toString();
    const response = await request<unknown>(
      `/api/v1/consent/events${qs ? `?${qs}` : ""}`,
    );
    return validateConsentEventsResponse(response, opts.workspaceId);
  };
}

/**
 * GET /api/v1/subscribers/{id}/tracking-consent — stable-identity tracking
 * eligibility plus the exact ETag required by the desktop write path.
 */
export function createGetSubscriberTrackingPrefs({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function getSubscriberTrackingPrefs(
    subscriberId: string | number,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SubscriberTrackingPrefs>> {
    const response = await request<SubscriberTrackingPrefs>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/tracking-consent`,
      undefined,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    return validateTrackingConsentResponse(
      response,
      subscriberId,
      "The tracking-consent service returned an incomplete state or no exact revision. The previous verified preferences were kept; refresh before changing them.",
    );
  };
}

/**
 * PATCH /api/v1/subscribers/{id}/tracking-consent — mutate the stable
 * subscriber identity under the exact ETag returned by the preceding GET.
 */
export function createPatchSubscriberTrackingPrefs({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function patchSubscriberTrackingPrefs(
    subscriberId: string | number,
    input: SubscriberTrackingPrefsPatch,
    opts: { version: string; signal?: AbortSignal },
  ): Promise<ApiResult<SubscriberTrackingPrefs>> {
    const version = opts.version.trim();
    if (!version || version === "*") {
      return {
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
          message:
            "Refresh these tracking preferences before changing them so the latest exact revision can be verified.",
        },
        retryability: "not-retryable",
      };
    }
    const response = await request<SubscriberTrackingPrefs>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/tracking-consent`,
      {
        method: "PATCH",
        headers: { "If-Match": version },
        body: JSON.stringify(input),
      },
      {
        maxAttempts: 1,
        requireOnline: true,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    return validateTrackingConsentResponse(
      response,
      subscriberId,
      "The tracking-consent service did not return a complete committed state with one fresh revision. The previous verified preferences were kept; refresh before trying again.",
    );
  };
}

/** GET /api/v1/privacy/incidents — operator queue. */
export function createListPrivacyIncidents({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function listPrivacyIncidents(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ApiResult<PrivacyIncidentListResponse>> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const query = params.toString();
    const response = await request<PrivacyIncidentListResponse>(
      `/api/v1/privacy/incidents${query ? `?${query}` : ""}`,
    );
    if (response.error) return response;
    const data = response.data as unknown;
    if (
      !isRecord(data) ||
      !hasOnlyKeys(
        data,
        new Set(["incidents", "known_jurisdictions", "nextCursor"]),
      )
    ) {
      return privacyIncidentContractFailure();
    }
    const incidents = data.incidents;
    const knownJurisdictions = data.known_jurisdictions;
    if (
      !Array.isArray(incidents) ||
      incidents.length > PRIVACY_INCIDENT_LIST_MAX_ITEMS ||
      !incidents.every((incident) => isPrivacyIncident(incident, "absent")) ||
      new Set(incidents.map((incident) => incident.id)).size !==
        incidents.length ||
      !isJurisdictionReferenceArray(knownJurisdictions) ||
      (data.nextCursor !== undefined &&
        (!isNonEmptyString(data.nextCursor) ||
          new TextEncoder().encode(data.nextCursor).byteLength > 8_192 ||
          !OPAQUE_CURSOR.test(data.nextCursor))) ||
      (incidents.length === 0 && data.nextCursor !== undefined)
    ) {
      return privacyIncidentContractFailure();
    }
    for (let index = 1; index < incidents.length; index += 1) {
      const previous = incidents[index - 1];
      const current = incidents[index];
      if (!previous || !current) return privacyIncidentContractFailure();
      const timeDelta =
        Date.parse(previous.detected_at) - Date.parse(current.detected_at);
      if (timeDelta < 0 || (timeDelta === 0 && previous.id <= current.id)) {
        return privacyIncidentContractFailure();
      }
    }
    return response;
  };
}

/** GET /api/v1/privacy/incidents/{id} — single incident + resolution. */
export function createGetPrivacyIncident({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function getPrivacyIncident(
    id: string,
  ): Promise<ApiResult<PrivacyIncident>> {
    const response = await request<PrivacyIncident>(
      `/api/v1/privacy/incidents/${encodeURIComponent(id)}`,
    );
    return validateIncidentResult(response, id);
  };
}

/** POST /api/v1/privacy/incidents — open a new incident. */
export function createCreatePrivacyIncident({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function createPrivacyIncident(
    input: PrivacyIncidentCreateInput,
    options: { idempotencyKey: string },
  ): Promise<ApiResult<PrivacyIncident>> {
    if (!isValidPrivacyIncidentIdempotencyKey(options.idempotencyKey)) {
      return privacyIncidentIdempotencyKeyFailure();
    }
    const response = await request<PrivacyIncident>(
      "/api/v1/privacy/incidents",
      {
        method: "POST",
        headers: { "Idempotency-Key": options.idempotencyKey },
        body: JSON.stringify(input),
      },
    );
    return validateIncidentResult(response);
  };
}

/** POST /api/v1/privacy/incidents/{id}/transition — state move. */
export function createTransitionPrivacyIncident({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function transitionPrivacyIncident(
    id: string,
    to: PrivacyIncidentState,
    reason: string,
    expectedFrom: PrivacyIncidentState,
  ): Promise<ApiResult<PrivacyIncidentTransitionResponse>> {
    const response = await request<PrivacyIncidentTransitionResponse>(
      `/api/v1/privacy/incidents/${encodeURIComponent(id)}/transition`,
      {
        method: "POST",
        body: JSON.stringify({ expected_from: expectedFrom, to, reason }),
      },
    );
    if (response.error) return response;
    // Closure is an explicit release hold. A 2xx here means a stale or rogue
    // backend violated the canonical contract and must never become UI success.
    if (to === "closed") return privacyIncidentContractFailure();
    const data = response.data as unknown;
    if (
      !isRecord(data) ||
      !hasOnlyKeys(data, new Set(["incident_id", "from", "to", "at"])) ||
      !isNonEmptyString(data.incident_id) ||
      !isIncidentState(data.from) ||
      !isIncidentState(data.to) ||
      !isTimestamp(data.at)
    ) {
      return privacyIncidentContractFailure();
    }
    if (!responseIdentityMatches(id, data.incident_id)) {
      return privacyIncidentIdentityMismatch();
    }
    if (data.from !== expectedFrom || data.to !== to) {
      return privacyIncidentContractFailure();
    }
    return response;
  };
}

/**
 * POST /api/v1/privacy/incidents/{id}/signoff — authenticated release hold.
 * The server returns 503 until a distinct principal and durable approval
 * receipt can be proven. Any unexpected 2xx is rejected as contract drift.
 */
export function createSignoffPrivacyIncident({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function signoffPrivacyIncident(
    id: string,
    input: { signoff_by: string; notes?: string },
  ): Promise<ApiResult<never>> {
    const response = await request<never>(
      `/api/v1/privacy/incidents/${encodeURIComponent(id)}/signoff`,
      { method: "POST", body: JSON.stringify(input) },
    );
    if (response.error) return response;
    return privacyIncidentContractFailure();
  };
}

/**
 * POST /api/v1/privacy/incidents/{id}/notifications — authenticated release
 * hold. Manual delivery assertions are not accepted as evidence; any
 * unexpected 2xx is rejected as contract drift.
 */
export function createRecordPrivacyIncidentNotification({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function recordPrivacyIncidentNotification(
    id: string,
    input: PrivacyIncidentNotificationInput,
  ): Promise<ApiResult<never>> {
    const response = await request<never>(
      `/api/v1/privacy/incidents/${encodeURIComponent(id)}/notifications`,
      { method: "POST", body: JSON.stringify(input) },
    );
    if (response.error) return response;
    return privacyIncidentContractFailure();
  };
}

/** GET /api/v1/privacy/incidents/{id}/events — merged ledger. */
export function createListPrivacyIncidentEvents({
  request,
}: ConsentPrivacyOperationsDependencies) {
  return async function listPrivacyIncidentEvents(
    id: string,
  ): Promise<ApiResult<PrivacyIncidentEventsResponse>> {
    const response = await request<PrivacyIncidentEventsResponse>(
      `/api/v1/privacy/incidents/${encodeURIComponent(id)}/events`,
    );
    if (response.error) return response;
    const data = response.data as unknown;
    if (
      !isRecord(data) ||
      !hasOnlyKeys(data, new Set(["incident_id", "events"])) ||
      typeof data.incident_id !== "string" ||
      !UUID.test(data.incident_id) ||
      !Array.isArray(data.events) ||
      data.events.length > PRIVACY_INCIDENT_EVENT_MAX_ITEMS ||
      !data.events.every((event) => isPrivacyIncidentEvent(event)) ||
      new Set(data.events.map((event) => `${event.source}:${event.event_id}`))
        .size !== data.events.length
    ) {
      return privacyIncidentContractFailure();
    }
    if (!responseIdentityMatches(id, data.incident_id)) {
      return privacyIncidentIdentityMismatch();
    }
    for (let index = 1; index < data.events.length; index += 1) {
      const previous = data.events[index - 1];
      const current = data.events[index];
      if (
        !isPrivacyIncidentEvent(previous) ||
        !isPrivacyIncidentEvent(current)
      ) {
        return privacyIncidentContractFailure();
      }
      const timeDelta = Date.parse(previous.at) - Date.parse(current.at);
      const previousSourceOrder =
        previous.source === "incident_state_transitions" ? 0 : 1;
      const currentSourceOrder =
        current.source === "incident_state_transitions" ? 0 : 1;
      if (
        timeDelta > 0 ||
        (timeDelta === 0 && previousSourceOrder > currentSourceOrder) ||
        (timeDelta === 0 &&
          previousSourceOrder === currentSourceOrder &&
          previous.event_id >= current.event_id)
      ) {
        return privacyIncidentContractFailure();
      }
    }
    return response;
  };
}

/**
 * GET /api/v1/privacy/incidents/{id}/packet/{audience} — authenticated
 * release hold. The server returns 503 until every packet assertion can be
 * derived from verified incident evidence. Any unexpected 2xx is rejected
 * before its body is read, so unqualified packet bytes cannot reach the UI.
 *
 * Bypasses the standard `request()` helper because the historical success
 * body was not JSON. It mirrors the auth-header and abort-signal pattern but
 * bypasses offline cache and queue paths because this is a sensitive,
 * online-only boundary even while release-held.
 */
export function createDownloadPrivacyIncidentPacket({
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch,
  apiUrl,
  errorFromResponse,
  transportError,
}: ConsentPrivacyOperationsDependencies) {
  return async function downloadPrivacyIncidentPacket(
    id: string,
    audience: PrivacyIncidentAudience,
    opts?: { signal?: AbortSignal },
  ): Promise<ApiResult<never>> {
    const dl = createDownloadController(opts?.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "text/markdown",
      };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await nativeAwareFetch(
        apiUrl(
          `/api/v1/privacy/incidents/${encodeURIComponent(
            id,
          )}/packet/${encodeURIComponent(audience)}`,
        ),
        {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: dl.signal,
        },
      );
      if (!res.ok) {
        return { error: await errorFromResponse(res) };
      }
      return privacyIncidentContractFailure();
    } catch (err) {
      return { error: transportError(err) };
    } finally {
      dl.dispose();
    }
  };
}

export function createConsentPrivacyOperationsMethods(
  dependencies: ConsentPrivacyOperationsDependencies,
) {
  return {
    listConsentReceipts: createListConsentReceipts(dependencies),
    getConsentReceiptsByEmail: createGetConsentReceiptsByEmail(dependencies),
    listConsentEvents: createListConsentEvents(dependencies),
    getSubscriberTrackingPrefs: createGetSubscriberTrackingPrefs(dependencies),
    patchSubscriberTrackingPrefs:
      createPatchSubscriberTrackingPrefs(dependencies),
    listPrivacyIncidents: createListPrivacyIncidents(dependencies),
    getPrivacyIncident: createGetPrivacyIncident(dependencies),
    createPrivacyIncident: createCreatePrivacyIncident(dependencies),
    transitionPrivacyIncident: createTransitionPrivacyIncident(dependencies),
    signoffPrivacyIncident: createSignoffPrivacyIncident(dependencies),
    recordPrivacyIncidentNotification:
      createRecordPrivacyIncidentNotification(dependencies),
    listPrivacyIncidentEvents: createListPrivacyIncidentEvents(dependencies),
    downloadPrivacyIncidentPacket:
      createDownloadPrivacyIncidentPacket(dependencies),
  };
}
