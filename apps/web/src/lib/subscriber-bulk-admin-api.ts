// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import {
  bulkUntagSubscribers,
  type BulkResult,
  type Subscriber,
  type SubscriberMutationOptions,
} from "@/lib/subscribers-api";

export const MAX_SELECTED_VALIDATION = 1_000;
export const MAX_SELECTED_MUTATION = 10_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECOVERY_TOKEN_RE = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,256}$/u;
const SAFE_EVIDENCE_TEXT_RE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

const CONSENT_CATEGORIES = [
  "essential",
  "analytics",
  "marketing",
  "email_marketing",
  "email_tracking",
  "sale_share",
  "targeted_advertising",
  "ai_processing",
  "sensitive_data",
] as const;
const CONSENT_SOURCES = [
  "double_optin",
  "single_optin",
  "preference_center",
  "signed_form",
  "direct_request",
] as const;
const CONSENT_CHANNELS = [
  "web",
  "mobile",
  "desktop",
  "email",
  "import",
  "api",
] as const;
const CONSENT_LEGAL_BASES = [
  "consent",
  "contract",
  "legitimate_interest",
  "legal_obligation",
] as const;

export type BulkConsentCategory = (typeof CONSENT_CATEGORIES)[number];
export type BulkConsentSource = (typeof CONSENT_SOURCES)[number];
export type BulkConsentChannel = (typeof CONSENT_CHANNELS)[number];
export type BulkConsentLegalBasis = (typeof CONSENT_LEGAL_BASES)[number];
export type BulkConsentMode = "grant" | "revoke";

export const BULK_CONSENT_CATEGORY_OPTIONS = CONSENT_CATEGORIES;
export const BULK_CONSENT_SOURCE_OPTIONS = CONSENT_SOURCES;
export const BULK_CONSENT_CHANNEL_OPTIONS = CONSENT_CHANNELS;
export const BULK_CONSENT_LEGAL_BASIS_OPTIONS = CONSENT_LEGAL_BASES;

export interface SelectedSubscriberTarget {
  id: string;
  email: string;
}

export interface SelectedEmailValidationResult {
  subscriber_id: string;
  email: string;
  valid: boolean;
  verdict: string;
  domain?: string;
  has_mx: boolean;
  disposable: boolean;
  role_account: boolean;
  reasons: string[];
}

export interface SelectedEmailValidationResponse {
  results: SelectedEmailValidationResult[];
  summary: { total: number; valid: number; invalid: number };
}

export interface BulkConsentEvidenceInput {
  category: BulkConsentCategory;
  source: BulkConsentSource;
  channel: BulkConsentChannel;
  legal_basis: BulkConsentLegalBasis;
  occurred_at: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policy_version: string;
}

export interface SelectedBulkOperationResult {
  requested: number;
  affected: number;
  skipped: number;
  source: "explicit_ids";
  exclusions: Record<string, number>;
  recovery_token?: string;
  recovery_until?: string;
}

export class SubscriberBulkAdminContractError extends Error {
  constructor(
    message = "The subscriber bulk service returned an invalid response.",
  ) {
    super(message);
    this.name = "SubscriberBulkAdminContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(
  value: unknown,
  max: number,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    SAFE_EVIDENCE_TEXT_RE.test(value)
  );
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function normalizedSelectedScope(
  subscribers: readonly Pick<Subscriber, "id" | "email">[],
  max: number,
): SelectedSubscriberTarget[] {
  if (subscribers.length === 0 || subscribers.length > max) {
    throw new SubscriberBulkAdminContractError(
      `Choose between 1 and ${max.toLocaleString()} explicit subscribers.`,
    );
  }
  const ids = new Set<string>();
  const emails = new Set<string>();
  const targets: SelectedSubscriberTarget[] = [];
  for (const subscriber of subscribers) {
    const id = subscriber.id?.trim().toLowerCase() ?? "";
    const email = subscriber.email.trim().toLowerCase();
    if (
      !UUID_RE.test(id) ||
      email.length === 0 ||
      email.length > 320 ||
      /[\u0000-\u0020\u007f]/u.test(email) ||
      ids.has(id) ||
      emails.has(email)
    ) {
      throw new SubscriberBulkAdminContractError(
        "The selected scope contains a missing, duplicate, or invalid subscriber identity.",
      );
    }
    ids.add(id);
    emails.add(email);
    targets.push({ id, email });
  }
  return targets;
}

export function selectedSubscriberTargets(
  subscribers: readonly Pick<Subscriber, "id" | "email">[],
  max = MAX_SELECTED_MUTATION,
): SelectedSubscriberTarget[] {
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_SELECTED_MUTATION) {
    throw new SubscriberBulkAdminContractError();
  }
  return normalizedSelectedScope(subscribers, max);
}

function parseValidationResult(
  value: unknown,
  expectedByEmail: ReadonlyMap<string, SelectedSubscriberTarget>,
): SelectedEmailValidationResult {
  if (
    !isRecord(value) ||
    !isBoundedString(value.email, 320) ||
    typeof value.valid !== "boolean" ||
    !isBoundedString(value.verdict, 64) ||
    !/^[a-z0-9_]+$/u.test(value.verdict) ||
    !(
      value.domain === undefined ||
      isBoundedString(value.domain, 253, { allowEmpty: true })
    ) ||
    typeof value.has_mx !== "boolean" ||
    typeof value.disposable !== "boolean" ||
    typeof value.role_account !== "boolean" ||
    !Array.isArray(value.reasons) ||
    value.reasons.length > 20 ||
    !value.reasons.every((reason) => isBoundedString(reason, 512))
  ) {
    throw new SubscriberBulkAdminContractError();
  }
  const email = value.email.trim().toLowerCase();
  const target = expectedByEmail.get(email);
  if (!target) throw new SubscriberBulkAdminContractError();
  return {
    subscriber_id: target.id,
    email,
    valid: value.valid,
    verdict: value.verdict,
    ...(typeof value.domain === "string" && value.domain.length > 0
      ? { domain: value.domain }
      : {}),
    has_mx: value.has_mx,
    disposable: value.disposable,
    role_account: value.role_account,
    reasons: [...value.reasons] as string[],
  };
}

export function parseSelectedEmailValidationResponse(
  value: unknown,
  targets: readonly SelectedSubscriberTarget[],
): SelectedEmailValidationResponse {
  if (
    targets.length === 0 ||
    targets.length > MAX_SELECTED_VALIDATION ||
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    value.results.length !== targets.length ||
    !isRecord(value.summary) ||
    !isCount(value.summary.total) ||
    !isCount(value.summary.valid) ||
    !isCount(value.summary.invalid)
  ) {
    throw new SubscriberBulkAdminContractError();
  }
  const expectedByEmail = new Map(targets.map((target) => [target.email, target]));
  if (expectedByEmail.size !== targets.length) {
    throw new SubscriberBulkAdminContractError();
  }
  const results = value.results.map((result) =>
    parseValidationResult(result, expectedByEmail),
  );
  if (
    new Set(results.map((result) => result.email)).size !== results.length ||
    value.summary.total !== results.length ||
    value.summary.valid !== results.filter((result) => result.valid).length ||
    value.summary.invalid !== results.filter((result) => !result.valid).length
  ) {
    throw new SubscriberBulkAdminContractError();
  }
  return {
    results,
    summary: {
      total: value.summary.total,
      valid: value.summary.valid,
      invalid: value.summary.invalid,
    },
  };
}

export async function validateSelectedSubscriberEmails(
  subscribers: readonly Pick<Subscriber, "id" | "email">[],
  options: { signal?: AbortSignal } = {},
): Promise<SelectedEmailValidationResponse> {
  const targets = normalizedSelectedScope(
    subscribers,
    MAX_SELECTED_VALIDATION,
  );
  const response = await api.post<unknown>(
    "/api/v1/email-validation/check-batch",
    { emails: targets.map((target) => target.email) },
    {
      idempotencyKey: null,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    },
  );
  return parseSelectedEmailValidationResponse(response, targets);
}

function cleanEvidenceText(
  value: string,
  field: string,
  max: number,
  required = true,
): string {
  const normalized = value.trim();
  if (
    (required && normalized.length === 0) ||
    normalized.length > max ||
    !SAFE_EVIDENCE_TEXT_RE.test(normalized)
  ) {
    throw new SubscriberBulkAdminContractError(
      `${field} must be ${required ? "present and " : ""}${max.toLocaleString()} characters or fewer.`,
    );
  }
  return normalized;
}

export function normalizeBulkConsentEvidence(
  input: BulkConsentEvidenceInput,
): BulkConsentEvidenceInput {
  if (
    !enumValue(input.category, CONSENT_CATEGORIES) ||
    !enumValue(input.source, CONSENT_SOURCES) ||
    !enumValue(input.channel, CONSENT_CHANNELS) ||
    !enumValue(input.legal_basis, CONSENT_LEGAL_BASES)
  ) {
    throw new SubscriberBulkAdminContractError(
      "Choose values from the supported consent vocabulary.",
    );
  }
  const occurred = Date.parse(input.occurred_at);
  if (
    !Number.isFinite(occurred) ||
    occurred > Date.now() + 5 * 60_000 ||
    input.occurred_at.length > 64
  ) {
    throw new SubscriberBulkAdminContractError(
      "The evidence timestamp must be a valid time that is not in the future.",
    );
  }
  const jurisdiction = input.jurisdiction.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(jurisdiction)) {
    throw new SubscriberBulkAdminContractError(
      "Jurisdiction must be a reviewed code of 32 characters or fewer.",
    );
  }
  return {
    category: input.category,
    source: input.source,
    channel: input.channel,
    legal_basis: input.legal_basis,
    occurred_at: new Date(occurred).toISOString(),
    jurisdiction,
    // Requiring evidence for revocations is deliberately stricter than the
    // server's optional field: a web bulk decision must always retain the
    // reviewed record that justified it.
    evidence: cleanEvidenceText(input.evidence, "Evidence", 2_048),
    reason: cleanEvidenceText(input.reason, "Reason", 500),
    policy_version: cleanEvidenceText(
      input.policy_version,
      "Policy version",
      100,
    ),
  };
}

function assertMutationOptions(options: SubscriberMutationOptions): void {
  if (
    typeof options.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_RE.test(options.idempotencyKey)
  ) {
    throw new SubscriberBulkAdminContractError(
      "A stable mutation identity is required.",
    );
  }
}

export function parseSelectedBulkOperationResult(
  value: unknown,
  requested: number,
): SelectedBulkOperationResult {
  if (
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    requested > MAX_SELECTED_MUTATION ||
    !isRecord(value) ||
    !isCount(value.affected) ||
    value.affected > requested ||
    value.source !== "explicit_ids" ||
    !(value.skipped === undefined || isCount(value.skipped)) ||
    !(
      value.exclusions === undefined ||
      (isRecord(value.exclusions) &&
        Object.keys(value.exclusions).length <= 32 &&
        Object.entries(value.exclusions).every(
          ([key, count]) =>
            /^[a-z0-9_]{1,64}$/u.test(key) && isCount(count),
        ))
    ) ||
    !(
      value.recovery_token === undefined ||
      (typeof value.recovery_token === "string" &&
        RECOVERY_TOKEN_RE.test(value.recovery_token))
    ) ||
    !(
      value.recovery_until === undefined ||
      (typeof value.recovery_until === "string" &&
        value.recovery_until.length <= 64 &&
        Number.isFinite(Date.parse(value.recovery_until)))
    ) ||
    (value.recovery_until !== undefined && value.recovery_token === undefined)
  ) {
    throw new SubscriberBulkAdminContractError();
  }
  const skipped = value.skipped ?? requested - value.affected;
  const exclusions = (value.exclusions ?? {}) as Record<string, number>;
  const exclusionTotal = Object.values(exclusions).reduce(
    (sum, count) => sum + count,
    0,
  );
  if (value.affected + skipped !== requested || exclusionTotal > skipped) {
    throw new SubscriberBulkAdminContractError();
  }
  return {
    requested,
    affected: value.affected,
    skipped,
    source: "explicit_ids",
    exclusions: { ...exclusions },
    ...(typeof value.recovery_token === "string"
      ? { recovery_token: value.recovery_token }
      : {}),
    ...(typeof value.recovery_until === "string"
      ? { recovery_until: value.recovery_until }
      : {}),
  };
}

export async function changeSelectedSubscriberConsent(
  subscribers: readonly Pick<Subscriber, "id" | "email">[],
  mode: BulkConsentMode,
  evidence: BulkConsentEvidenceInput,
  options: SubscriberMutationOptions,
): Promise<SelectedBulkOperationResult> {
  assertMutationOptions(options);
  const targets = normalizedSelectedScope(subscribers, MAX_SELECTED_MUTATION);
  const normalizedEvidence = normalizeBulkConsentEvidence(evidence);
  const value = await api.post<unknown>(
    `/api/v1/subscribers/bulk/${mode === "grant" ? "grant-consent" : "revoke-consent"}`,
    {
      subscriber_ids: targets.map((target) => target.id),
      ...normalizedEvidence,
    },
    {
      idempotencyKey: options.idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      signal: options.signal,
    },
  );
  return parseSelectedBulkOperationResult(value, targets.length);
}

export async function removeTagFromSelectedSubscribers(
  subscribers: readonly Pick<Subscriber, "id" | "email">[],
  tag: string,
  options: SubscriberMutationOptions,
): Promise<SelectedBulkOperationResult> {
  assertMutationOptions(options);
  const targets = normalizedSelectedScope(subscribers, MAX_SELECTED_MUTATION);
  const normalizedTag = cleanEvidenceText(tag, "Tag", 128);
  const value: BulkResult = await bulkUntagSubscribers(
    targets.map((target) => target.id),
    normalizedTag,
    options,
  );
  return parseSelectedBulkOperationResult(value, targets.length);
}
