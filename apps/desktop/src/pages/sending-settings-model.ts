import type { SendingSettingsInput } from "../lib/api-client";
import { rfc3339EpochNanoseconds } from "../lib/rfc3339-revision";

export const MAX_SENDS_PER_HOUR = 1_000_000;
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

const MAX_TIME_ZONE_LENGTH = 128;
const MAX_POOL_NAME_LENGTH = 160;
const RFC3339_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;
const GO_ZERO_TIMESTAMP = /^0001-01-01T00:00:00(?:\.0+)?Z$/u;
const CANONICAL_NO_ROW_REVISION = "0001-01-01T00:00:00Z";

export interface SendingFormState {
  rateLimit: string;
  quietEnabled: boolean;
  start: string;
  end: string;
  timezone: string;
  perRecipient: boolean;
}

export interface SendingFormErrors {
  rateLimit?: string;
  start?: string;
  end?: string;
  timezone?: string;
}

export interface VerifiedSendingSettings {
  tenant_id: string;
  max_sends_per_hour: number | null;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  quiet_hours_per_recipient: boolean;
  fallback_hour_utc: number | null;
  ip_pool?: { name: string; dedicated: boolean };
  updated_at: string | null;
  /** Runtime proof that GET returned the server's exact synthesized no-row shape. */
  canonical_no_row_revision?: true;
}

export interface VerifiedSendingStatus {
  tenant_id: string;
  max_sends_per_hour: number | null;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  quiet_hours_per_recipient: boolean;
  bucket_count: number | null;
  window_start: string | null;
  window_resets_at: string | null;
  in_quiet_hours: boolean | null;
  quiet_changes_at: string | null;
  counter_authoritative: boolean;
  counter_source: string | null;
  counter_scope: "shared" | "process" | "unavailable";
  cap_coordination_state: "ready" | "conservatively_fenced" | "unavailable";
  cap_coordination_ready: boolean;
  cap_coordination_cap: number | null;
  cap_coordination_matches_settings: boolean;
  cap_coordination_fence_started_at: string | null;
}

export const EMPTY_SENDING_FORM: SendingFormState = {
  rateLimit: "",
  quietEnabled: false,
  start: "",
  end: "",
  timezone: "",
  perRecipient: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function nullablePositiveInteger(
  value: unknown,
  maximum: number,
): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    return undefined;
  }
  return value;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 64) {
    return undefined;
  }
  if (GO_ZERO_TIMESTAMP.test(value)) return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHours = Number(match[4] ?? 0);
  const offsetMinutes = Number(match[5] ?? 0);
  if (
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return undefined;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (year < 2000 || day < 1 || day > (daysInMonth[month - 1] ?? 0)) {
    return undefined;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  return value;
}

function parseQuietFields(value: Record<string, unknown>): {
  start: string;
  end: string;
  timezone: string;
  perRecipient: boolean;
} | null {
  const start = boundedString(value.quiet_hours_start ?? "", 5);
  const end = boundedString(value.quiet_hours_end ?? "", 5);
  const timezone = boundedString(
    value.quiet_hours_tz ?? "",
    MAX_TIME_ZONE_LENGTH,
  );
  if (start === null || end === null || timezone === null) return null;
  const setCount = [start, end, timezone].filter(Boolean).length;
  if (setCount !== 0 && setCount !== 3) return null;
  if (
    setCount === 3 &&
    (!HHMM_PATTERN.test(start) ||
      !HHMM_PATTERN.test(end) ||
      start === end ||
      !isValidTimeZone(timezone))
  ) {
    return null;
  }
  const perRecipient = value.quiet_hours_per_recipient;
  if (typeof perRecipient !== "boolean") return null;
  return { start, end, timezone, perRecipient };
}

export function parseSendingSettings(
  value: unknown,
): VerifiedSendingSettings | null {
  if (!isObject(value)) return null;
  const tenantID = boundedString(value.tenant_id ?? "", 128);
  const cap = nullablePositiveInteger(
    value.max_sends_per_hour,
    MAX_SENDS_PER_HOUR,
  );
  const quiet = parseQuietFields(value);
  const updatedAt = nullableTimestamp(value.updated_at);
  const hasOwn = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, field);
  const canonicalNoRowRevision =
    value.updated_at === CANONICAL_NO_ROW_REVISION &&
    value.quiet_hours_per_recipient === true &&
    !hasOwn("max_sends_per_hour") &&
    !hasOwn("quiet_hours_start") &&
    !hasOwn("quiet_hours_end") &&
    !hasOwn("quiet_hours_tz") &&
    !hasOwn("fallback_hour_utc") &&
    !hasOwn("updated_by_user_id");
  if (
    !tenantID?.trim() ||
    cap === undefined ||
    !quiet ||
    updatedAt === undefined ||
    (updatedAt === null && !canonicalNoRowRevision)
  ) {
    return null;
  }

  let fallback: number | null = null;
  if (
    value.fallback_hour_utc !== undefined &&
    value.fallback_hour_utc !== null
  ) {
    if (
      typeof value.fallback_hour_utc !== "number" ||
      !Number.isSafeInteger(value.fallback_hour_utc) ||
      value.fallback_hour_utc < 0 ||
      value.fallback_hour_utc > 23
    ) {
      return null;
    }
    fallback = value.fallback_hour_utc;
  }

  let ipPool: VerifiedSendingSettings["ip_pool"];
  if (value.ip_pool !== undefined && value.ip_pool !== null) {
    if (!isObject(value.ip_pool)) return null;
    const name = boundedString(value.ip_pool.name, MAX_POOL_NAME_LENGTH);
    if (!name?.trim() || typeof value.ip_pool.dedicated !== "boolean") {
      return null;
    }
    ipPool = { name: name.trim(), dedicated: value.ip_pool.dedicated };
  }

  return {
    tenant_id: tenantID.trim(),
    max_sends_per_hour: cap,
    quiet_hours_start: quiet.start,
    quiet_hours_end: quiet.end,
    quiet_hours_tz: quiet.timezone,
    quiet_hours_per_recipient: quiet.perRecipient,
    fallback_hour_utc: fallback,
    ...(ipPool ? { ip_pool: ipPool } : {}),
    updated_at: updatedAt,
    ...(canonicalNoRowRevision ? { canonical_no_row_revision: true } : {}),
  };
}

function optionalBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : undefined;
}

function counterScope(
  value: unknown,
): VerifiedSendingStatus["counter_scope"] | undefined {
  if (value === undefined || value === null || value === "") {
    return "unavailable";
  }
  return value === "shared" || value === "process" || value === "unavailable"
    ? value
    : undefined;
}

function capCoordinationState(
  value: unknown,
): VerifiedSendingStatus["cap_coordination_state"] | undefined {
  return value === "ready" ||
    value === "conservatively_fenced" ||
    value === "unavailable"
    ? value
    : undefined;
}

export function parseSendingStatus(
  value: unknown,
): VerifiedSendingStatus | null {
  if (!isObject(value)) return null;
  const tenantID = boundedString(value.tenant_id ?? "", 128);
  const cap = nullablePositiveInteger(
    value.max_sends_per_hour,
    MAX_SENDS_PER_HOUR,
  );
  const quiet = parseQuietFields(value);
  const coordinationState = capCoordinationState(value.cap_coordination_state);
  const coordinationCap = nullablePositiveInteger(
    value.cap_coordination_cap,
    MAX_SENDS_PER_HOUR,
  );
  const coordinationFenceStartedAt = nullableTimestamp(
    value.cap_coordination_fence_started_at,
  );
  if (
    !tenantID?.trim() ||
    cap === undefined ||
    !quiet ||
    !coordinationState ||
    coordinationCap === undefined ||
    coordinationFenceStartedAt === undefined ||
    typeof value.cap_coordination_ready !== "boolean" ||
    typeof value.cap_coordination_matches_settings !== "boolean"
  ) {
    return null;
  }

  const coordinationReady = value.cap_coordination_ready;
  const coordinationMatches = value.cap_coordination_matches_settings;
  const coordinationShapeIsValid =
    coordinationState === "ready"
      ? coordinationReady && coordinationFenceStartedAt === null
      : coordinationState === "conservatively_fenced"
        ? !coordinationReady &&
          !coordinationMatches &&
          coordinationFenceStartedAt !== null
        : !coordinationReady &&
          !coordinationMatches &&
          coordinationCap === null &&
          coordinationFenceStartedAt === null;
  if (
    !coordinationShapeIsValid ||
    (coordinationMatches && coordinationCap !== cap)
  ) {
    return null;
  }

  let bucketCount: number | null = null;
  if (value.bucket_count !== undefined && value.bucket_count !== null) {
    if (
      typeof value.bucket_count !== "number" ||
      !Number.isSafeInteger(value.bucket_count) ||
      value.bucket_count < 0
    ) {
      return null;
    }
    bucketCount = value.bucket_count;
  }
  const windowStart = nullableTimestamp(value.window_start);
  const windowResetsAt = nullableTimestamp(value.window_resets_at);
  const quietChangesAt = nullableTimestamp(value.quiet_changes_at);
  const inQuiet = optionalBoolean(value.in_quiet_hours);
  if (
    windowStart === undefined ||
    windowResetsAt === undefined ||
    quietChangesAt === undefined ||
    inQuiet === undefined
  ) {
    return null;
  }
  const source = boundedString(value.counter_source ?? "", 64);
  if (source === null) return null;
  const scope = counterScope(value.counter_scope);
  if (!scope) return null;
  // Old servers did not qualify the legacy Postgres projection. Absence is
  // deliberately non-authoritative so the desktop never promotes it as live.
  const authoritative = value.counter_authoritative === true;
  const normalizedSource = source.trim();
  if (
    authoritative &&
    (scope !== "shared" || bucketCount === null || !normalizedSource)
  ) {
    return null;
  }

  return {
    tenant_id: tenantID.trim(),
    max_sends_per_hour: cap,
    quiet_hours_start: quiet.start,
    quiet_hours_end: quiet.end,
    quiet_hours_tz: quiet.timezone,
    quiet_hours_per_recipient: quiet.perRecipient,
    bucket_count: bucketCount,
    window_start: windowStart,
    window_resets_at: windowResetsAt,
    in_quiet_hours: inQuiet,
    quiet_changes_at: quietChangesAt,
    counter_authoritative: authoritative,
    counter_source: normalizedSource || null,
    counter_scope: authoritative ? scope : "unavailable",
    cap_coordination_state: coordinationState,
    cap_coordination_ready: coordinationReady,
    cap_coordination_cap: coordinationCap,
    cap_coordination_matches_settings: coordinationMatches,
    cap_coordination_fence_started_at: coordinationFenceStartedAt,
  };
}

export function formFromSendingSettings(
  row: VerifiedSendingSettings,
): SendingFormState {
  const quietEnabled = Boolean(
    row.quiet_hours_start && row.quiet_hours_end && row.quiet_hours_tz,
  );
  return {
    rateLimit:
      row.max_sends_per_hour === null ? "" : String(row.max_sends_per_hour),
    quietEnabled,
    start: row.quiet_hours_start,
    end: row.quiet_hours_end,
    timezone: row.quiet_hours_tz,
    perRecipient: row.quiet_hours_per_recipient,
  };
}

export function validateSendingForm(form: SendingFormState): SendingFormErrors {
  const errors: SendingFormErrors = {};
  const rate = form.rateLimit.trim();
  if (rate !== "") {
    const parsed = Number(rate);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      errors.rateLimit = "Enter a whole number of 1 or more, or leave blank.";
    } else if (parsed > MAX_SENDS_PER_HOUR) {
      errors.rateLimit = `Enter ${MAX_SENDS_PER_HOUR.toLocaleString()} or less.`;
    }
  }

  if (form.quietEnabled) {
    if (!HHMM_PATTERN.test(form.start)) {
      errors.start = "Enter a time in 24-hour HH:MM format.";
    }
    if (!HHMM_PATTERN.test(form.end)) {
      errors.end = "Enter a time in 24-hour HH:MM format.";
    } else if (form.start === form.end) {
      errors.end = "End time must differ from start time.";
    }
    if (!form.timezone) {
      errors.timezone = "Choose the timezone used as the workspace fallback.";
    } else if (!isValidTimeZone(form.timezone)) {
      errors.timezone = "Choose a valid IANA timezone.";
    }
  }
  return errors;
}

export function sendingInputFromForm(
  form: SendingFormState,
  expectedUpdatedAt: string | null,
): SendingSettingsInput {
  return {
    max_sends_per_hour:
      form.rateLimit.trim() === "" ? null : Number(form.rateLimit),
    quiet_hours_start: form.quietEnabled ? form.start : "",
    quiet_hours_end: form.quietEnabled ? form.end : "",
    quiet_hours_tz: form.quietEnabled ? form.timezone : "",
    quiet_hours_per_recipient: form.perRecipient,
    expected_updated_at: expectedUpdatedAt ?? "",
  };
}

export function clearedSendingInput(
  baseline: VerifiedSendingSettings,
): SendingSettingsInput {
  return {
    max_sends_per_hour: null,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: baseline.quiet_hours_per_recipient,
    expected_updated_at: baseline.updated_at ?? "",
  };
}

function comparableInput(input: SendingSettingsInput): string {
  return JSON.stringify({
    max_sends_per_hour: input.max_sends_per_hour,
    quiet_hours_start: input.quiet_hours_start,
    quiet_hours_end: input.quiet_hours_end,
    quiet_hours_tz: input.quiet_hours_tz,
    quiet_hours_per_recipient: input.quiet_hours_per_recipient,
  });
}

export function sendingFormIsDirty(
  form: SendingFormState,
  baseline: VerifiedSendingSettings | null,
): boolean {
  if (!baseline) return false;
  return (
    comparableInput(sendingInputFromForm(form, baseline.updated_at)) !==
    comparableInput(
      sendingInputFromForm(
        formFromSendingSettings(baseline),
        baseline.updated_at,
      ),
    )
  );
}

export function sendingSettingsAreConfigured(
  row: VerifiedSendingSettings,
): boolean {
  return Boolean(
    row.max_sends_per_hour !== null ||
    row.quiet_hours_start ||
    row.quiet_hours_end ||
    row.quiet_hours_tz,
  );
}

/** Status computations are usable only for the exact policy they describe. */
export function sendingStatusMatchesSettings(
  status: VerifiedSendingStatus,
  settings: VerifiedSendingSettings,
): boolean {
  return (
    status.tenant_id === settings.tenant_id &&
    status.max_sends_per_hour === settings.max_sends_per_hour &&
    status.quiet_hours_start === settings.quiet_hours_start &&
    status.quiet_hours_end === settings.quiet_hours_end &&
    status.quiet_hours_tz === settings.quiet_hours_tz &&
    status.quiet_hours_per_recipient === settings.quiet_hours_per_recipient
  );
}

/**
 * Recovery proof for an outcome-ambiguous settings mutation. A matching
 * durable row is not enough: the shared send-admission authority must also
 * explicitly confirm the exact capped or uncapped policy for this tenant.
 */
export function sendingCapCoordinationProvesSettings(
  status: VerifiedSendingStatus,
  settings: VerifiedSendingSettings,
): boolean {
  return (
    sendingStatusMatchesSettings(status, settings) &&
    status.cap_coordination_state === "ready" &&
    status.cap_coordination_ready &&
    status.cap_coordination_matches_settings &&
    status.cap_coordination_cap === settings.max_sends_per_hour
  );
}

export function sendingSettingsRevision(row: VerifiedSendingSettings): string {
  return JSON.stringify({
    updated_at: row.updated_at,
    max_sends_per_hour: row.max_sends_per_hour,
    quiet_hours_start: row.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end,
    quiet_hours_tz: row.quiet_hours_tz,
    quiet_hours_per_recipient: row.quiet_hours_per_recipient,
    fallback_hour_utc: row.fallback_hour_utc,
    ip_pool: row.ip_pool ?? null,
    canonical_no_row_revision: row.canonical_no_row_revision === true,
  });
}

/** Exact proof that a canonical read still represents no durable row. */
export function sendingSettingsIsCanonicalNoRow(
  row: VerifiedSendingSettings,
): boolean {
  return (
    row.canonical_no_row_revision === true &&
    row.updated_at === null &&
    row.max_sends_per_hour === null &&
    row.quiet_hours_start === "" &&
    row.quiet_hours_end === "" &&
    row.quiet_hours_tz === "" &&
    row.quiet_hours_per_recipient &&
    row.fallback_hour_utc === null
  );
}

/** Strict server revision order, retaining PostgreSQL microseconds/nanoseconds. */
export function sendingSettingsRevisionAdvances(
  expected: string | null,
  candidate: string | null,
): candidate is string {
  if (candidate === null) return false;
  const candidateNanos = rfc3339EpochNanoseconds(candidate);
  if (candidateNanos === null) return false;
  if (expected === null) return true;
  const expectedNanos = rfc3339EpochNanoseconds(expected);
  return expectedNanos !== null && candidateNanos > expectedNanos;
}

export function changedSendingFields(
  before: VerifiedSendingSettings,
  after: VerifiedSendingSettings,
): string[] {
  const changed: string[] = [];
  if (before.max_sends_per_hour !== after.max_sends_per_hour) {
    changed.push("hourly cap");
  }
  if (
    before.quiet_hours_start !== after.quiet_hours_start ||
    before.quiet_hours_end !== after.quiet_hours_end ||
    before.quiet_hours_tz !== after.quiet_hours_tz
  ) {
    changed.push("quiet-hours window");
  }
  if (before.quiet_hours_per_recipient !== after.quiet_hours_per_recipient) {
    changed.push("quiet-hours timezone scope");
  }
  return changed;
}

export function isValidTimeZone(value: string): boolean {
  if (!value || value.length > MAX_TIME_ZONE_LENGTH) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function timeZoneOptions(
  current: string,
  curated: ReadonlyArray<{ value: string; label: string }>,
): ReadonlyArray<{ value: string; label: string }> {
  if (!current || curated.some((option) => option.value === current)) {
    return curated;
  }
  return [{ value: current, label: `${current} (saved value)` }, ...curated];
}

export function safeRelativeTime(
  value: string | number | Date | null | undefined,
  now = Date.now(),
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const time =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  const difference = time - now;
  const absolute = Math.abs(difference);
  const future = difference > 0;
  const phrase = (amount: number, unit: string): string =>
    future ? `in ${amount}${unit}` : `${amount}${unit} ago`;
  if (absolute < 60_000) return future ? "in <1m" : "just now";
  if (absolute < 3_600_000) return phrase(Math.round(absolute / 60_000), "m");
  if (absolute < 86_400_000) {
    return phrase(Math.round(absolute / 3_600_000), "h");
  }
  return phrase(Math.round(absolute / 86_400_000), "d");
}
