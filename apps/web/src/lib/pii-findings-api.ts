// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Privacy-safe client for the admin-only Shadow-PII review surface.
 *
 * The API deliberately never returns the matched value. Keep that boundary
 * fail-closed here too: every response is parsed as unknown, unexpected keys
 * are rejected, and cleartext-shaped field names are rejected recursively
 * before a response can enter React Query's cache.
 */
import { z } from "zod";

import { api, ApiError } from "@/lib/api";

export const PII_DETECTION_TYPES = [
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
] as const;

export const PII_FINDING_STATUSES = [
  "pending",
  "reviewed",
  "dismissed",
] as const;

export const PII_REVIEW_REASONS = [
  "confirmed_pii",
  "remediated",
  "accepted_risk",
] as const;

export const PII_DISMISS_REASONS = [
  "false_positive",
  "duplicate",
  "test_data",
  "not_personal_data",
] as const;

export type PiiDetectionType = (typeof PII_DETECTION_TYPES)[number];
export type PiiFindingStatus = (typeof PII_FINDING_STATUSES)[number];
export type PiiReviewReason =
  | (typeof PII_REVIEW_REASONS)[number]
  | (typeof PII_DISMISS_REASONS)[number];
export type PiiTerminalStatus = Exclude<PiiFindingStatus, "pending">;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const timestamp = z.string().datetime({ offset: true });
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/u);
const keyVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const activeKeyVersion = keyVersion.refine((value) => value !== "legacy");
const safeNonnegativeInt = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const evidenceReference = z
  .string()
  .min(3)
  .max(288)
  .regex(/^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/u);

const scannerMetadataSchema = z.object({
  scanner_name: z.string().trim().min(1).max(128),
  scanner_version: z.string().trim().min(1).max(128),
  detector_name: z.string().trim().min(1).max(128),
  detector_version: z.string().trim().min(1).max(128),
  policy_name: z.string().trim().min(1).max(128),
  policy_version: z.string().trim().min(1).max(128),
});

const reviewReceiptSchema = scannerMetadataSchema
  .extend({
    receipt_id: uuid,
    status: z.enum(["reviewed", "dismissed"]),
    reason: z.enum([
      ...PII_REVIEW_REASONS,
      ...PII_DISMISS_REASONS,
      "legacy_migrated",
    ]),
    comment: z.string().trim().min(1).max(2_000),
    evidence_reference: evidenceReference,
    reviewed_at: timestamp,
    actor_type: z.enum(["user", "api_key", "legacy"]),
    actor_id: z.string().min(1).max(200),
    fingerprint,
    fingerprint_scheme: z.enum(["hmac-sha256-v1", "legacy-redacted-v1"]),
    fingerprint_key_version: keyVersion,
    finding_updated_at: timestamp,
  })
  .strict()
  .superRefine((receipt, context) => {
    const allowedReasons =
      receipt.status === "reviewed"
        ? new Set<string>(PII_REVIEW_REASONS)
        : new Set<string>(PII_DISMISS_REASONS);
    const legacy = receipt.actor_type === "legacy";
    if (legacy) allowedReasons.add("legacy_migrated");
    if (!allowedReasons.has(receipt.reason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "reason does not match the decision",
      });
    }
    if (
      (legacy && !/^[0-9a-f]{64}$/u.test(receipt.actor_id)) ||
      (!legacy && !uuid.safeParse(receipt.actor_id).success) ||
      legacy !== (receipt.reason === "legacy_migrated")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actor_id"],
        message: "review actor is invalid",
      });
    }
    if (piiReviewCommentContainsStrongPii(receipt.comment)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment"],
        message: "review comment contains raw personal data",
      });
    }
    const legacyFingerprint =
      receipt.fingerprint_scheme === "legacy-redacted-v1";
    if (
      (legacyFingerprint &&
        (receipt.fingerprint_key_version !== "legacy" ||
          receipt.scanner_name !== "legacy-unversioned" ||
          receipt.scanner_version !== "unknown-pre-1760" ||
          receipt.detector_name !== "legacy-unversioned" ||
          receipt.detector_version !== "unknown-pre-1760" ||
          receipt.policy_name !== "legacy-unversioned" ||
          receipt.policy_version !== "unknown-pre-1760")) ||
      (!legacyFingerprint && receipt.fingerprint_key_version === "legacy")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fingerprint_key_version"],
        message: "fingerprint provenance is invalid",
      });
    }
  });

const findingSchema = scannerMetadataSchema
  .extend({
    id: uuid,
    subscriber_id: uuid,
    field_name: z.string().trim().min(1).max(256),
    detected_type: z.enum(PII_DETECTION_TYPES),
    confidence: z.number().finite().min(0).max(1),
    fingerprint,
    fingerprint_scheme: z.enum(["hmac-sha256-v1", "legacy-redacted-v1"]),
    fingerprint_key_version: keyVersion,
    status: z.enum(PII_FINDING_STATUSES),
    reviewed_at: timestamp.optional(),
    reviewed_by: z.string().trim().min(1).max(200).optional(),
    review_receipt: reviewReceiptSchema.optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict()
  .superRefine((finding, context) => {
    if (Date.parse(finding.created_at) > Date.parse(finding.updated_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updated_at"],
        message: "finding timeline is invalid",
      });
    }
    const terminal = finding.status !== "pending";
    const reviewParts = [
      finding.reviewed_at,
      finding.reviewed_by,
      finding.review_receipt,
    ];
    const hasAnyReviewEvidence = reviewParts.some(Boolean);
    const hasCompleteReviewEvidence = reviewParts.every(Boolean);
    if (terminal ? !hasCompleteReviewEvidence : hasAnyReviewEvidence) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_receipt"],
        message: terminal
          ? "terminal evidence is incomplete"
          : "pending finding contains terminal evidence",
      });
      return;
    }
    const legacyFingerprint =
      finding.fingerprint_scheme === "legacy-redacted-v1";
    if (
      (legacyFingerprint &&
        (finding.fingerprint_key_version !== "legacy" ||
          finding.scanner_name !== "legacy-unversioned" ||
          finding.scanner_version !== "unknown-pre-1760" ||
          finding.detector_name !== "legacy-unversioned" ||
          finding.detector_version !== "unknown-pre-1760" ||
          finding.policy_name !== "legacy-unversioned" ||
          finding.policy_version !== "unknown-pre-1760")) ||
      (!legacyFingerprint && finding.fingerprint_key_version === "legacy")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fingerprint_key_version"],
        message: "fingerprint provenance is invalid",
      });
    }
    const receipt = finding.review_receipt;
    if (!receipt) return;
    if (
      receipt.status !== finding.status ||
      receipt.fingerprint !== finding.fingerprint ||
      receipt.fingerprint_scheme !== finding.fingerprint_scheme ||
      receipt.fingerprint_key_version !== finding.fingerprint_key_version ||
      receipt.reviewed_at !== finding.reviewed_at ||
      finding.reviewed_by !== `${receipt.actor_type}:${receipt.actor_id}` ||
      receipt.scanner_name !== finding.scanner_name ||
      receipt.scanner_version !== finding.scanner_version ||
      receipt.detector_name !== finding.detector_name ||
      receipt.detector_version !== finding.detector_version ||
      receipt.policy_name !== finding.policy_name ||
      receipt.policy_version !== finding.policy_version ||
      Date.parse(receipt.finding_updated_at) < Date.parse(finding.created_at) ||
      Date.parse(receipt.reviewed_at) <
        Date.parse(receipt.finding_updated_at) ||
      Date.parse(finding.updated_at) < Date.parse(receipt.reviewed_at)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["review_receipt"],
        message: "review receipt does not match the finding",
      });
    }
  });

const findingPageSchema = z
  .object({
    items: z.array(findingSchema).max(200),
    total: safeNonnegativeInt,
    page: z.number().int().min(1).max(1_000_000),
    per_page: z.number().int().min(1).max(200),
  })
  .strict();

const coverageSnapshotSchema = z
  .object({
    generation: safeNonnegativeInt,
    status: z.enum([
      "disabled",
      "backfill_pending",
      "backfilling",
      "catching_up",
      "caught_up",
      "degraded",
      "unavailable",
    ]),
    snapshot_exact: z.boolean(),
    total_subscribers: safeNonnegativeInt,
    covered_subscribers: safeNonnegativeInt,
    pending_subscribers: safeNonnegativeInt,
    retrying_subscribers: safeNonnegativeInt,
    dead_letter_subscribers: safeNonnegativeInt,
    truncated_subscribers: safeNonnegativeInt,
    missing_state_subscribers: safeNonnegativeInt,
    coalesced_revisions: safeNonnegativeInt,
    oldest_pending_at: timestamp.optional(),
    enable_requested_at: timestamp.optional(),
    backfill_started_at: timestamp.optional(),
    backfill_completed_at: timestamp.optional(),
    reconciliation_requested_at: timestamp.optional(),
    last_reconciled_at: timestamp.optional(),
    last_observed_at: timestamp.optional(),
    last_scanned_at: timestamp.optional(),
  })
  .strict();

const coverageLimitationSchema = z.enum([
  "scanner_dependency_unavailable",
  "scanning_disabled",
  "current_profile_snapshot_only_intermediate_revisions_may_be_coalesced",
  "retained_attribute_history_notes_and_event_content_not_scanned",
  "bounded_detector_truncation_requires_operator_repair",
  "coverage_snapshot_reconciliation_pending",
  "dead_letters_require_operator_requeue",
]);

const scanConfigSchema = scannerMetadataSchema
  .extend({
    scanner_name: z.literal("postwave-shadow-pii"),
    scanner_version: z.literal("2.0.0"),
    detector_name: z.literal("regex-heuristic"),
    detector_version: z.literal("2.0.0"),
    policy_name: z.literal("undeclared-pii-review"),
    policy_version: z.literal("sub-071-v2"),
    available: z.boolean(),
    scan_enabled: z.boolean(),
    status: z.enum([
      "enabled_backfilling",
      "enabled_caught_up",
      "enabled_degraded",
      "disabled",
      "unavailable",
    ]),
    execution_mode: z.literal("transactional_revision_outbox"),
    scheduled_scans_available: z.literal(false),
    fingerprint_scheme: z.literal("hmac-sha256-v1").optional(),
    fingerprint_key_version: activeKeyVersion.optional(),
    reliability: z.literal("at_least_once_with_dlq"),
    coverage: z.enum([
      "reconciling",
      "current_snapshot_covered",
      "known_gaps",
      "disabled",
      "unavailable",
    ]),
    coverage_limitations: z
      .array(coverageLimitationSchema)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length),
    max_scan_fields: z.literal(500),
    max_scan_field_bytes: z.literal(65_536),
    max_scan_subscriber_bytes: z.literal(4_194_304),
    max_detections_per_field: z.literal(50),
    max_detections_per_subscriber: z.literal(200),
    coverage_evidence: coverageSnapshotSchema,
    scan_schedule: z.literal("").optional(),
    updated_at: timestamp.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const hasFingerprintScheme = config.fingerprint_scheme !== undefined;
    const hasFingerprintKey = config.fingerprint_key_version !== undefined;
    const hasFingerprint = hasFingerprintScheme && hasFingerprintKey;
    const hasNoFingerprint = !hasFingerprintScheme && !hasFingerprintKey;
    const valid = !config.available
      ? config.status === "unavailable" &&
        config.coverage === "unavailable" &&
        hasNoFingerprint
      : !config.scan_enabled
        ? config.status === "disabled" &&
          config.coverage === "disabled" &&
          hasFingerprint
        : ((config.status === "enabled_backfilling" &&
            config.coverage === "reconciling") ||
            (config.status === "enabled_caught_up" &&
              config.coverage === "current_snapshot_covered") ||
            (config.status === "enabled_degraded" &&
              config.coverage === "known_gaps")) &&
          hasFingerprint;
    if (!valid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "scanner availability and status disagree",
      });
    }
    if (
      config.status === "enabled_caught_up" &&
      (!config.coverage_evidence.snapshot_exact ||
        config.coverage_evidence.status !== "caught_up" ||
        config.coverage_evidence.covered_subscribers !==
          config.coverage_evidence.total_subscribers ||
        config.coverage_evidence.pending_subscribers !== 0 ||
        config.coverage_evidence.retrying_subscribers !== 0 ||
        config.coverage_evidence.dead_letter_subscribers !== 0 ||
        config.coverage_evidence.truncated_subscribers !== 0 ||
        config.coverage_evidence.missing_state_subscribers !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coverage_evidence"],
        message: "caught-up status lacks exact gap-free evidence",
      });
    }
  });

export type PiiReviewReceipt = z.infer<typeof reviewReceiptSchema>;
export type PiiFinding = z.infer<typeof findingSchema>;
export type PiiFindingPage = z.infer<typeof findingPageSchema>;
export type PiiScanCoverageSnapshot = z.infer<typeof coverageSnapshotSchema>;
export type PiiScanConfig = z.infer<typeof scanConfigSchema>;

export interface PiiFindingListOptions {
  status?: PiiFindingStatus;
  detectedType?: PiiDetectionType;
  /** Safe metadata only: field name, exact UUID, or protected HMAC prefix. */
  query?: string;
  page?: number;
  perPage?: number;
  signal?: AbortSignal;
}

export interface PiiReviewInput {
  status: PiiTerminalStatus;
  reason: PiiReviewReason;
  comment: string;
  evidence_reference: string;
  expected_updated_at: string;
}

const FORBIDDEN_RESPONSE_KEYS = new Set([
  "rawvalue",
  "rawvaluehash",
  "matchedvalue",
  "cleartext",
  "detectedvalue",
  "subscriberemail",
  "subscribername",
]);

function canonicalKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function responseContainsForbiddenData(
  value: unknown,
  depth = 0,
  budget = { remaining: 25_000 },
): boolean {
  if (budget.remaining-- <= 0) return true;
  if (value === null || typeof value !== "object") return false;
  if (depth >= 12) return true;
  if (Array.isArray(value)) {
    return value.some((item) =>
      responseContainsForbiddenData(item, depth + 1, budget),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return true;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) =>
      FORBIDDEN_RESPONSE_KEYS.has(canonicalKey(key)) ||
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      responseContainsForbiddenData(nested, depth + 1, budget),
  );
}

function contractError(): ApiError {
  return new ApiError(
    "The PII service returned an unsafe or invalid response. No unverified findings were displayed.",
    502,
    undefined,
    { code: "invalid_pii_contract", kind: "parse" },
  );
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  if (responseContainsForbiddenData(value)) throw contractError();
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw contractError();
  return parsed.data;
}

function validatePageGeometry(
  page: PiiFindingPage,
  options: PiiFindingListOptions,
  subscriberId?: string,
): PiiFindingPage {
  const offset = (page.page - 1) * page.per_page;
  const expectedItems = Math.max(
    0,
    Math.min(page.per_page, page.total - offset),
  );
  const ids = new Set<string>();
  if (
    page.items.length !== expectedItems ||
    (page.total === 0 && page.page !== 1) ||
    (page.total > 0 && offset >= page.total) ||
    (options.page !== undefined && page.page !== options.page) ||
    (options.perPage !== undefined && page.per_page !== options.perPage)
  ) {
    throw contractError();
  }
  for (const finding of page.items) {
    if (
      ids.has(finding.id) ||
      (subscriberId !== undefined && finding.subscriber_id !== subscriberId) ||
      (options.status !== undefined && finding.status !== options.status) ||
      (options.detectedType !== undefined &&
        finding.detected_type !== options.detectedType)
    ) {
      throw contractError();
    }
    ids.add(finding.id);
  }
  return page;
}

function validateListOptions(options: PiiFindingListOptions): void {
  const query = options.query?.trim() ?? "";
  if (
    (options.status !== undefined &&
      !(PII_FINDING_STATUSES as readonly string[]).includes(options.status)) ||
    (options.detectedType !== undefined &&
      !(PII_DETECTION_TYPES as readonly string[]).includes(
        options.detectedType,
      )) ||
    Array.from(query).length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(query) ||
    piiReviewCommentContainsStrongPii(query) ||
    (options.page !== undefined &&
      (!Number.isInteger(options.page) ||
        options.page < 1 ||
        options.page > 1_000_000)) ||
    (options.perPage !== undefined &&
      (!Number.isInteger(options.perPage) ||
        options.perPage < 1 ||
        options.perPage > 200))
  ) {
    throw new ApiError("Invalid PII findings filter.", 400, undefined, {
      code: "invalid_filter",
    });
  }
}

export function piiReviewCommentContainsStrongPii(value: string): boolean {
  return (
    /\b\d{3}[- ]\d{2}[- ]\d{4}\b/u.test(value) ||
    /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/u.test(value) ||
    /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/u.test(value) ||
    /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/u.test(value) ||
    /\b[0-9A-F]{1,4}(?::[0-9A-F]{0,4}){2,7}\b/iu.test(value) ||
    /\b(?:[0-9][ -]?){12,18}[0-9]\b/u.test(value)
  );
}

export function piiRuneCount(value: string): number {
  return Array.from(value).length;
}

export function validatePiiReviewInput(input: PiiReviewInput): string | null {
  const validReason =
    input.status === "reviewed"
      ? (PII_REVIEW_REASONS as readonly string[]).includes(input.reason)
      : (PII_DISMISS_REASONS as readonly string[]).includes(input.reason);
  if (!validReason) return "Choose a reason that matches the decision.";
  if (
    input.comment !== input.comment.trim() ||
    piiRuneCount(input.comment) < 1 ||
    piiRuneCount(input.comment) > 2_000
  ) {
    return "Add a decision comment of 2,000 characters or fewer.";
  }
  if (piiReviewCommentContainsStrongPii(input.comment)) {
    return "Remove personal-data-shaped values and cite a safe evidence reference instead.";
  }
  if (
    input.evidence_reference !== input.evidence_reference.trim() ||
    !evidenceReference.safeParse(input.evidence_reference).success
  ) {
    return "Use a non-secret typed reference such as ticket:DPO-123.";
  }
  if (!timestamp.safeParse(input.expected_updated_at).success) {
    return "The finding version is invalid. Refresh before reviewing it.";
  }
  return null;
}

function queryFor(
  options: PiiFindingListOptions,
): Record<string, string | number> {
  validateListOptions(options);
  const query: Record<string, string | number> = {};
  if (options.status) query.status = options.status;
  if (options.detectedType) query.detected_type = options.detectedType;
  if (options.query?.trim()) query.q = options.query.trim();
  if (options.page) query.page = options.page;
  if (options.perPage) query.per_page = options.perPage;
  return query;
}

export async function listPiiFindings(
  options: PiiFindingListOptions = {},
): Promise<PiiFindingPage> {
  const value = await api.get<unknown>("/api/v1/pii-findings", {
    query: queryFor(options),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return validatePageGeometry(parseContract(findingPageSchema, value), options);
}

export async function listSubscriberPiiFindings(
  subscriberId: string,
  options: Omit<PiiFindingListOptions, "query"> = {},
): Promise<PiiFindingPage> {
  if (!uuid.safeParse(subscriberId).success) {
    throw new ApiError("Invalid subscriber identity.", 400, undefined, {
      code: "invalid_subscriber_id",
    });
  }
  const value = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/pii-findings`,
    {
      query: queryFor(options),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  return validatePageGeometry(
    parseContract(findingPageSchema, value),
    options,
    subscriberId,
  );
}

export async function reviewPiiFinding(
  findingId: string,
  input: PiiReviewInput,
  options?: {
    signal?: AbortSignal;
    requireOnline?: boolean;
    maxAttempts?: number;
  },
): Promise<PiiFinding> {
  if (!uuid.safeParse(findingId).success) {
    throw new ApiError("Invalid finding identity.", 400, undefined, {
      code: "invalid_finding_id",
    });
  }
  const invalid = validatePiiReviewInput(input);
  if (invalid) {
    throw new ApiError(invalid, 400, undefined, {
      code: "invalid_pii_review_input",
    });
  }
  const value = await api.patch<unknown>(
    `/api/v1/pii-findings/${encodeURIComponent(findingId)}`,
    input,
    { ...options, requireOnline: true, maxAttempts: 1 },
  );
  const finding = parseContract(findingSchema, value);
  const receipt = finding.review_receipt;
  if (
    finding.id !== findingId ||
    finding.status !== input.status ||
    !receipt ||
    receipt.status !== input.status ||
    receipt.reason !== input.reason ||
    receipt.comment !== input.comment ||
    receipt.evidence_reference !== input.evidence_reference ||
    receipt.finding_updated_at !== input.expected_updated_at
  ) {
    throw contractError();
  }
  return finding;
}

export async function getPiiScanConfig(
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<PiiScanConfig> {
  const value = await api.get<unknown>("/api/v1/pii-scan-config", {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseContract(scanConfigSchema, value);
}

export async function setPiiScanEnabled(
  scanEnabled: boolean,
  options?: {
    signal?: AbortSignal;
    requireOnline?: boolean;
    maxAttempts?: number;
  },
): Promise<PiiScanConfig> {
  const value = await api.post<unknown>(
    "/api/v1/pii-scan-config",
    { scan_enabled: scanEnabled },
    { ...options, requireOnline: true, maxAttempts: 1 },
  );
  const config = parseContract(scanConfigSchema, value);
  if (config.scan_enabled !== scanEnabled) throw contractError();
  return config;
}

export function piiFindingTypeLabel(type: PiiDetectionType): string {
  return (
    {
      ssn: "SSN",
      credit_card: "Credit card",
      date_of_birth: "Date of birth",
      passport: "Passport",
      drivers_license: "Driver's license",
      email: "Email",
      phone: "Phone",
      ip_address: "IP address",
      iban: "IBAN",
      other: "Other",
    } satisfies Record<PiiDetectionType, string>
  )[type];
}

export function piiFindingStatusLabel(status: PiiFindingStatus): string {
  if (status === "pending") return "Needs review";
  if (status === "reviewed") return "Reviewed";
  return "Dismissed";
}

export function shortPiiFingerprint(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}
