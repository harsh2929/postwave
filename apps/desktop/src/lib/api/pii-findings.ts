import { apiRequest, type ApiResult } from "../api-client";
import type { ApiErr } from "./result";
import {
  responseContractFailure,
  responseIdentityMatches,
  responseIdentityMismatch,
} from "./subscriber-response-integrity";

/** Closed detection taxonomy mirrored from pii_scanner. */
export type PIIDetectionType =
  | "ssn"
  | "credit_card"
  | "date_of_birth"
  | "passport"
  | "drivers_license"
  | "email"
  | "phone"
  | "ip_address"
  | "iban"
  | "other";

export type PIIFindingStatus = "pending" | "reviewed" | "dismissed";
export type PIIReviewedReason =
  | "confirmed_pii"
  | "remediated"
  | "accepted_risk";
export type PIIDismissedReason =
  | "false_positive"
  | "duplicate"
  | "test_data"
  | "not_personal_data";
export type PIIDecisionReason = PIIReviewedReason | PIIDismissedReason;
export type PIIReceiptReason = PIIDecisionReason | "legacy_migrated";
export type PIIFingerprintScheme =
  | "hmac-sha256-v1"
  | "legacy-redacted-v1";
export const PII_COVERAGE_LIMITATIONS = [
  "no_durable_scan_intent",
  "no_retry_or_dead_letter_queue",
  "no_coverage_watermark_or_gap_ledger",
  "direct_subscriber_writers_may_bypass_hooks",
] as const;
export type PIICoverageLimitation =
  (typeof PII_COVERAGE_LIMITATIONS)[number];

export interface PIIScannerMetadata {
  scanner_name: string;
  scanner_version: string;
  detector_name: string;
  detector_version: string;
  policy_name: string;
  policy_version: string;
}

/** Append-only decision evidence. No cleartext detected value is permitted. */
export interface PIIReviewReceipt extends PIIScannerMetadata {
  receipt_id: string;
  status: Exclude<PIIFindingStatus, "pending">;
  reason: PIIReceiptReason;
  comment: string;
  evidence_reference: string;
  reviewed_at: string;
  actor_type: "user" | "api_key" | "legacy";
  actor_id: string;
  fingerprint: string;
  fingerprint_scheme: PIIFingerprintScheme;
  fingerprint_key_version: string;
  /** Pre-review resource version accepted by the compare-and-set write. */
  finding_updated_at: string;
}

/** One persisted shadow-PII detection. The cleartext is never returned. */
export interface PIIFinding extends PIIScannerMetadata {
  id: string;
  subscriber_id: string;
  field_name: string;
  detected_type: PIIDetectionType;
  confidence: number;
  fingerprint: string;
  fingerprint_scheme: PIIFingerprintScheme;
  fingerprint_key_version: string;
  status: PIIFindingStatus;
  reviewed_at?: string;
  reviewed_by?: string;
  review_receipt?: PIIReviewReceipt;
  created_at: string;
  updated_at: string;
}

export interface PIIFindingPage {
  items: PIIFinding[];
  total: number;
  page: number;
  per_page: number;
}

export interface PIIScanConfig extends PIIScannerMetadata {
  available: boolean;
  scan_enabled: boolean;
  status: "enabled_unverified" | "disabled" | "unavailable";
  execution_mode: "partial_write_path_hooks";
  scheduled_scans_available: false;
  fingerprint_scheme?: Extract<PIIFingerprintScheme, "hmac-sha256-v1">;
  fingerprint_key_version?: string;
  reliability: "best_effort";
  coverage: "unverified";
  coverage_limitations: PIICoverageLimitation[];
  max_scan_fields: 500;
  max_scan_field_bytes: 65_536;
  max_detections_per_field: 50;
  max_detections_per_subscriber: 200;
  /** Retained for old rows; scheduled execution is not currently available. */
  scan_schedule?: string;
  updated_at?: string;
}

export interface PIIScanConfigUpdateInput {
  scan_enabled?: boolean;
  scan_schedule?: string;
}

export interface PIIReviewInput {
  status: Exclude<PIIFindingStatus, "pending">;
  reason: PIIDecisionReason;
  comment: string;
  evidence_reference: string;
  expected_updated_at: string;
}

export interface PIIFindingListOptions {
  status?: PIIFindingStatus;
  detectedType?: PIIDetectionType;
  /** Searches safe metadata only: field name, exact ids, or protected HMAC prefix. */
  query?: string;
  page?: number;
  perPage?: number;
  signal?: AbortSignal;
}

const DETECTION_TYPES = new Set<PIIDetectionType>([
  "ssn",
  "credit_card",
  "date_of_birth",
  "passport",
  "drivers_license",
  "email",
  "phone",
  "ip_address",
  "iban",
  "other",
]);
const FINDING_STATUSES = new Set<PIIFindingStatus>([
  "pending",
  "reviewed",
  "dismissed",
]);
const REVIEWED_REASONS = new Set<PIIReviewedReason>([
  "confirmed_pii",
  "remediated",
  "accepted_risk",
]);
const DISMISSED_REASONS = new Set<PIIDismissedReason>([
  "false_positive",
  "duplicate",
  "test_data",
  "not_personal_data",
]);
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_ACTOR_ID_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_KEY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LEGACY_FINGERPRINT_KEY_VERSION = "legacy";
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVIDENCE_REFERENCE_PATTERN =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;
const SSN_SHAPE_PATTERN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
const EMAIL_SHAPE_PATTERN =
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;
const IBAN_SHAPE_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const IPV4_SHAPE_PATTERN = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;
const IPV6_SHAPE_PATTERN =
  /\b[0-9A-F]{1,4}(?::[0-9A-F]{0,4}){2,7}\b/i;
const LONG_NUMERIC_REFERENCE_PATTERN = /\b(?:[0-9][ -]?){12,18}[0-9]\b/;
const RFC3339_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_SAFE_RESPONSE_DEPTH = 12;
const FORBIDDEN_CLEARTEXT_KEYS = [
  "raw_value",
  "raw_value_hash",
  "matched_value",
  "cleartext",
  "detected_value",
];
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CURRENT_SCANNER_NAME = "postwave-shadow-pii";
const CURRENT_DETECTOR_NAME = "regex-heuristic";
const CURRENT_POLICY_NAME = "undeclared-pii-review";
const LEGACY_PROVENANCE_NAME = "legacy-unversioned";
const LEGACY_PROVENANCE_VERSION = "unknown-pre-1760";
const SCANNER_METADATA_KEYS = [
  "scanner_name",
  "scanner_version",
  "detector_name",
  "detector_version",
  "policy_name",
  "policy_version",
] as const;
const FINDING_RESPONSE_KEYS = new Set([
  "id",
  "subscriber_id",
  "field_name",
  "detected_type",
  "confidence",
  "fingerprint",
  "fingerprint_scheme",
  "fingerprint_key_version",
  "status",
  ...SCANNER_METADATA_KEYS,
  "reviewed_at",
  "reviewed_by",
  "review_receipt",
  "created_at",
  "updated_at",
]);
const RECEIPT_RESPONSE_KEYS = new Set([
  "receipt_id",
  "status",
  "reason",
  "comment",
  "evidence_reference",
  "reviewed_at",
  "actor_type",
  "actor_id",
  ...SCANNER_METADATA_KEYS,
  "fingerprint",
  "fingerprint_scheme",
  "fingerprint_key_version",
  "finding_updated_at",
]);
const PAGE_RESPONSE_KEYS = new Set(["items", "total", "page", "per_page"]);
const CONFIG_RESPONSE_KEYS = new Set([
  "available",
  "scan_enabled",
  "status",
  "execution_mode",
  "scheduled_scans_available",
  ...SCANNER_METADATA_KEYS,
  "fingerprint_scheme",
  "fingerprint_key_version",
  "reliability",
  "coverage",
  "coverage_limitations",
  "max_scan_fields",
  "max_scan_field_bytes",
  "max_detections_per_field",
  "max_detections_per_subscriber",
  "scan_schedule",
  "updated_at",
]);
const REVIEW_INPUT_KEYS = new Set([
  "status",
  "reason",
  "comment",
  "evidence_reference",
  "expected_updated_at",
]);

function contractFailure(message: string): ApiErr {
  return responseContractFailure(
    `${message} The previous verified findings were kept; retry the request.`,
  );
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedTrimmed(value: unknown, maxRunes: number): value is string {
  return (
    isNonEmpty(value) &&
    value === value.trim() &&
    runeCount(value) <= maxRunes
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    isNonEmpty(value) &&
    RFC3339_DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function timestampIsOrdered(earlier: string, later: string): boolean {
  return Date.parse(earlier) <= Date.parse(later);
}

function runeCount(value: string): number {
  return Array.from(value).length;
}

function isPlainResponseRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyAllowedKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  return (
    isPlainResponseRecord(value) &&
    Object.keys(value).every(
      (key) => !PROTOTYPE_KEYS.has(key) && allowed.has(key),
    )
  );
}

/** Mirrors the server's conservative receipt-comment PII guard. */
export function piiReviewCommentContainsStrongPII(value: string): boolean {
  return (
    SSN_SHAPE_PATTERN.test(value) ||
    EMAIL_SHAPE_PATTERN.test(value) ||
    IBAN_SHAPE_PATTERN.test(value) ||
    IPV4_SHAPE_PATTERN.test(value) ||
    IPV6_SHAPE_PATTERN.test(value) ||
    LONG_NUMERIC_REFERENCE_PATTERN.test(value)
  );
}

function hasScannerMetadata(value: unknown): value is PIIScannerMetadata {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    isBoundedTrimmed(record.scanner_name, 128) &&
    isBoundedTrimmed(record.scanner_version, 128) &&
    isBoundedTrimmed(record.detector_name, 128) &&
    isBoundedTrimmed(record.detector_version, 128) &&
    isBoundedTrimmed(record.policy_name, 128) &&
    isBoundedTrimmed(record.policy_version, 128)
  );
}

function hasFindingProvenance(value: Record<string, unknown>): boolean {
  if (!hasScannerMetadata(value)) return false;
  if (value.fingerprint_scheme === "legacy-redacted-v1") {
    return (
      value.scanner_name === LEGACY_PROVENANCE_NAME &&
      value.detector_name === LEGACY_PROVENANCE_NAME &&
      value.policy_name === LEGACY_PROVENANCE_NAME &&
      value.scanner_version === LEGACY_PROVENANCE_VERSION &&
      value.detector_version === LEGACY_PROVENANCE_VERSION &&
      value.policy_version === LEGACY_PROVENANCE_VERSION
    );
  }
  return (
    value.fingerprint_scheme === "hmac-sha256-v1" &&
    value.scanner_name === CURRENT_SCANNER_NAME &&
    value.detector_name === CURRENT_DETECTOR_NAME &&
    value.policy_name === CURRENT_POLICY_NAME
  );
}

function hasFingerprintMetadata(
  value: Record<string, unknown>,
): value is Record<string, unknown> & {
  fingerprint: string;
  fingerprint_scheme: PIIFingerprintScheme;
  fingerprint_key_version: string;
} {
  if (
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.fingerprint) ||
    typeof value.fingerprint_key_version !== "string"
  ) {
    return false;
  }
  if (value.fingerprint_scheme === "legacy-redacted-v1") {
    return value.fingerprint_key_version === LEGACY_FINGERPRINT_KEY_VERSION;
  }
  return (
    value.fingerprint_scheme === "hmac-sha256-v1" &&
    FINGERPRINT_KEY_VERSION_PATTERN.test(value.fingerprint_key_version) &&
    value.fingerprint_key_version !== LEGACY_FINGERPRINT_KEY_VERSION
  );
}

function containsCleartextKey(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  // Reject over-deep response containers rather than allowing an attacker to
  // bury a cleartext/prototype key beyond the inspection boundary.
  if (depth >= MAX_SAFE_RESPONSE_DEPTH) return true;
  if (Array.isArray(value)) {
    return value.some((item) => containsCleartextKey(item, depth + 1));
  }
  if (!isPlainResponseRecord(value)) return true;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROTOTYPE_KEYS.has(key)) return true;
    const canonicalKey = key.toLowerCase().replaceAll(/[^a-z]/g, "");
    if (
      FORBIDDEN_CLEARTEXT_KEYS.some(
        (forbidden) =>
          canonicalKey === forbidden.toLowerCase().replaceAll("_", ""),
      )
    ) {
      return true;
    }
    if (containsCleartextKey(nested, depth + 1)) return true;
  }
  return false;
}

function isReasonForStatus(
  status: Exclude<PIIFindingStatus, "pending">,
  reason: unknown,
): reason is PIIDecisionReason {
  return status === "reviewed"
    ? REVIEWED_REASONS.has(reason as PIIReviewedReason)
    : DISMISSED_REASONS.has(reason as PIIDismissedReason);
}

function isReceiptReasonForStatus(
  status: Exclude<PIIFindingStatus, "pending">,
  reason: unknown,
): reason is PIIReceiptReason {
  return reason === "legacy_migrated" || isReasonForStatus(status, reason);
}

function validateReceipt(
  receipt: unknown,
  finding: PIIFinding,
): ApiErr | null {
  if (!receipt || typeof receipt !== "object") {
    return contractFailure("The PII service omitted an immutable review receipt.");
  }
  const value = receipt as Record<string, unknown>;
  if (
    containsCleartextKey(value) ||
    !hasOnlyAllowedKeys(value, RECEIPT_RESPONSE_KEYS)
  ) {
    return contractFailure("The PII service returned a forbidden or unsafe receipt field.");
  }
  const status = value.status;
  const actorType = value.actor_type;
  const actorID = value.actor_id;
  const comment = value.comment;
  const evidenceReference = value.evidence_reference;
  if (
    (status !== "reviewed" && status !== "dismissed") ||
    !isReceiptReasonForStatus(status, value.reason) ||
    typeof value.receipt_id !== "string" ||
    !UUID_PATTERN.test(value.receipt_id) ||
    !isNonEmpty(comment) ||
    comment !== comment.trim() ||
    runeCount(comment) > 2_000 ||
    piiReviewCommentContainsStrongPII(comment) ||
    !isNonEmpty(evidenceReference) ||
    evidenceReference !== evidenceReference.trim() ||
    runeCount(evidenceReference) < 3 ||
    runeCount(evidenceReference) > 288 ||
    !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference) ||
    !isTimestamp(value.reviewed_at) ||
    (actorType !== "user" && actorType !== "api_key" && actorType !== "legacy") ||
    !isNonEmpty(actorID) ||
    actorID !== actorID.trim() ||
    runeCount(actorID) > 200 ||
    (actorType === "legacy") !== (value.reason === "legacy_migrated") ||
    (actorType === "legacy" && !LEGACY_ACTOR_ID_PATTERN.test(actorID)) ||
    (actorType !== "legacy" && !UUID_PATTERN.test(actorID)) ||
    !hasFingerprintMetadata(value) ||
    !hasFindingProvenance(value) ||
    !isTimestamp(value.finding_updated_at) ||
    value.fingerprint !== finding.fingerprint ||
    value.fingerprint_scheme !== finding.fingerprint_scheme ||
    value.fingerprint_key_version !== finding.fingerprint_key_version ||
    status !== finding.status
  ) {
    return contractFailure("The PII service returned an invalid review receipt.");
  }
  if (
    !timestampIsOrdered(finding.created_at, value.finding_updated_at as string) ||
    !timestampIsOrdered(
      value.finding_updated_at as string,
      value.reviewed_at as string,
    ) ||
    !timestampIsOrdered(value.reviewed_at as string, finding.updated_at)
  ) {
    return contractFailure(
      "The PII service returned a receipt with an impossible event timeline.",
    );
  }
  for (const key of [
    "scanner_name",
    "scanner_version",
    "detector_name",
    "detector_version",
    "policy_name",
    "policy_version",
  ] as const) {
    if (value[key] !== finding[key]) {
      return contractFailure(
        "The PII service returned a receipt with mismatched provenance.",
      );
    }
  }
  return null;
}

function validateFinding(value: unknown): ApiErr | null {
  if (!value || typeof value !== "object") {
    return contractFailure("The PII service returned an invalid finding.");
  }
  const finding = value as PIIFinding;
  const record = value as unknown as Record<string, unknown>;
  if (
    containsCleartextKey(record) ||
    !hasOnlyAllowedKeys(record, FINDING_RESPONSE_KEYS)
  ) {
    return contractFailure("The PII service returned a forbidden or unsafe finding field.");
  }
  if (
    !isBoundedTrimmed(finding.id, 200) ||
    !UUID_PATTERN.test(finding.id) ||
    !isBoundedTrimmed(finding.subscriber_id, 200) ||
    !UUID_PATTERN.test(finding.subscriber_id) ||
    !isBoundedTrimmed(finding.field_name, 256) ||
    !DETECTION_TYPES.has(finding.detected_type) ||
    typeof finding.confidence !== "number" ||
    !Number.isFinite(finding.confidence) ||
    finding.confidence < 0 ||
    finding.confidence > 1 ||
    !hasFingerprintMetadata(record) ||
    !FINDING_STATUSES.has(finding.status) ||
    !isTimestamp(finding.created_at) ||
    !isTimestamp(finding.updated_at) ||
    !hasFindingProvenance(record)
  ) {
    return contractFailure("The PII service returned an incomplete finding.");
  }
  if (!timestampIsOrdered(finding.created_at, finding.updated_at)) {
    return contractFailure("The PII service returned an impossible finding timeline.");
  }
  if (finding.status === "pending") {
    if (
      finding.review_receipt !== undefined ||
      finding.reviewed_at !== undefined ||
      finding.reviewed_by !== undefined
    ) {
      return contractFailure("A pending PII finding contained terminal review evidence.");
    }
    return null;
  }
  if (!isTimestamp(finding.reviewed_at) || !isNonEmpty(finding.reviewed_by)) {
    return contractFailure("A terminal PII finding omitted its review stamp.");
  }
  if (
    !timestampIsOrdered(finding.created_at, finding.reviewed_at) ||
    !timestampIsOrdered(finding.reviewed_at, finding.updated_at)
  ) {
    return contractFailure("A terminal PII finding had an impossible review timeline.");
  }
  const receiptError = validateReceipt(finding.review_receipt, finding);
  if (receiptError) return receiptError;
  const receipt = finding.review_receipt!;
  if (
    finding.reviewed_at !== receipt.reviewed_at ||
    finding.reviewed_by !== `${receipt.actor_type}:${receipt.actor_id}`
  ) {
    return contractFailure("A terminal PII finding did not match its review receipt.");
  }
  return null;
}

function validateFindingPage(
  value: PIIFindingPage | undefined,
  subscriberId?: string | number,
  expected: PIIFindingListOptions = {},
): ApiErr | null {
  if (
    containsCleartextKey(value) ||
    !value ||
    !hasOnlyAllowedKeys(value, PAGE_RESPONSE_KEYS) ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    !Number.isSafeInteger(value.page) ||
    value.page < 1 ||
    value.page > 1_000_000 ||
    !Number.isSafeInteger(value.per_page) ||
    value.per_page < 1 ||
    value.per_page > 200 ||
    value.items.length > value.per_page ||
    value.items.length > value.total
  ) {
    return contractFailure("The PII service returned an invalid page envelope.");
  }
  const offset = (value.page - 1) * value.per_page;
  const expectedItems = Math.max(
    0,
    Math.min(value.per_page, value.total - offset),
  );
  if (
    (value.total === 0 && value.page !== 1) ||
    (value.total > 0 && offset >= value.total) ||
    value.items.length !== expectedItems
  ) {
    return contractFailure("The PII service returned impossible pagination geometry.");
  }
  if (
    (expected.page !== undefined && value.page !== expected.page) ||
    (expected.perPage !== undefined && value.per_page !== expected.perPage)
  ) {
    return contractFailure("The PII service returned a different result page than requested.");
  }
  const ids = new Set<string>();
  for (const finding of value.items) {
    const invalid = validateFinding(finding);
    if (invalid) return invalid;
    if (ids.has(finding.id)) {
      return contractFailure("The PII service returned duplicate finding identities.");
    }
    ids.add(finding.id);
    if (
      subscriberId !== undefined &&
      !responseIdentityMatches(subscriberId, finding.subscriber_id)
    ) {
      return responseIdentityMismatch("subscriber");
    }
    if (
      (expected.status !== undefined && finding.status !== expected.status) ||
      (expected.detectedType !== undefined &&
        finding.detected_type !== expected.detectedType)
    ) {
      return contractFailure("The PII service returned a finding outside the requested filters.");
    }
  }
  return null;
}

function validateScanConfig(value: PIIScanConfig | undefined): ApiErr | null {
  if (
    containsCleartextKey(value) ||
    !value ||
    !hasOnlyAllowedKeys(value, CONFIG_RESPONSE_KEYS) ||
    typeof value.available !== "boolean" ||
    typeof value.scan_enabled !== "boolean" ||
    (value.status !== "enabled_unverified" &&
      value.status !== "disabled" &&
      value.status !== "unavailable") ||
    value.execution_mode !== "partial_write_path_hooks" ||
    value.scheduled_scans_available !== false ||
    value.reliability !== "best_effort" ||
    value.coverage !== "unverified" ||
    !Array.isArray(value.coverage_limitations) ||
    value.coverage_limitations.length !== PII_COVERAGE_LIMITATIONS.length ||
    !PII_COVERAGE_LIMITATIONS.every(
      (limitation, index) => value.coverage_limitations[index] === limitation,
    ) ||
    value.max_scan_fields !== 500 ||
    value.max_scan_field_bytes !== 65_536 ||
    value.max_detections_per_field !== 50 ||
    value.max_detections_per_subscriber !== 200 ||
    !hasScannerMetadata(value) ||
    value.scanner_name !== CURRENT_SCANNER_NAME ||
    value.scanner_version !== "2.0.0" ||
    value.detector_name !== CURRENT_DETECTOR_NAME ||
    value.detector_version !== "2.0.0" ||
    value.policy_name !== CURRENT_POLICY_NAME ||
    value.policy_version !== "sub-071-v2" ||
    (value.scan_schedule !== undefined && value.scan_schedule !== "") ||
    (value.available
      ? (value.status === "enabled_unverified") !== value.scan_enabled ||
        value.status === "unavailable" ||
        value.fingerprint_scheme !== "hmac-sha256-v1" ||
        typeof value.fingerprint_key_version !== "string" ||
        !FINGERPRINT_KEY_VERSION_PATTERN.test(value.fingerprint_key_version) ||
        value.fingerprint_key_version === LEGACY_FINGERPRINT_KEY_VERSION
      : value.status !== "unavailable" ||
        value.scan_enabled ||
        value.fingerprint_scheme !== undefined ||
        value.fingerprint_key_version !== undefined) ||
    (value.updated_at !== undefined && !isTimestamp(value.updated_at))
  ) {
    return contractFailure("The PII scanner returned invalid capability metadata.");
  }
  return null;
}

function validateReviewInput(input: PIIReviewInput): ApiErr | null {
  if (
    !hasOnlyAllowedKeys(input, REVIEW_INPUT_KEYS) ||
    (input.status !== "reviewed" && input.status !== "dismissed") ||
    !isReasonForStatus(input.status, input.reason) ||
    !isNonEmpty(input.comment) ||
    input.comment !== input.comment.trim() ||
    runeCount(input.comment) > 2_000 ||
    piiReviewCommentContainsStrongPII(input.comment) ||
    !isNonEmpty(input.evidence_reference) ||
    input.evidence_reference !== input.evidence_reference.trim() ||
    runeCount(input.evidence_reference) < 3 ||
    runeCount(input.evidence_reference) > 288 ||
    !EVIDENCE_REFERENCE_PATTERN.test(input.evidence_reference) ||
    !isTimestamp(input.expected_updated_at)
  ) {
    return {
      error: {
        kind: "http",
        status: 400,
        code: "invalid_pii_review_input",
        message:
          "Choose a valid outcome reason, add a nonempty comment, and provide a safe typed evidence reference.",
      },
      retryability: "not-retryable",
      preservedDraft: input,
    };
  }
  return null;
}

function findingQuery(opts: PIIFindingListOptions): string {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.detectedType) params.set("detected_type", opts.detectedType);
  if (opts.query?.trim()) params.set("q", opts.query.trim());
  if (opts.page) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const query = params.toString();
  return query ? `?${query}` : "";
}

async function validatePageResponse(
  response: ApiResult<PIIFindingPage>,
  subscriberId?: string | number,
  expected: PIIFindingListOptions = {},
): Promise<ApiResult<PIIFindingPage>> {
  if (response.error) return response;
  return validateFindingPage(response.data, subscriberId, expected) ?? response;
}

export const piiFindingsApi = {
  async list(
    opts: PIIFindingListOptions = {},
  ): Promise<ApiResult<PIIFindingPage>> {
    const response = await apiRequest<PIIFindingPage>(
      `/api/v1/pii-findings${findingQuery(opts)}`,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    return validatePageResponse(response, undefined, opts);
  },

  async listForSubscriber(
    subscriberId: string | number,
    opts: Omit<PIIFindingListOptions, "query"> = {},
  ): Promise<ApiResult<PIIFindingPage>> {
    const response = await apiRequest<PIIFindingPage>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/pii-findings${findingQuery(opts)}`,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    return validatePageResponse(response, subscriberId, opts);
  },

  /** Auditable terminal decision. The backend rejects repeat/stale writes. */
  async review(
    id: string,
    input: PIIReviewInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<PIIFinding>> {
    const invalidInput = validateReviewInput(input);
    if (invalidInput) return invalidInput;
    const response = await apiRequest<PIIFinding>(
      `/api/v1/pii-findings/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (response.error) return response;
    if (!responseIdentityMatches(id, response.data?.id)) {
      return responseIdentityMismatch("PII finding");
    }
    const invalid = validateFinding(response.data);
    if (invalid) return invalid;
    const receipt = response.data.review_receipt;
    if (
      response.data.status !== input.status ||
      !receipt ||
      receipt.status !== input.status ||
      receipt.reason !== input.reason ||
      receipt.comment !== input.comment.trim() ||
      receipt.evidence_reference !== input.evidence_reference.trim() ||
      receipt.finding_updated_at !== input.expected_updated_at
    ) {
      return contractFailure(
        "The PII service returned a review receipt that does not match the submitted decision.",
      );
    }
    return response;
  },

  async getScanConfig(opts: {
    signal?: AbortSignal;
  } = {}): Promise<ApiResult<PIIScanConfig>> {
    const response = await apiRequest<PIIScanConfig>(
      "/api/v1/pii-scan-config",
      opts.signal ? { signal: opts.signal } : undefined,
    );
    if (response.error) return response;
    return validateScanConfig(response.data) ?? response;
  },

  async setScanConfig(
    input: PIIScanConfigUpdateInput,
  ): Promise<ApiResult<PIIScanConfig>> {
    const response = await apiRequest<PIIScanConfig>("/api/v1/pii-scan-config", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (response.error) return response;
    return validateScanConfig(response.data) ?? response;
  },
};
