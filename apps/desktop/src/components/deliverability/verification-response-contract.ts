import type {
  CreditsSummary,
  EmailHealth,
  EmailHealthBatchResponse,
  EmailHealthEvidence,
  EmailHealthEvidenceKind,
  EmailHealthGrade,
  EmailHealthRecommendation,
  JobDetail,
  JobItem,
  JobSource,
  JobStatus,
  ProviderSettings,
  VerificationJob,
  VerificationMode,
  VerificationPolicy,
  VerificationProvider,
  VerificationStatus,
} from "../../lib/api/verification";

const MAX_ROWS = 1_000;
const MAX_TEXT = 8_192;
const MAX_REFERENCE = 128;
const MAX_EMAIL = 320;
const MAX_PROVIDER_NAME = 64;
const MAX_USAGE_DAYS = 366;
const MAX_HEALTH_REASONS = 64;
const MAX_HEALTH_EVIDENCE = 512;

const PROVIDERS = new Set<VerificationProvider>(["zerobounce", "kickbox"]);
const USAGE_PROVIDERS = new Set(["local", ...PROVIDERS]);
const MODES = new Set<VerificationMode>(["off", "local", "full"]);
const STATUSES = new Set<VerificationStatus>([
  "valid",
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
]);
const REJECTABLE_STATUSES = new Set<VerificationStatus>([
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
]);
const JOB_STATUSES = new Set<JobStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
]);
const JOB_SOURCES = new Set<JobSource>([
  "inline",
  "upload",
  "tag",
  "all_subscribers",
]);
const HEALTH_GRADES = new Set<EmailHealthGrade>(["A", "B", "C", "D", "F", "U"]);
const HEALTH_RECOMMENDATIONS = new Set<EmailHealthRecommendation>([
  "send",
  "caution",
  "do_not_send",
  "blocked",
]);
const HEALTH_EVIDENCE_KINDS = new Set<EmailHealthEvidenceKind>([
  "hard_bounce",
  "complaint",
  "soft_bounce",
  "ambiguous_negative",
  "vendor_activity",
  "reply",
  "click",
  "delivered",
  "open",
  "hard_stop",
]);
const ATTEMPT_STATES = new Set(["pending", "leased", "succeeded", "ambiguous"]);

export interface VerificationProviderView {
  provider: VerificationProvider;
  credential_ref: string;
  enabled: boolean;
  settings: ProviderSettings;
  last_balance?: number;
  last_balance_at?: string;
  has_error: boolean;
}

export interface VerificationProvidersView {
  providers: VerificationProviderView[];
  available: VerificationProvider[];
}

export interface VerificationCreditsView {
  totals: CreditsSummary["totals"];
  provider: VerificationProvider | null;
  balance: number | null;
  balance_checked_at?: string;
  has_error: boolean;
}

/**
 * The list view deliberately drops source_ref, provider, and raw error text.
 * Those values are not needed to select a run and can contain tenant or
 * infrastructure detail. The server's error is reduced to a boolean status.
 */
export interface VerificationJobView extends Omit<
  VerificationJob,
  "error" | "source_ref" | "provider"
> {
  has_error: boolean;
}

export interface VerificationJobsView {
  rows: VerificationJobView[];
  limit_reached: boolean;
}

export interface VerificationJobDetailView extends Omit<JobDetail, "job"> {
  job: VerificationJobView;
}

export interface VerificationResultView extends Omit<
  JobItem,
  "email" | "sub_status" | "did_you_mean" | "provider" | "health"
> {
  row_key: string;
  masked_email: string;
  masked_suggestion?: string;
  health?: Omit<EmailHealth, "email" | "evidence"> & {
    evidence_count: number;
  };
}

export interface VerificationResultsView {
  rows: VerificationResultView[];
  has_more: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isSafeLine(
  value: unknown,
  options: { allowEmpty?: boolean; max?: number } = {},
): value is string {
  const max = options.max ?? MAX_TEXT;
  return (
    typeof value === "string" &&
    value.length <= max &&
    !hasUnsafeControl(value) &&
    (options.allowEmpty === true || value.trim().length > 0)
  );
}

function isOptionalSafeLine(value: unknown, max = MAX_TEXT): boolean {
  return (
    value === undefined ||
    value === null ||
    isSafeLine(value, { allowEmpty: true, max })
  );
}

function isUUID(value: unknown): value is string {
  return (
    isSafeLine(value, { max: 36 }) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isOptionalUUID(value: unknown): boolean {
  return value === undefined || value === null || isUUID(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || value === null || isCount(value);
}

function isOptionalBoundedCount(value: unknown, max: number): boolean {
  return (
    value === undefined || value === null || (isCount(value) && value <= max)
  );
}

function isCountOrUnmetered(value: unknown): value is number {
  return value === -1 || isCount(value);
}

function isOptionalCountOrUnmetered(value: unknown): boolean {
  return value === undefined || value === null || isCountOrUnmetered(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function isTimestamp(value: unknown): value is string {
  if (!isSafeLine(value, { max: 40 })) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    isExactCalendarDate(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || isTimestamp(value);
}

function isCalendarDay(value: unknown): value is string {
  if (!isSafeLine(value, { max: 10 }) || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  return isExactCalendarDate(year ?? 0, month ?? 0, day ?? 0);
}

function isExactCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isProvider(value: unknown): value is VerificationProvider {
  return (
    typeof value === "string" && PROVIDERS.has(value as VerificationProvider)
  );
}

function isMode(value: unknown): value is VerificationMode {
  return typeof value === "string" && MODES.has(value as VerificationMode);
}

function isStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && STATUSES.has(value as VerificationStatus);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUSES.has(value as JobStatus);
}

function isJobSource(value: unknown): value is JobSource {
  return typeof value === "string" && JOB_SOURCES.has(value as JobSource);
}

function isHealthGrade(value: unknown): value is EmailHealthGrade {
  return (
    typeof value === "string" && HEALTH_GRADES.has(value as EmailHealthGrade)
  );
}

function isHealthRecommendation(
  value: unknown,
): value is EmailHealthRecommendation {
  return (
    typeof value === "string" &&
    HEALTH_RECOMMENDATIONS.has(value as EmailHealthRecommendation)
  );
}

function isHealthCode(value: unknown): value is string {
  return (
    isSafeLine(value, { max: 128 }) &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value)
  );
}

function parseHealthEvidence(value: unknown): EmailHealthEvidence | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !HEALTH_EVIDENCE_KINDS.has(value.kind as EmailHealthEvidenceKind) ||
    !isTimestamp(value.at) ||
    !isSafeLine(value.source, { allowEmpty: true, max: 128 }) ||
    !(
      value.reason_code === "" ||
      value.reason_code === undefined ||
      isHealthCode(value.reason_code)
    )
  ) {
    return null;
  }
  return {
    kind: value.kind as EmailHealthEvidenceKind,
    at: value.at,
    source: value.source,
    reason_code: typeof value.reason_code === "string" ? value.reason_code : "",
  };
}

/** Runtime boundary for both dedicated and embedded email-health payloads. */
export function parseEmailHealth(
  value: unknown,
  expectedEmail?: string,
): EmailHealth | null {
  if (
    !isRecord(value) ||
    !isHealthAddress(value.email) ||
    (expectedEmail !== undefined &&
      value.email.trim().toLowerCase() !==
        expectedEmail.trim().toLowerCase()) ||
    !isHealthGrade(value.grade) ||
    !isHealthRecommendation(value.recommendation) ||
    typeof value.hard_stop !== "boolean" ||
    typeof value.send_eligible !== "boolean" ||
    typeof value.evidence_complete !== "boolean" ||
    !Array.isArray(value.reason_codes) ||
    value.reason_codes.length > MAX_HEALTH_REASONS ||
    !value.reason_codes.every(isHealthCode) ||
    new Set(value.reason_codes).size !== value.reason_codes.length ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > MAX_HEALTH_EVIDENCE ||
    !isOptionalTimestamp(value.evidence_at) ||
    !(
      value.status === undefined ||
      value.status === "" ||
      isStatus(value.status)
    ) ||
    !isOptionalCount(value.score) ||
    (typeof value.score === "number" && value.score > 10) ||
    !isOptionalSafeLine(value.provider, MAX_PROVIDER_NAME) ||
    !isOptionalTimestamp(value.checked_at) ||
    !isSafeLine(value.model_version, { max: 128 }) ||
    !isTimestamp(value.computed_at)
  ) {
    return null;
  }

  const evidence: EmailHealthEvidence[] = [];
  for (const candidate of value.evidence) {
    const parsed = parseHealthEvidence(candidate);
    if (!parsed) return null;
    evidence.push(parsed);
  }
  const expectedRecommendation: EmailHealthRecommendation = value.hard_stop
    ? "blocked"
    : value.grade === "A" || value.grade === "B"
      ? "send"
      : value.grade === "D"
        ? "do_not_send"
        : value.grade === "F"
          ? "blocked"
          : "caution";
  const expectedEligibility =
    value.evidence_complete &&
    !value.hard_stop &&
    value.grade !== "D" &&
    value.grade !== "F";
  if (
    value.recommendation !== expectedRecommendation ||
    value.send_eligible !== expectedEligibility ||
    (value.grade === "A" &&
      (value.status !== "valid" ||
        !isProvider(value.provider) ||
        typeof value.checked_at !== "string")) ||
    (value.grade === "C" &&
      (value.status !== "catch_all" || !isProvider(value.provider))) ||
    (value.grade === "B" &&
      !evidence.some(
        (item) =>
          item.kind === "delivered" ||
          item.kind === "click" ||
          item.kind === "reply",
      )) ||
    (!value.evidence_complete &&
      (value.grade !== "U" ||
        value.hard_stop ||
        value.recommendation !== "caution"))
  ) {
    return null;
  }

  return {
    email: value.email,
    grade: value.grade,
    recommendation: value.recommendation,
    hard_stop: value.hard_stop,
    send_eligible: value.send_eligible,
    evidence_complete: value.evidence_complete,
    reason_codes: [...value.reason_codes],
    evidence,
    ...(typeof value.evidence_at === "string"
      ? { evidence_at: value.evidence_at }
      : {}),
    ...(isStatus(value.status) ? { status: value.status } : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.provider === "string" && value.provider
      ? { provider: value.provider }
      : {}),
    ...(typeof value.checked_at === "string"
      ? { checked_at: value.checked_at }
      : {}),
    model_version: value.model_version,
    computed_at: value.computed_at,
  };
}

export function parseEmailHealthBatch(
  value: unknown,
  requestedEmails?: readonly string[],
): EmailHealthBatchResponse | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    value.results.length > MAX_ROWS ||
    !isRecord(value.summary) ||
    Object.keys(value.summary).length !== HEALTH_GRADES.size ||
    !isCount(value.total) ||
    value.total !== value.results.length ||
    !isCount(value.duplicates) ||
    !isSafeLine(value.model_version, { max: 128 })
  ) {
    return null;
  }
  if (
    requestedEmails &&
    value.total + value.duplicates !== requestedEmails.length
  ) {
    return null;
  }

  const requested = requestedEmails
    ? new Set(requestedEmails.map((email) => email.trim().toLowerCase()))
    : null;
  const results: EmailHealth[] = [];
  const seen = new Set<string>();
  for (const candidate of value.results) {
    const parsed = parseEmailHealth(candidate);
    if (
      !parsed ||
      seen.has(parsed.email) ||
      (requested && !requested.has(parsed.email)) ||
      parsed.model_version !== value.model_version
    ) {
      return null;
    }
    seen.add(parsed.email);
    results.push(parsed);
  }

  const summary = {} as Record<EmailHealthGrade, number>;
  let summarized = 0;
  for (const grade of HEALTH_GRADES) {
    const count = value.summary[grade];
    if (!isCount(count)) return null;
    summary[grade] = count;
    summarized += count;
  }
  if (summarized !== value.total) return null;
  return {
    results,
    summary,
    total: value.total,
    duplicates: value.duplicates,
    model_version: value.model_version,
  };
}

function isProviderSettings(value: unknown): value is ProviderSettings {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "ip_address",
    "degrade_on_failure",
    "cache_ttl_days",
  ]);
  return (
    !Object.keys(value).some((key) => !allowed.has(key)) &&
    isOptionalSafeLine(value.ip_address, 128) &&
    isOptionalBoolean(value.degrade_on_failure) &&
    isOptionalBoundedCount(value.cache_ttl_days, 180)
  );
}

function isCredentialID(value: unknown): value is string {
  return (
    isSafeLine(value, { max: MAX_REFERENCE }) &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)
  );
}

function parseProvider(value: unknown): VerificationProviderView | null {
  if (
    !isRecord(value) ||
    !isOptionalUUID(value.id) ||
    !isProvider(value.provider) ||
    !isCredentialID(value.credential_ref) ||
    typeof value.enabled !== "boolean" ||
    !isProviderSettings(value.settings) ||
    !isOptionalCountOrUnmetered(value.last_balance) ||
    !isOptionalTimestamp(value.last_balance_at) ||
    !isOptionalSafeLine(value.last_error) ||
    !isOptionalTimestamp(value.last_error_at) ||
    !isOptionalTimestamp(value.created_at) ||
    !isOptionalTimestamp(value.updated_at)
  ) {
    return null;
  }
  return {
    provider: value.provider,
    credential_ref: value.credential_ref,
    enabled: value.enabled,
    settings: value.settings,
    ...(typeof value.last_balance === "number"
      ? { last_balance: value.last_balance }
      : {}),
    ...(typeof value.last_balance_at === "string"
      ? { last_balance_at: value.last_balance_at }
      : {}),
    has_error:
      typeof value.last_error === "string" &&
      value.last_error.trim().length > 0,
  };
}

export function parseVerificationProviders(
  value: unknown,
): VerificationProvidersView | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.providers) ||
    value.providers.length > PROVIDERS.size ||
    !Array.isArray(value.available) ||
    value.available.length !== PROVIDERS.size ||
    !value.available.every(isProvider)
  ) {
    return null;
  }
  const available = value.available as VerificationProvider[];
  const providers: VerificationProviderView[] = [];
  for (const candidate of value.providers) {
    const parsed = parseProvider(candidate);
    if (!parsed) return null;
    providers.push(parsed);
  }
  if (
    new Set(providers.map((entry) => entry.provider)).size !==
      providers.length ||
    providers.filter((entry) => entry.enabled).length > 1 ||
    new Set(available).size !== available.length ||
    providers.some((entry) => !available.includes(entry.provider))
  ) {
    return null;
  }
  return {
    providers,
    available,
  };
}

export function parseVerificationPolicy(
  value: unknown,
): VerificationPolicy | null {
  if (!isRecord(value) || !isRecord(value.policy)) return null;
  const policy = value.policy;
  if (
    !isMode(policy.forms_mode) ||
    !Array.isArray(policy.forms_reject_statuses) ||
    policy.forms_reject_statuses.length === 0 ||
    policy.forms_reject_statuses.length > REJECTABLE_STATUSES.size ||
    !policy.forms_reject_statuses.every(
      (status) => isStatus(status) && REJECTABLE_STATUSES.has(status),
    ) ||
    new Set(policy.forms_reject_statuses).size !==
      policy.forms_reject_statuses.length ||
    !isOptionalBoolean(policy.forms_suggest_typos) ||
    !isMode(policy.import_mode) ||
    !isOptionalTimestamp(policy.updated_at) ||
    !isPolicyMetadata(value)
  ) {
    return null;
  }
  return {
    forms_mode: policy.forms_mode,
    forms_reject_statuses: policy.forms_reject_statuses,
    ...(typeof policy.forms_suggest_typos === "boolean"
      ? { forms_suggest_typos: policy.forms_suggest_typos }
      : {}),
    import_mode: policy.import_mode,
    ...(typeof policy.updated_at === "string"
      ? { updated_at: policy.updated_at }
      : {}),
  };
}

function isPolicyMetadata(value: Record<string, unknown>): boolean {
  if (
    value.modes !== undefined &&
    (!Array.isArray(value.modes) ||
      value.modes.length !== MODES.size ||
      !value.modes.every(isMode) ||
      new Set(value.modes).size !== value.modes.length)
  ) {
    return false;
  }
  if (
    value.rejectable_statuses !== undefined &&
    (!Array.isArray(value.rejectable_statuses) ||
      value.rejectable_statuses.length !== REJECTABLE_STATUSES.size ||
      !value.rejectable_statuses.every(
        (status) => isStatus(status) && REJECTABLE_STATUSES.has(status),
      ) ||
      new Set(value.rejectable_statuses).size !==
        value.rejectable_statuses.length)
  ) {
    return false;
  }
  return (
    value.warning === undefined ||
    isSafeLine(value.warning, { allowEmpty: true, max: MAX_TEXT })
  );
}

export function parseVerificationCredits(
  value: unknown,
): VerificationCreditsView | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.usage) ||
    value.usage.length > MAX_USAGE_DAYS ||
    !value.usage.every(isUsageRow) ||
    !isRecord(value.totals) ||
    !isCount(value.totals.verified) ||
    !isCount(value.totals.credits_spent) ||
    !isCount(value.totals.local_filtered) ||
    !isCount(value.totals.cache_hits) ||
    !isCount(value.totals.credits_saved) ||
    value.totals.credits_spent > value.totals.verified ||
    value.totals.credits_saved !==
      value.totals.verified - value.totals.credits_spent ||
    !(value.provider === null || isProvider(value.provider)) ||
    !(value.balance === null || isCountOrUnmetered(value.balance)) ||
    !isOptionalTimestamp(value.balance_checked_at) ||
    !isOptionalSafeLine(value.last_error) ||
    !isOptionalSafeLine(value.note) ||
    (value.provider === null &&
      (value.balance !== null || value.balance_checked_at !== undefined))
  ) {
    return null;
  }

  const seenRows = new Set<string>();
  const totals = {
    verified: 0,
    credits_spent: 0,
    local_filtered: 0,
    cache_hits: 0,
  };
  for (const row of value.usage) {
    const key = `${row.day}:${row.provider}`;
    if (seenRows.has(key)) return null;
    seenRows.add(key);
    totals.verified += row.verified;
    totals.credits_spent += row.credits_spent;
    totals.local_filtered += row.local_filtered;
    totals.cache_hits += row.cache_hits;
  }
  if (
    !Object.values(totals).every(Number.isSafeInteger) ||
    totals.verified !== value.totals.verified ||
    totals.credits_spent !== value.totals.credits_spent ||
    totals.local_filtered !== value.totals.local_filtered ||
    totals.cache_hits !== value.totals.cache_hits
  ) {
    return null;
  }

  return {
    totals: value.totals as unknown as CreditsSummary["totals"],
    provider: value.provider,
    balance: value.balance,
    ...(typeof value.balance_checked_at === "string"
      ? { balance_checked_at: value.balance_checked_at }
      : {}),
    has_error:
      typeof value.last_error === "string" &&
      value.last_error.trim().length > 0,
  };
}

function isUsageRow(value: unknown): value is CreditsSummary["usage"][number] {
  return (
    isRecord(value) &&
    isCalendarDay(value.day) &&
    isSafeLine(value.provider, { max: MAX_PROVIDER_NAME }) &&
    USAGE_PROVIDERS.has(value.provider) &&
    isCount(value.verified) &&
    isCount(value.credits_spent) &&
    isCount(value.local_filtered) &&
    isCount(value.cache_hits) &&
    value.credits_spent <= value.verified &&
    value.local_filtered <= value.verified &&
    value.cache_hits <= value.verified
  );
}

function parseJob(value: unknown): VerificationJobView | null {
  if (
    !isRecord(value) ||
    !isUUID(value.id) ||
    !isJobStatus(value.status) ||
    !isJobSource(value.source) ||
    !isOptionalSafeLine(value.source_ref, MAX_REFERENCE) ||
    !isOptionalSafeLine(value.provider, MAX_PROVIDER_NAME) ||
    !isCount(value.total) ||
    !isCount(value.processed) ||
    !isCount(value.cache_hits) ||
    !isCount(value.local_filtered) ||
    !isCount(value.vendor_verified) ||
    !isCount(value.credits_spent) ||
    !isCount(value.duplicates) ||
    !isOptionalCount(value.ambiguous) ||
    !(
      value.failure_code === undefined ||
      value.failure_code === null ||
      value.failure_code === "" ||
      isHealthCode(value.failure_code)
    ) ||
    value.processed > value.total ||
    value.cache_hits > value.processed ||
    value.local_filtered > value.processed ||
    value.vendor_verified > value.processed ||
    value.credits_spent > value.vendor_verified ||
    value.processed +
      (typeof value.ambiguous === "number" ? value.ambiguous : 0) >
      value.total ||
    !isOptionalSafeLine(value.error) ||
    !isTimestamp(value.created_at) ||
    !isOptionalTimestamp(value.started_at) ||
    !isOptionalTimestamp(value.completed_at)
  ) {
    return null;
  }
  const hasError =
    typeof value.error === "string" && value.error.trim().length > 0;
  const startedAt =
    typeof value.started_at === "string" ? value.started_at : undefined;
  const completedAt =
    typeof value.completed_at === "string" ? value.completed_at : undefined;
  const hasStartedAt = startedAt !== undefined;
  const hasCompletedAt = completedAt !== undefined;
  const ambiguous = typeof value.ambiguous === "number" ? value.ambiguous : 0;
  if (
    (value.status === "pending" &&
      (hasStartedAt ||
        hasCompletedAt ||
        hasError ||
        value.processed !== 0 ||
        value.cache_hits !== 0 ||
        value.local_filtered !== 0 ||
        value.vendor_verified !== 0 ||
        value.credits_spent !== 0 ||
        ambiguous !== 0)) ||
    (value.status === "running" &&
      (!hasStartedAt || hasCompletedAt || hasError)) ||
    (value.status === "completed" &&
      (!hasStartedAt ||
        !hasCompletedAt ||
        hasError ||
        value.processed !== value.total)) ||
    (value.status === "failed" &&
      (!hasStartedAt || !hasCompletedAt || !hasError)) ||
    (value.status === "canceled" && (!hasCompletedAt || hasError)) ||
    (startedAt !== undefined &&
      Date.parse(startedAt) < Date.parse(value.created_at)) ||
    (completedAt !== undefined &&
      Date.parse(completedAt) < Date.parse(startedAt ?? value.created_at))
  ) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    source: value.source,
    total: value.total,
    processed: value.processed,
    cache_hits: value.cache_hits,
    local_filtered: value.local_filtered,
    vendor_verified: value.vendor_verified,
    credits_spent: value.credits_spent,
    duplicates: value.duplicates,
    ambiguous,
    ...(typeof value.failure_code === "string" && value.failure_code
      ? { failure_code: value.failure_code }
      : {}),
    has_error: hasError,
    created_at: value.created_at,
    ...(typeof value.started_at === "string"
      ? { started_at: value.started_at }
      : {}),
    ...(typeof value.completed_at === "string"
      ? { completed_at: value.completed_at }
      : {}),
  };
}

export function parseVerificationJobs(
  value: unknown,
  requestedLimit: number,
): VerificationJobsView | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    !isCount(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 200 ||
    value.jobs.length > requestedLimit
  ) {
    return null;
  }
  const jobs: VerificationJobView[] = [];
  const ids = new Set<string>();
  let previousCreatedAt = Number.POSITIVE_INFINITY;
  for (const candidate of value.jobs) {
    const parsed = parseJob(candidate);
    if (!parsed || ids.has(parsed.id)) return null;
    const createdAt = Date.parse(parsed.created_at);
    if (createdAt > previousCreatedAt) return null;
    ids.add(parsed.id);
    jobs.push(parsed);
    previousCreatedAt = createdAt;
  }
  return { rows: jobs, limit_reached: jobs.length === requestedLimit };
}

export function parseVerificationJobDetail(
  value: unknown,
  expectedId: string,
): VerificationJobDetailView | null {
  if (
    !isRecord(value) ||
    !isRecord(value.summary) ||
    Object.keys(value.summary).length > STATUSES.size ||
    !isCount(value.credits_saved) ||
    !isCount(value.credits_spent) ||
    typeof value.is_terminal !== "boolean"
  ) {
    return null;
  }
  const job = parseJob(value.job);
  if (!job || job.id !== expectedId) return null;
  const summary: Partial<Record<VerificationStatus, number>> = {};
  let summarized = 0;
  for (const [status, count] of Object.entries(value.summary)) {
    if (!isStatus(status) || !isCount(count)) return null;
    summary[status] = count;
    summarized += count;
    if (!Number.isSafeInteger(summarized)) return null;
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
    return null;
  }
  return {
    job,
    summary,
    credits_saved: value.credits_saved,
    credits_spent: value.credits_spent,
    is_terminal: value.is_terminal,
  };
}

export function parseVerificationResults(
  value: unknown,
  offset: number,
  pageSize: number,
): VerificationResultsView | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    !isCount(offset) ||
    !isCount(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_ROWS ||
    value.results.length > pageSize + 1
  ) {
    return null;
  }
  const results: VerificationResultView[] = [];
  for (const [index, candidate] of value.results.entries()) {
    const result = parseResult(candidate, offset + index);
    if (!result) return null;
    results.push(result);
  }
  return {
    rows: results.slice(0, pageSize),
    has_more: results.length > pageSize,
  };
}

function parseResult(
  value: unknown,
  rowIndex: number,
): VerificationResultView | null {
  if (
    !isRecord(value) ||
    !isHealthAddress(value.email) ||
    typeof value.processed !== "boolean" ||
    !isStatus(value.status) ||
    !isOptionalSafeLine(value.sub_status) ||
    !isOptionalCount(value.score) ||
    (typeof value.score === "number" && value.score > 10) ||
    !isOptionalSafeLine(value.provider, MAX_PROVIDER_NAME) ||
    typeof value.billable !== "boolean" ||
    typeof value.cached !== "boolean" ||
    !isOptionalSafeLine(value.did_you_mean, MAX_EMAIL) ||
    !isOptionalTimestamp(value.checked_at) ||
    !(
      value.attempt_state === undefined ||
      (typeof value.attempt_state === "string" &&
        ATTEMPT_STATES.has(value.attempt_state))
    )
  ) {
    return null;
  }
  const hasSubStatus =
    typeof value.sub_status === "string" && value.sub_status.trim().length > 0;
  const hasProvider =
    typeof value.provider === "string" && value.provider.trim().length > 0;
  const suggestionSource =
    typeof value.did_you_mean === "string" ? value.did_you_mean : undefined;
  const hasSuggestion =
    suggestionSource !== undefined && suggestionSource.trim().length > 0;
  const hasCheckedAt = typeof value.checked_at === "string";
  const attemptState =
    typeof value.attempt_state === "string" ? value.attempt_state : undefined;
  if (
    (value.cached && value.billable) ||
    (value.processed && !hasCheckedAt) ||
    (value.processed &&
      attemptState !== undefined &&
      attemptState !== "succeeded") ||
    (!value.processed && attemptState === "succeeded") ||
    (!value.processed &&
      (value.status !== "unknown" ||
        hasSubStatus ||
        value.score !== undefined ||
        hasProvider ||
        value.billable ||
        value.cached ||
        hasSuggestion ||
        hasCheckedAt))
  ) {
    return null;
  }
  const suggestion = hasSuggestion ? maskEmail(suggestionSource) : undefined;
  if (
    typeof value.did_you_mean === "string" &&
    value.did_you_mean.trim() &&
    !suggestion
  ) {
    return null;
  }
  const health =
    value.health === undefined
      ? undefined
      : parseEmailHealth(value.health, value.email);
  if (value.health !== undefined && !health) return null;
  return {
    row_key: String(rowIndex),
    masked_email: maskEmail(value.email) ?? "••••",
    processed: value.processed,
    status: value.status,
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    billable: value.billable,
    cached: value.cached,
    ...(attemptState
      ? {
          attempt_state: attemptState as JobItem["attempt_state"],
        }
      : {}),
    ...(health
      ? {
          health: {
            grade: health.grade,
            recommendation: health.recommendation,
            hard_stop: health.hard_stop,
            send_eligible: health.send_eligible,
            evidence_complete: health.evidence_complete,
            reason_codes: health.reason_codes,
            evidence_count: health.evidence.length,
            ...(health.evidence_at ? { evidence_at: health.evidence_at } : {}),
            ...(health.status ? { status: health.status } : {}),
            ...(typeof health.score === "number"
              ? { score: health.score }
              : {}),
            ...(health.provider ? { provider: health.provider } : {}),
            ...(health.checked_at ? { checked_at: health.checked_at } : {}),
            model_version: health.model_version,
            computed_at: health.computed_at,
          },
        }
      : {}),
    ...(suggestion ? { masked_suggestion: suggestion } : {}),
    ...(typeof value.checked_at === "string"
      ? { checked_at: value.checked_at }
      : {}),
  };
}

function isEmail(value: unknown): value is string {
  if (!isSafeLine(value, { max: MAX_EMAIL })) return false;
  const normalized = value.trim();
  const at = normalized.lastIndexOf("@");
  return at > 0 && at < normalized.length - 1 && !/\s/u.test(normalized);
}

/**
 * Health lookup keys deliberately include malformed addresses: syntax is
 * grade evidence, not an HTTP/schema error. Keep the transport boundary
 * bounded and control-free without requiring an `@` that invalid rows lack.
 */
function isHealthAddress(value: unknown): value is string {
  return (
    isSafeLine(value, { max: MAX_EMAIL }) &&
    value.length >= 3 &&
    value === value.trim().toLowerCase()
  );
}

export function maskEmail(value: string): string | null {
  if (!isEmail(value)) return null;
  const normalized = value.trim();
  const separator = normalized.lastIndexOf("@");
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  return `${local.slice(0, 1)}${"•".repeat(
    Math.min(8, Math.max(3, local.length - 1)),
  )}@${domain}`;
}

export function compactVerificationText(value: string, max = 72): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 1)}…`;
}
