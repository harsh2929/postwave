// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strict browser boundary for apps/api/internal/verification.
 *
 * Provider credentials are never accepted here. `credential_ref` is the
 * backend's opaque tenant-local identifier for a secret that already exists in
 * the workspace's runtime secret store. Paid-provider writes and job
 * cancellation are online-only, single-attempt operations because a timeout
 * can happen after an upstream side effect.
 */
import { api, ApiError } from "@/lib/api";

const MUTATION_OPTIONS = { requireOnline: true, maxAttempts: 1 } as const;
const VENDOR_ROUND_TRIP_TIMEOUT_MS = 45_000;
const JOB_HISTORY_LIMIT = 50;
const MAX_JOBS = 200;
const MAX_TEXT = 8_192;
const MAX_USAGE_DAYS = 366;
const MAX_JOB_ADDRESSES = 250_000;

export const VERIFICATION_PROVIDERS = ["zerobounce", "kickbox"] as const;
export const VERIFICATION_MODES = ["off", "local", "full"] as const;
export const VERIFICATION_STATUSES = [
  "valid",
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
] as const;

export type VerificationProvider = (typeof VERIFICATION_PROVIDERS)[number];
export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type VerificationJobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type VerificationJobSource =
  | "inline"
  | "upload"
  | "tag"
  | "all_subscribers";

export interface VerificationJob {
  id: string;
  status: VerificationJobStatus;
  source: VerificationJobSource;
  execution_mode: "local" | "full";
  total: number;
  processed: number;
  cache_hits: number;
  local_filtered: number;
  vendor_verified: number;
  credits_spent: number;
  duplicates: number;
  ambiguous: number;
  attempts: number;
  failure_code?: string;
  has_error: boolean;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface VerificationJobDetail {
  job: VerificationJob;
  summary: Partial<Record<VerificationStatus, number>>;
  credits_saved: number;
  credits_spent: number;
  is_terminal: boolean;
}

export interface VerificationCredits {
  /** NULL when no paid provider is configured. Not the same as zero. */
  balance: number | null;
  provider: VerificationProvider | null;
  /** Server explanation for the unconfigured/free-local case. */
  note?: string;
  balance_checked_at?: string;
  has_error: boolean;
  totals: {
    cache_hits: number;
    credits_saved: number;
    credits_spent: number;
    local_filtered: number;
    verified: number;
  };
}

export interface VerificationProviderSettings {
  ip_address?: string;
  degrade_on_failure?: boolean;
  cache_ttl_days?: number;
}

export interface VerificationProviderConfig {
  id?: string;
  provider: VerificationProvider;
  credential_ref: string;
  enabled: boolean;
  settings: VerificationProviderSettings;
  last_balance?: number;
  last_balance_at?: string;
  has_error: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface VerificationProviders {
  /** Providers advertised by this server build. */
  available: VerificationProvider[];
  /** Configured providers. At most one can be enabled. */
  providers: VerificationProviderConfig[];
}

export interface VerificationPolicyValue {
  forms_mode: VerificationMode;
  forms_reject_statuses: VerificationStatus[];
  forms_suggest_typos: boolean;
  import_mode: VerificationMode;
  updated_at?: string;
}

export interface VerificationPolicy {
  modes: VerificationMode[];
  rejectable_statuses: VerificationStatus[];
  policy: VerificationPolicyValue;
  warning?: string;
}

export interface VerificationCache {
  total: number;
  by_status: Partial<Record<VerificationStatus, number>>;
  expiring_within_7d: number;
  oldest_checked_at?: string;
  newest_checked_at?: string;
}

export interface VerificationAddressResult {
  email: string;
  status: VerificationStatus;
  sub_status?: string;
  score?: number;
  provider: string;
  billable: boolean;
  cached: boolean;
  checked_at: string;
  did_you_mean?: string;
}

export class VerificationContractError extends Error {
  readonly code = "verification_contract_invalid";

  constructor(resource: string) {
    super(`The server returned an unexpected ${resource} response.`);
    this.name = "VerificationContractError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const JOB_STATUSES = new Set<VerificationJobStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);
const JOB_SOURCES = new Set<VerificationJobSource>([
  "inline",
  "upload",
  "tag",
  "all_subscribers",
]);
const MODES = new Set<VerificationMode>(VERIFICATION_MODES);
const PROVIDERS = new Set<VerificationProvider>(VERIFICATION_PROVIDERS);
const STATUSES = new Set<VerificationStatus>(VERIFICATION_STATUSES);
const REJECTABLE_STATUSES = new Set<VerificationStatus>([
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function safeLine(
  value: unknown,
  options: { max?: number; allowEmpty?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    value.length <= (options.max ?? MAX_TEXT) &&
    !hasUnsafeControl(value) &&
    (options.allowEmpty === true || value.trim().length > 0)
  );
}

function optionalSafeLine(value: unknown, max = MAX_TEXT): boolean {
  return (
    value === undefined ||
    value === null ||
    safeLine(value, { max, allowEmpty: true })
  );
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

function optionalCount(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return value === undefined || value === null || count(value, max);
}

function timestamp(value: unknown): value is string {
  return (
    safeLine(value, { max: 40 }) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || timestamp(value);
}

function provider(value: unknown): value is VerificationProvider {
  return (
    typeof value === "string" && PROVIDERS.has(value as VerificationProvider)
  );
}

function mode(value: unknown): value is VerificationMode {
  return typeof value === "string" && MODES.has(value as VerificationMode);
}

function status(value: unknown): value is VerificationStatus {
  return typeof value === "string" && STATUSES.has(value as VerificationStatus);
}

function parseJob(value: unknown): VerificationJob {
  const row = record(value) ? value : null;
  if (
    !row ||
    !safeLine(row.id, { max: 36 }) ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.status !== "string" ||
    !JOB_STATUSES.has(row.status as VerificationJobStatus) ||
    typeof row.source !== "string" ||
    !JOB_SOURCES.has(row.source as VerificationJobSource) ||
    (row.execution_mode !== "local" && row.execution_mode !== "full") ||
    !count(row.total, MAX_JOB_ADDRESSES) ||
    !count(row.processed, MAX_JOB_ADDRESSES) ||
    !count(row.cache_hits, MAX_JOB_ADDRESSES) ||
    !count(row.local_filtered, MAX_JOB_ADDRESSES) ||
    !count(row.vendor_verified, MAX_JOB_ADDRESSES) ||
    !count(row.credits_spent, MAX_JOB_ADDRESSES) ||
    !count(row.duplicates, MAX_JOB_ADDRESSES) ||
    !count(row.ambiguous, MAX_JOB_ADDRESSES) ||
    !count(row.attempts) ||
    !optionalSafeLine(row.failure_code, 128) ||
    !optionalSafeLine(row.error) ||
    !timestamp(row.created_at) ||
    !optionalTimestamp(row.started_at) ||
    !optionalTimestamp(row.completed_at)
  ) {
    throw new VerificationContractError("verification job");
  }

  const jobStatus = row.status as VerificationJobStatus;
  const startedAt =
    typeof row.started_at === "string" ? row.started_at : undefined;
  const completedAt =
    typeof row.completed_at === "string" ? row.completed_at : undefined;
  const terminal =
    jobStatus === "completed" ||
    jobStatus === "failed" ||
    jobStatus === "canceled";
  if (
    row.processed + row.ambiguous > row.total ||
    row.cache_hits + row.local_filtered + row.vendor_verified > row.processed ||
    row.credits_spent > row.vendor_verified ||
    (jobStatus === "pending" && (startedAt || completedAt)) ||
    (jobStatus === "running" && (!startedAt || completedAt)) ||
    (terminal && !completedAt) ||
    (jobStatus === "completed" &&
      (row.processed !== row.total || row.ambiguous !== 0)) ||
    (startedAt !== undefined &&
      Date.parse(startedAt) < Date.parse(row.created_at)) ||
    (completedAt !== undefined &&
      Date.parse(completedAt) < Date.parse(startedAt ?? row.created_at))
  ) {
    throw new VerificationContractError("verification job");
  }

  return {
    id: row.id,
    status: jobStatus,
    source: row.source as VerificationJobSource,
    execution_mode: row.execution_mode,
    total: row.total,
    processed: row.processed,
    cache_hits: row.cache_hits,
    local_filtered: row.local_filtered,
    vendor_verified: row.vendor_verified,
    credits_spent: row.credits_spent,
    duplicates: row.duplicates,
    ambiguous: row.ambiguous,
    attempts: row.attempts,
    ...(typeof row.failure_code === "string" && row.failure_code
      ? { failure_code: row.failure_code }
      : {}),
    has_error: typeof row.error === "string" && row.error.trim().length > 0,
    created_at: row.created_at,
    ...(startedAt ? { started_at: startedAt } : {}),
    ...(completedAt ? { completed_at: completedAt } : {}),
  };
}

export async function listVerificationJobs(
  options: { signal?: AbortSignal; fresh?: boolean; limit?: number } = {},
): Promise<VerificationJob[]> {
  const limit = options.limit ?? JOB_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOBS) {
    throw new Error("Verification job limit must be between 1 and 200.");
  }
  const value = await api.get<unknown>(
    `/api/v1/verification/jobs?limit=${encodeURIComponent(String(limit))}`,
    {
      signal: options.signal,
      ...(options.fresh ? MUTATION_OPTIONS : {}),
    },
  );
  if (
    !record(value) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > limit
  ) {
    throw new VerificationContractError("verification jobs");
  }
  const jobs = value.jobs.map(parseJob);
  const ids = new Set<string>();
  let previousCreatedAt = Number.POSITIVE_INFINITY;
  for (const job of jobs) {
    const createdAt = Date.parse(job.created_at);
    if (ids.has(job.id) || createdAt > previousCreatedAt) {
      throw new VerificationContractError("verification jobs");
    }
    ids.add(job.id);
    previousCreatedAt = createdAt;
  }
  return jobs;
}

export async function getVerificationJob(
  id: string,
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<VerificationJobDetail> {
  if (!UUID_PATTERN.test(id))
    throw new Error("Verification job id is invalid.");
  const value = await api.get<unknown>(
    `/api/v1/verification/jobs/${encodeURIComponent(id)}`,
    {
      signal: options.signal,
      ...(options.fresh ? MUTATION_OPTIONS : {}),
    },
  );
  if (
    !record(value) ||
    !record(value.summary) ||
    Object.keys(value.summary).length > VERIFICATION_STATUSES.length ||
    !count(value.credits_saved, MAX_JOB_ADDRESSES) ||
    !count(value.credits_spent, MAX_JOB_ADDRESSES) ||
    typeof value.is_terminal !== "boolean"
  ) {
    throw new VerificationContractError("verification job detail");
  }
  const job = parseJob(value.job);
  if (job.id !== id)
    throw new VerificationContractError("verification job detail");
  const summary: Partial<Record<VerificationStatus, number>> = {};
  let summarized = 0;
  for (const [key, rawCount] of Object.entries(value.summary)) {
    if (!status(key) || !count(rawCount, MAX_JOB_ADDRESSES)) {
      throw new VerificationContractError("verification job detail");
    }
    summarized += rawCount;
    if (!Number.isSafeInteger(summarized)) {
      throw new VerificationContractError("verification job detail");
    }
    summary[key] = rawCount;
  }
  const terminal =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "canceled";
  if (
    summarized > job.processed ||
    (job.status === "completed" && summarized !== job.processed) ||
    value.credits_spent !== job.credits_spent ||
    value.credits_saved !== Math.max(0, job.processed - job.credits_spent) ||
    value.is_terminal !== terminal
  ) {
    throw new VerificationContractError("verification job detail");
  }
  return {
    job,
    summary,
    credits_saved: value.credits_saved,
    credits_spent: value.credits_spent,
    is_terminal: value.is_terminal,
  };
}

export async function getVerificationCredits(
  options: { signal?: AbortSignal } = {},
): Promise<VerificationCredits> {
  const value = await api.get<unknown>("/api/v1/verification/credits", {
    ...MUTATION_OPTIONS,
    timeoutMs: VENDOR_ROUND_TRIP_TIMEOUT_MS,
    signal: options.signal,
  });
  if (!record(value) || !record(value.totals) || !Array.isArray(value.usage)) {
    throw new VerificationContractError("verification credits");
  }
  const totals = value.totals;
  const verified = totals.verified;
  const creditsSpent = totals.credits_spent;
  const localFiltered = totals.local_filtered;
  const cacheHits = totals.cache_hits;
  const creditsSaved = totals.credits_saved;
  if (
    !count(verified) ||
    !count(creditsSpent) ||
    !count(localFiltered) ||
    !count(cacheHits) ||
    !count(creditsSaved) ||
    creditsSpent > verified ||
    creditsSaved !== verified - creditsSpent
  ) {
    throw new VerificationContractError("verification credit totals");
  }
  if (value.usage.length > MAX_USAGE_DAYS) {
    throw new VerificationContractError("verification credit usage");
  }
  if (
    !(value.provider === null || provider(value.provider)) ||
    !(value.balance === null || value.balance === -1 || count(value.balance)) ||
    !optionalTimestamp(value.balance_checked_at) ||
    !optionalSafeLine(value.last_error) ||
    !optionalSafeLine(value.note) ||
    (value.provider === null &&
      (value.balance !== null || value.balance_checked_at !== undefined))
  ) {
    throw new VerificationContractError("verification credit provider");
  }
  const summed = {
    verified: 0,
    credits_spent: 0,
    local_filtered: 0,
    cache_hits: 0,
  };
  const seen = new Set<string>();
  const usageProviders = new Set<string>(["local", ...VERIFICATION_PROVIDERS]);
  for (const raw of value.usage) {
    if (!record(raw)) {
      throw new VerificationContractError("verification credits");
    }
    const rowVerified = raw.verified;
    const rowCreditsSpent = raw.credits_spent;
    const rowLocalFiltered = raw.local_filtered;
    const rowCacheHits = raw.cache_hits;
    if (
      !safeLine(raw.day, { max: 10 }) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(raw.day) ||
      !safeLine(raw.provider, { max: 64 }) ||
      !usageProviders.has(raw.provider) ||
      !count(rowVerified) ||
      !count(rowCreditsSpent) ||
      !count(rowLocalFiltered) ||
      !count(rowCacheHits) ||
      rowCreditsSpent > rowVerified ||
      rowLocalFiltered > rowVerified ||
      rowCacheHits > rowVerified
    ) {
      throw new VerificationContractError("verification credits");
    }
    const key = `${raw.day}:${raw.provider}`;
    if (seen.has(key))
      throw new VerificationContractError("verification credits");
    seen.add(key);
    summed.verified += rowVerified;
    summed.credits_spent += rowCreditsSpent;
    summed.local_filtered += rowLocalFiltered;
    summed.cache_hits += rowCacheHits;
  }
  if (
    summed.verified !== verified ||
    summed.credits_spent !== creditsSpent ||
    summed.local_filtered !== localFiltered ||
    summed.cache_hits !== cacheHits
  ) {
    throw new VerificationContractError("verification credits");
  }
  return {
    balance: value.balance,
    provider: value.provider,
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.balance_checked_at === "string"
      ? { balance_checked_at: value.balance_checked_at }
      : {}),
    has_error:
      typeof value.last_error === "string" &&
      value.last_error.trim().length > 0,
    totals: {
      verified,
      credits_spent: creditsSpent,
      local_filtered: localFiltered,
      cache_hits: cacheHits,
      credits_saved: creditsSaved,
    },
  };
}

function parseProviderSettings(value: unknown): VerificationProviderSettings {
  if (!record(value)) {
    throw new VerificationContractError("verification provider settings");
  }
  const allowed = new Set([
    "ip_address",
    "degrade_on_failure",
    "cache_ttl_days",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !optionalSafeLine(value.ip_address, 64) ||
    !(
      value.degrade_on_failure === undefined ||
      typeof value.degrade_on_failure === "boolean"
    ) ||
    !optionalCount(value.cache_ttl_days, 180)
  ) {
    throw new VerificationContractError("verification provider settings");
  }
  return {
    ...(typeof value.ip_address === "string" && value.ip_address
      ? { ip_address: value.ip_address }
      : {}),
    ...(typeof value.degrade_on_failure === "boolean"
      ? { degrade_on_failure: value.degrade_on_failure }
      : {}),
    ...(typeof value.cache_ttl_days === "number"
      ? { cache_ttl_days: value.cache_ttl_days }
      : {}),
  };
}

function parseProvider(value: unknown): VerificationProviderConfig {
  if (
    !record(value) ||
    !(
      value.id === undefined ||
      (safeLine(value.id, { max: 36 }) && UUID_PATTERN.test(value.id))
    ) ||
    !provider(value.provider) ||
    !safeLine(value.credential_ref, { max: 128 }) ||
    !CREDENTIAL_REF_PATTERN.test(value.credential_ref) ||
    typeof value.enabled !== "boolean" ||
    !(value.last_balance === -1 || optionalCount(value.last_balance)) ||
    !optionalTimestamp(value.last_balance_at) ||
    !optionalSafeLine(value.last_error) ||
    !optionalTimestamp(value.last_error_at) ||
    !optionalTimestamp(value.created_at) ||
    !optionalTimestamp(value.updated_at)
  ) {
    throw new VerificationContractError("verification provider");
  }
  const settings = parseProviderSettings(value.settings);
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    provider: value.provider,
    credential_ref: value.credential_ref,
    enabled: value.enabled,
    settings,
    ...(typeof value.last_balance === "number"
      ? { last_balance: value.last_balance }
      : {}),
    ...(typeof value.last_balance_at === "string"
      ? { last_balance_at: value.last_balance_at }
      : {}),
    has_error:
      typeof value.last_error === "string" &&
      value.last_error.trim().length > 0,
    ...(typeof value.created_at === "string"
      ? { created_at: value.created_at }
      : {}),
    ...(typeof value.updated_at === "string"
      ? { updated_at: value.updated_at }
      : {}),
  };
}

export async function getVerificationProviders(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<VerificationProviders> {
  const value = await api.get<unknown>("/api/v1/verification/providers", {
    signal: options.signal,
    ...(options.fresh ? MUTATION_OPTIONS : {}),
  });
  if (
    !record(value) ||
    !Array.isArray(value.available) ||
    value.available.length !== VERIFICATION_PROVIDERS.length ||
    !value.available.every(provider) ||
    new Set(value.available).size !== value.available.length ||
    !Array.isArray(value.providers) ||
    value.providers.length > VERIFICATION_PROVIDERS.length
  ) {
    throw new VerificationContractError("verification providers");
  }
  const available = value.available as VerificationProvider[];
  const providers = value.providers.map(parseProvider);
  if (
    new Set(providers.map((entry) => entry.provider)).size !==
      providers.length ||
    providers.filter((entry) => entry.enabled).length > 1 ||
    providers.some((entry) => !available.includes(entry.provider))
  ) {
    throw new VerificationContractError("verification providers");
  }
  return {
    available,
    providers,
  };
}

function parsePolicyValue(value: unknown): VerificationPolicyValue {
  if (
    !record(value) ||
    !mode(value.forms_mode) ||
    !Array.isArray(value.forms_reject_statuses) ||
    value.forms_reject_statuses.length < 1 ||
    value.forms_reject_statuses.length > VERIFICATION_STATUSES.length ||
    !value.forms_reject_statuses.every(
      (item) => status(item) && REJECTABLE_STATUSES.has(item),
    ) ||
    new Set(value.forms_reject_statuses).size !==
      value.forms_reject_statuses.length ||
    !(
      value.forms_suggest_typos === undefined ||
      typeof value.forms_suggest_typos === "boolean"
    ) ||
    !mode(value.import_mode) ||
    !optionalTimestamp(value.updated_at)
  ) {
    throw new VerificationContractError("verification policy");
  }
  return {
    forms_mode: value.forms_mode,
    forms_reject_statuses: value.forms_reject_statuses,
    forms_suggest_typos:
      typeof value.forms_suggest_typos === "boolean"
        ? value.forms_suggest_typos
        : true,
    import_mode: value.import_mode,
    ...(typeof value.updated_at === "string"
      ? { updated_at: value.updated_at }
      : {}),
  };
}

function parsePolicyEnvelope(
  value: unknown,
  requireMetadata: boolean,
): VerificationPolicy {
  if (!record(value))
    throw new VerificationContractError("verification policy");
  const policyValue = parsePolicyValue(value.policy);
  if (!optionalSafeLine(value.warning)) {
    throw new VerificationContractError("verification policy");
  }
  const modes = value.modes;
  const rejectable = value.rejectable_statuses;
  if (
    requireMetadata &&
    (!Array.isArray(modes) || !Array.isArray(rejectable))
  ) {
    throw new VerificationContractError("verification policy");
  }
  if (
    modes !== undefined &&
    (!Array.isArray(modes) ||
      modes.length !== VERIFICATION_MODES.length ||
      !modes.every(mode) ||
      new Set(modes).size !== modes.length)
  ) {
    throw new VerificationContractError("verification policy");
  }
  if (
    rejectable !== undefined &&
    (!Array.isArray(rejectable) ||
      rejectable.length < 1 ||
      rejectable.length > VERIFICATION_STATUSES.length ||
      !rejectable.every(
        (item) => status(item) && REJECTABLE_STATUSES.has(item),
      ) ||
      new Set(rejectable).size !== rejectable.length)
  ) {
    throw new VerificationContractError("verification policy");
  }
  return {
    modes: (modes ?? []) as VerificationMode[],
    rejectable_statuses: (rejectable ?? []) as VerificationStatus[],
    policy: policyValue,
    ...(typeof value.warning === "string" && value.warning
      ? { warning: value.warning }
      : {}),
  };
}

export async function getVerificationPolicy(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<VerificationPolicy> {
  return parsePolicyEnvelope(
    await api.get<unknown>("/api/v1/verification/policy", {
      signal: options.signal,
      ...(options.fresh ? MUTATION_OPTIONS : {}),
    }),
    true,
  );
}

export async function saveVerificationProvider(
  providerName: VerificationProvider,
  input: {
    credential_ref: string;
    enabled: boolean;
    settings: VerificationProviderSettings;
  },
  signal?: AbortSignal,
): Promise<VerificationProviderConfig> {
  if (!provider(providerName))
    throw new Error("Verification provider is invalid.");
  const credentialRef = input.credential_ref.trim();
  if (!CREDENTIAL_REF_PATTERN.test(credentialRef)) {
    throw new Error(
      "Credential reference must be 1–128 letters, digits, dots, dashes, or underscores.",
    );
  }
  if (
    input.settings.cache_ttl_days !== undefined &&
    !count(input.settings.cache_ttl_days, 180)
  ) {
    throw new Error("Cache TTL must be between 0 and 180 days.");
  }
  if (
    input.settings.ip_address !== undefined &&
    (!safeLine(input.settings.ip_address, { max: 64, allowEmpty: true }) ||
      input.settings.ip_address !== input.settings.ip_address.trim())
  ) {
    throw new Error("Provider IP address must be a bounded single-line value.");
  }
  return parseProvider(
    await api.put<unknown>(
      `/api/v1/verification/providers/${encodeURIComponent(providerName)}`,
      {
        credential_ref: credentialRef,
        enabled: input.enabled,
        settings: input.settings,
      },
      {
        ...MUTATION_OPTIONS,
        timeoutMs: VENDOR_ROUND_TRIP_TIMEOUT_MS,
        signal,
      },
    ),
  );
}

export async function deleteVerificationProvider(
  providerName: VerificationProvider,
  signal?: AbortSignal,
): Promise<void> {
  if (!provider(providerName))
    throw new Error("Verification provider is invalid.");
  await api.delete<void>(
    `/api/v1/verification/providers/${encodeURIComponent(providerName)}`,
    { ...MUTATION_OPTIONS, signal },
  );
}

export async function saveVerificationPolicy(
  policy: Omit<VerificationPolicyValue, "updated_at">,
  signal?: AbortSignal,
): Promise<VerificationPolicy> {
  return parsePolicyEnvelope(
    await api.put<unknown>("/api/v1/verification/policy", policy, {
      ...MUTATION_OPTIONS,
      signal,
    }),
    false,
  );
}

/**
 * Verify one address under a caller-owned billing intent. The caller must keep
 * the same key for an intentional exact retry after an uncertain response.
 */
export function verifyAddress(
  email: string,
  idempotencyKey: string,
): Promise<VerificationAddressResult> {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ||
    !UUID_PATTERN.test(idempotencyKey)
  ) {
    throw new Error("Verification address or idempotency key is invalid.");
  }
  return api.post<unknown>(
    "/api/v1/verification/verify",
    { email: normalized },
    {
      idempotencyKey,
      maxAttempts: 1,
      requireOnline: true,
      timeoutMs: VENDOR_ROUND_TRIP_TIMEOUT_MS,
    },
  ).then(parseVerificationAddressResult);
}

/** Retain the exact billing key whenever dispatch may have crossed the wire. */
export function retainVerifyAddressAttemptKey(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.status === 0 || error.status >= 500) return true;
  return (
    error.status === 409 &&
    (error.code === "verification_provider_outcome_ambiguous" ||
      error.code === "verification_usage_outcome_ambiguous" ||
      error.code === "idempotency_key_in_progress")
  );
}

function parseVerificationAddressResult(value: unknown): VerificationAddressResult {
  if (!record(value)) throw new VerificationContractError("address verification");
  const status = value.status;
  if (
    !safeLine(value.email, { max: 254 }) ||
    typeof status !== "string" ||
    !STATUSES.has(status as VerificationStatus) ||
    !safeLine(value.provider, { max: 128 }) ||
    !safeLine(value.checked_at, { max: 64 }) ||
    !optionalSafeLine(value.sub_status, 128) ||
    !optionalSafeLine(value.did_you_mean, 254) ||
    (value.score !== undefined &&
      (typeof value.score !== "number" || value.score < 0 || value.score > 10)) ||
    typeof value.billable !== "boolean" ||
    typeof value.cached !== "boolean"
  ) {
    throw new VerificationContractError("address verification");
  }
  return {
    email: value.email,
    status: status as VerificationStatus,
    provider: value.provider,
    billable: value.billable,
    cached: value.cached,
    checked_at: value.checked_at,
    ...(typeof value.sub_status === "string" && value.sub_status
      ? { sub_status: value.sub_status }
      : {}),
    ...(typeof value.did_you_mean === "string" && value.did_you_mean
      ? { did_you_mean: value.did_you_mean }
      : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
  };
}

/** Cancel is POST, and can make an already-dispatched attempt ambiguous. */
export async function cancelVerificationJob(
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!UUID_PATTERN.test(id))
    throw new Error("Verification job id is invalid.");
  await api.post<void>(
    `/api/v1/verification/jobs/${encodeURIComponent(id)}/cancel`,
    undefined,
    { ...MUTATION_OPTIONS, signal },
  );
}

export async function getVerificationCache(
  options: { signal?: AbortSignal } = {},
): Promise<VerificationCache> {
  const value = await api.get<unknown>("/api/v1/verification/cache", options);
  const byStatus =
    record(value) && record(value.by_status) ? value.by_status : null;
  if (
    !record(value) ||
    !byStatus ||
    Object.keys(byStatus).length > VERIFICATION_STATUSES.length ||
    !count(value.total, MAX_JOB_ADDRESSES) ||
    !count(value.expiring_within_7d, MAX_JOB_ADDRESSES) ||
    value.expiring_within_7d > value.total ||
    !optionalTimestamp(value.oldest_checked_at) ||
    !optionalTimestamp(value.newest_checked_at)
  ) {
    throw new VerificationContractError("verification cache");
  }
  let summarized = 0;
  const parsed: Partial<Record<VerificationStatus, number>> = {};
  for (const [key, rawCount] of Object.entries(byStatus)) {
    if (!status(key) || !count(rawCount, MAX_JOB_ADDRESSES)) {
      throw new VerificationContractError("verification cache");
    }
    summarized += rawCount;
    parsed[key] = rawCount;
  }
  if (summarized !== value.total) {
    throw new VerificationContractError("verification cache");
  }
  return {
    total: value.total,
    by_status: parsed,
    expiring_within_7d: value.expiring_within_7d,
    ...(typeof value.oldest_checked_at === "string"
      ? { oldest_checked_at: value.oldest_checked_at }
      : {}),
    ...(typeof value.newest_checked_at === "string"
      ? { newest_checked_at: value.newest_checked_at }
      : {}),
  };
}

export function sameVerificationProviderRevision(
  left: VerificationProviderConfig | undefined,
  right: VerificationProviderConfig | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.provider === right.provider &&
    left.credential_ref === right.credential_ref &&
    left.enabled === right.enabled &&
    JSON.stringify(left.settings) === JSON.stringify(right.settings)
  );
}

export function sameVerificationPolicyRevision(
  left: VerificationPolicyValue,
  right: VerificationPolicyValue,
): boolean {
  return (
    left.forms_mode === right.forms_mode &&
    left.import_mode === right.import_mode &&
    left.forms_suggest_typos === right.forms_suggest_typos &&
    left.updated_at === right.updated_at &&
    left.forms_reject_statuses.length === right.forms_reject_statuses.length &&
    left.forms_reject_statuses.every(
      (item, index) => item === right.forms_reject_statuses[index],
    )
  );
}

export function sameVerificationJobRevision(
  left: VerificationJob,
  right: VerificationJob,
): boolean {
  return (
    left.id === right.id &&
    left.status === right.status &&
    left.processed === right.processed &&
    left.ambiguous === right.ambiguous &&
    left.attempts === right.attempts &&
    left.started_at === right.started_at &&
    left.completed_at === right.completed_at
  );
}

// ---------------------------------------------------------------------------
// Bulk jobs: creation and the per-address result ledger.
//
// POST /api/v1/verification/jobs is a billable write behind an explicit server
// release gate. When the gate is closed the server answers 503 with its own
// sentence; callers render that sentence and never invent one. The request is
// idempotent under a caller-owned key so an uncertain transport outcome can be
// retried without authorising a second billable run.
// ---------------------------------------------------------------------------

const JOB_CREATE_TIMEOUT_MS = 30_000;
const MAX_JOB_EMAIL_LENGTH = 320;
const MAX_JOB_SOURCE_REF_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_RESULT_SCORE = 10;
/** Server caps `limit` at 1000; one extra row is requested to derive has_more. */
const MAX_RESULT_PAGE_SIZE = 999;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const VERIFICATION_RESULT_PAGE_SIZE = 100;
export const VERIFICATION_JOB_CREATE_SOURCES = [
  "inline",
  "tag",
  "all_subscribers",
] as const;
export const VERIFICATION_ATTEMPT_STATES = [
  "pending",
  "leased",
  "succeeded",
  "ambiguous",
] as const;

export type VerificationJobCreateSource =
  (typeof VERIFICATION_JOB_CREATE_SOURCES)[number];
export type VerificationAttemptState =
  (typeof VERIFICATION_ATTEMPT_STATES)[number];

/** Exactly the shapes `createJobRequest` accepts, one per source. */
export type CreateVerificationJobInput =
  | { source: "inline"; emails: string[] }
  | { source: "tag"; source_ref: string }
  | { source: "all_subscribers" };

export interface VerificationJobResult {
  email: string;
  processed: boolean;
  status: VerificationStatus;
  sub_status?: string;
  score?: number;
  provider?: string;
  billable: boolean;
  cached: boolean;
  did_you_mean?: string;
  checked_at?: string;
  attempt_state: VerificationAttemptState;
}

export interface VerificationJobResultsPage {
  results: VerificationJobResult[];
  offset: number;
  page_size: number;
  /** True when the server holds at least one more row past this page. */
  has_more: boolean;
}

export interface VerificationAddressList {
  /** Normalised (trimmed, lower-cased) unique addresses in first-seen order. */
  emails: string[];
  /** Entries that do not look like an address, verbatim, for the operator. */
  invalid: string[];
  /** Entries dropped because an equal address appeared earlier. */
  duplicates: number;
}

const ATTEMPT_STATES = new Set<VerificationAttemptState>(
  VERIFICATION_ATTEMPT_STATES,
);

/**
 * Split pasted text into addresses. Separators are line breaks, commas,
 * semicolons, and whitespace; case is folded because the server normalises it
 * anyway and a second casing of one address must not count as a second entry.
 */
export function parseVerificationAddressList(
  text: string,
): VerificationAddressList {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const raw of text.split(/[\s,;]+/u)) {
    const entry = raw.trim();
    if (!entry) continue;
    const normalized = entry.toLowerCase();
    if (
      normalized.length > MAX_JOB_EMAIL_LENGTH ||
      hasUnsafeControl(normalized) ||
      !EMAIL_SHAPE.test(normalized)
    ) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    emails.push(normalized);
  }
  return { emails, invalid, duplicates };
}

function validJobIdempotencyKey(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    value === value.trim() &&
    !hasUnsafeControl(value)
  );
}

/**
 * Build the exact request body for `POST /api/v1/verification/jobs`, applying
 * the server's own validation first so a rejected draft never spends a key.
 */
export function verificationJobRequestBody(
  input: CreateVerificationJobInput,
): CreateVerificationJobInput {
  switch (input.source) {
    case "inline": {
      if (input.emails.length === 0) {
        throw new Error("A pasted-address run needs at least one address.");
      }
      if (input.emails.length > MAX_JOB_ADDRESSES) {
        throw new Error(
          `A run accepts at most ${MAX_JOB_ADDRESSES.toLocaleString()} addresses.`,
        );
      }
      const emails: string[] = [];
      const seen = new Set<string>();
      for (const raw of input.emails) {
        const email = raw.trim().toLowerCase();
        if (
          !safeLine(email, { max: MAX_JOB_EMAIL_LENGTH }) ||
          !EMAIL_SHAPE.test(email)
        ) {
          throw new Error(
            "Every address must be a single well-formed email of at most 320 characters.",
          );
        }
        if (seen.has(email)) continue;
        seen.add(email);
        emails.push(email);
      }
      return { source: "inline", emails };
    }
    case "tag": {
      const sourceRef = input.source_ref.trim();
      if (!safeLine(sourceRef, { max: MAX_JOB_SOURCE_REF_LENGTH })) {
        throw new Error(
          "A tag run needs one exact tag of at most 512 characters.",
        );
      }
      return { source: "tag", source_ref: sourceRef };
    }
    case "all_subscribers":
      return { source: "all_subscribers" };
    default:
      throw new Error("Verification job source is invalid.");
  }
}

/**
 * Start a durable bulk run. The receipt is the canonical job row; a receipt
 * whose source differs from the request means an intermediary rewrote it and
 * the caller must not treat the run as the one it asked for.
 */
export async function createVerificationJob(
  input: CreateVerificationJobInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<VerificationJob> {
  if (!validJobIdempotencyKey(idempotencyKey)) {
    throw new Error("Verification job idempotency key is invalid.");
  }
  const body = verificationJobRequestBody(input);
  const value = await api.post<unknown>("/api/v1/verification/jobs", body, {
    idempotencyKey,
    maxAttempts: 1,
    requireOnline: true,
    timeoutMs: JOB_CREATE_TIMEOUT_MS,
    signal,
  });
  const job = parseJob(value);
  if (job.source !== body.source) {
    throw new VerificationContractError("verification job receipt");
  }
  return job;
}

/**
 * Whether an unchanged run request must keep its billing key. Same rule as a
 * single verification: anything that may have crossed the wire is retained,
 * an explicit pre-charge rejection is not.
 */
export function retainVerificationJobAttemptKey(error: unknown): boolean {
  return retainVerifyAddressAttemptKey(error);
}

function parseJobResult(value: unknown): VerificationJobResult {
  if (
    !record(value) ||
    !safeLine(value.email, { max: MAX_JOB_EMAIL_LENGTH }) ||
    !value.email.includes("@") ||
    typeof value.processed !== "boolean" ||
    !status(value.status) ||
    typeof value.attempt_state !== "string" ||
    !ATTEMPT_STATES.has(value.attempt_state as VerificationAttemptState) ||
    !optionalSafeLine(value.sub_status, 128) ||
    !optionalSafeLine(value.provider, 128) ||
    !optionalSafeLine(value.did_you_mean, MAX_JOB_EMAIL_LENGTH) ||
    !optionalTimestamp(value.checked_at) ||
    !(value.score === undefined || value.score === null || count(value.score, MAX_RESULT_SCORE)) ||
    typeof value.billable !== "boolean" ||
    typeof value.cached !== "boolean" ||
    (value.billable && value.cached)
  ) {
    throw new VerificationContractError("verification job result");
  }
  const attemptState = value.attempt_state as VerificationAttemptState;
  const checkedAt =
    typeof value.checked_at === "string" ? value.checked_at : undefined;
  // Mirror the server's stored-row invariants: an unprocessed row carries no
  // verdict evidence, and a processed row must say when it was checked.
  if (
    (attemptState === "succeeded") !== value.processed ||
    (value.processed && !checkedAt) ||
    (!value.processed &&
      (value.status !== "unknown" || value.billable || value.cached || checkedAt))
  ) {
    throw new VerificationContractError("verification job result");
  }
  return {
    email: value.email,
    processed: value.processed,
    status: value.status,
    ...(typeof value.sub_status === "string" && value.sub_status
      ? { sub_status: value.sub_status }
      : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.provider === "string" && value.provider
      ? { provider: value.provider }
      : {}),
    billable: value.billable,
    cached: value.cached,
    ...(typeof value.did_you_mean === "string" && value.did_you_mean
      ? { did_you_mean: value.did_you_mean }
      : {}),
    ...(checkedAt ? { checked_at: checkedAt } : {}),
    attempt_state: attemptState,
  };
}

/**
 * One page of per-address rows for a job. The server pages by offset and has
 * no total, so one extra row is requested and used only to decide has_more.
 */
export async function listVerificationJobResults(
  id: string,
  options: {
    status?: VerificationStatus | "";
    offset?: number;
    pageSize?: number;
    signal?: AbortSignal;
  } = {},
): Promise<VerificationJobResultsPage> {
  if (!UUID_PATTERN.test(id))
    throw new Error("Verification job id is invalid.");
  const pageSize = options.pageSize ?? VERIFICATION_RESULT_PAGE_SIZE;
  const offset = options.offset ?? 0;
  if (!count(pageSize, MAX_RESULT_PAGE_SIZE) || pageSize < 1) {
    throw new Error("Verification result page size must be between 1 and 999.");
  }
  if (!count(offset, MAX_JOB_ADDRESSES)) {
    throw new Error("Verification result offset is invalid.");
  }
  const filter = options.status ? options.status : undefined;
  if (filter !== undefined && !status(filter)) {
    throw new Error("Verification result status filter is invalid.");
  }
  const limit = pageSize + 1;
  const value = await api.get<unknown>(
    `/api/v1/verification/jobs/${encodeURIComponent(id)}/results?limit=${limit}&offset=${offset}${
      filter ? `&status=${encodeURIComponent(filter)}` : ""
    }`,
    { signal: options.signal },
  );
  if (
    !record(value) ||
    !Array.isArray(value.results) ||
    value.results.length > limit
  ) {
    throw new VerificationContractError("verification job results");
  }
  const rows = value.results.map(parseJobResult);
  if (filter && rows.some((row) => row.status !== filter)) {
    throw new VerificationContractError("verification job results");
  }
  return {
    results: rows.slice(0, pageSize),
    offset,
    page_size: pageSize,
    has_more: rows.length > pageSize,
  };
}
