// SPDX-License-Identifier: MIT
import {
  ParseError,
  PostwaveError,
  responseMetadataFromHeaders,
  type PostwaveResponseMetadata,
} from "../errors.js";
import { Resource } from "./_base.js";

/** Minimum causal-quiescence delay before reads can prove an ambiguous write absent. */
export const SENDING_SETTINGS_RECONCILIATION_WAIT_MS = 35_000;

export interface SendingSettings {
  tenant_id: string;
  /** Per-hour workspace cap. Omitted/null means no workspace-specific ceiling. */
  max_sends_per_hour?: number | null;
  /** Quiet hours start as "HH:MM" in quiet_hours_tz. */
  quiet_hours_start?: string;
  /** Quiet hours end as "HH:MM" in quiet_hours_tz. */
  quiet_hours_end?: string;
  /** IANA timezone name (e.g. "America/New_York"). */
  quiet_hours_tz?: string;
  /** Resolve the quiet-hours window in each recipient's timezone. */
  quiet_hours_per_recipient: boolean;
  /** Legacy send-time optimization fallback hour (0-23 UTC), when retained. */
  fallback_hour_utc?: number | null;
  /** Read-only sending pool projection when the server can resolve it. */
  ip_pool?: { name: string; dedicated: boolean } | null;
  /** User UUID attributed to the latest canonical mutation, when present. */
  updated_by_user_id?: string | null;
  updated_at: string;
}

export interface SendingSettingsInput {
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  fallback_hour_utc?: number | null;
  /** Exact loaded revision. Empty string asserts that no durable row exists. */
  expected_updated_at?: string;
}

export interface SendingSettingsStatus {
  tenant_id: string;
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient: boolean;
  bucket_count?: number;
  window_start?: string;
  window_resets_at?: string;
  in_quiet_hours?: boolean;
  quiet_changes_at?: string;
  /** The production counter is deliberately not exposed as authoritative. */
  counter_authoritative: false;
  counter_source: "unavailable";
  counter_scope: "unavailable";
  cap_coordination_state: "ready" | "conservatively_fenced" | "unavailable";
  cap_coordination_ready: boolean;
  cap_coordination_cap?: number;
  cap_coordination_matches_settings: boolean;
  cap_coordination_fence_started_at?: string | null;
}

const SENDING_SETTINGS_KEYS = new Set([
  "tenant_id",
  "max_sends_per_hour",
  "quiet_hours_start",
  "quiet_hours_end",
  "quiet_hours_tz",
  "quiet_hours_per_recipient",
  "fallback_hour_utc",
  "updated_by_user_id",
  "updated_at",
  "ip_pool",
]);
const SENDING_SETTINGS_IP_POOL_KEYS = new Set(["name", "dedicated"]);

/**
 * Per-tenant sending throttle and quiet-hours settings. Consumed by the
 * sending worker before each batch.
 */
export class SendingSettingsResource extends Resource {
  get(): Promise<SendingSettings> {
    return this.client.request("GET", "/api/v1/settings/sending");
  }

  /**
   * Read the shared cap authority used to verify an outcome-ambiguous write.
   */
  status(): Promise<SendingSettingsStatus> {
    return this.client.request("GET", "/api/v1/settings/sending/status");
  }

  /**
   * Replace settings with exactly one wire attempt.
   *
   * An unproven non-success response, invalid 2xx, or transport error can
   * follow a durable commit. Wait at least 35 seconds from submission, then
   * call `get()` and `status()` to reconcile the submitted values and require
   * a ready, settings-matching cap authority before reporting success or
   * retrying.
   */
  async set(input: SendingSettingsInput): Promise<SendingSettings> {
    let responseMetadata: PostwaveResponseMetadata | undefined;
    let payload: unknown;
    try {
      payload = await this.client.request<unknown>(
        "PUT",
        "/api/v1/settings/sending",
        {
          body: input,
          // This control-plane endpoint forbids the header. null strips even a
          // client-wide default and pairs with maxAttempts: 1 as an absence
          // guarantee, rather than relying on PUT's lack of auto-minting.
          idempotencyKey: null,
          maxAttempts: 1,
          // A 307/308 followed below fetch() would resend the PUT outside the
          // SDK retry loop. Refuse redirects so the outcome is reconciled.
          redirect: "error",
          expectedStatus: 200,
          onResponseHeaders: (headers) => {
            responseMetadata = responseMetadataFromHeaders(headers);
          },
        },
      );
    } catch (error) {
      // Only an exact outcome received on an HTTP failure can prove safety.
      // Upstream, pre-handler, panic, or proxy responses may omit or rewrite
      // the header and cannot be treated as safe to repeat. A wrong 2xx is
      // always a protocol failure even if it claims not-committed.
      const safeNotCommittedHttpFailure =
        error instanceof PostwaveError &&
        error.status >= 400 &&
        error.responseMetadata?.sendingCapOutcome === "not-committed";
      if (error instanceof PostwaveError && !safeNotCommittedHttpFailure) {
        throw new ParseError({
          message:
            "Sending-settings write did not provide exact not-committed proof; wait at least 35 seconds from submission, then reconcile canonical settings and cap status before retrying.",
          status: error.status,
          payload: error.payload,
          requestId: error.requestId,
          responseMetadata: error.responseMetadata,
        });
      }
      throw error;
    }
    if (
      responseMetadata?.sendingCapOutcome !== "committed" ||
      !isSendingSettings(payload) ||
      !matchesSubmittedSettings(payload, input) ||
      !advancesSubmittedRevision(payload, input)
    ) {
      throw new ParseError({
        message:
          "Sending-settings write returned an invalid committed response; wait at least 35 seconds from submission, then reconcile canonical settings and cap status before retrying.",
        status: 200,
        payload,
        responseMetadata,
      });
    }
    return payload;
  }
}

function isSendingSettings(value: unknown): value is SendingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).every((key) => SENDING_SETTINGS_KEYS.has(key)) &&
    typeof row.tenant_id === "string" &&
    isCanonicalUuid(row.tenant_id) &&
    typeof row.quiet_hours_per_recipient === "boolean" &&
    typeof row.updated_at === "string" &&
    isCommittedRevision(row.updated_at) &&
    (row.max_sends_per_hour === undefined ||
      row.max_sends_per_hour === null ||
      (typeof row.max_sends_per_hour === "number" &&
        Number.isInteger(row.max_sends_per_hour) &&
        row.max_sends_per_hour >= 1 &&
        row.max_sends_per_hour <= 1_000_000)) &&
    isCanonicalQuietPolicy(row) &&
    (row.fallback_hour_utc === undefined ||
      row.fallback_hour_utc === null ||
      (typeof row.fallback_hour_utc === "number" &&
        Number.isInteger(row.fallback_hour_utc) &&
        row.fallback_hour_utc >= 0 &&
        row.fallback_hour_utc <= 23)) &&
    (row.updated_by_user_id === undefined ||
      row.updated_by_user_id === null ||
      (typeof row.updated_by_user_id === "string" &&
        isCanonicalUuid(row.updated_by_user_id))) &&
    isCanonicalIpPool(row.ip_pool)
  );
}

function matchesSubmittedSettings(
  row: SendingSettings,
  input: SendingSettingsInput,
): boolean {
  if ((row.max_sends_per_hour ?? null) !== (input.max_sends_per_hour ?? null)) {
    return false;
  }
  if ((row.quiet_hours_start ?? "") !== (input.quiet_hours_start ?? "")) {
    return false;
  }
  if ((row.quiet_hours_end ?? "") !== (input.quiet_hours_end ?? "")) {
    return false;
  }
  if ((row.quiet_hours_tz ?? "") !== (input.quiet_hours_tz ?? "")) {
    return false;
  }
  if (
    row.quiet_hours_per_recipient !== (input.quiet_hours_per_recipient ?? true)
  ) {
    return false;
  }
  if (
    input.fallback_hour_utc !== undefined &&
    (row.fallback_hour_utc ?? null) !== input.fallback_hour_utc
  ) {
    return false;
  }
  return true;
}

function advancesSubmittedRevision(
  row: SendingSettings,
  input: SendingSettingsInput,
): boolean {
  const expected = input.expected_updated_at;
  if (expected === undefined || expected === "") return true;
  if (typeof expected !== "string") return false;
  const candidateNanos = revisionEpochNanoseconds(row.updated_at);
  const expectedNanos = revisionEpochNanoseconds(expected);
  return (
    candidateNanos !== null &&
    expectedNanos !== null &&
    candidateNanos > expectedNanos
  );
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isCanonicalQuietPolicy(row: Record<string, unknown>): boolean {
  const start = row.quiet_hours_start ?? "";
  const end = row.quiet_hours_end ?? "";
  const timezone = row.quiet_hours_tz ?? "";
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof timezone !== "string"
  ) {
    return false;
  }
  if (start === "" && end === "" && timezone === "") return true;
  if (
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start) ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(end) ||
    start === end ||
    timezone.length === 0 ||
    timezone.length > 128
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isCanonicalIpPool(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pool = value as Record<string, unknown>;
  return (
    Object.keys(pool).every((key) => SENDING_SETTINGS_IP_POOL_KEYS.has(key)) &&
    typeof pool.name === "string" &&
    pool.name.trim().length > 0 &&
    pool.name.length <= 160 &&
    typeof pool.dedicated === "boolean"
  );
}

function isCommittedRevision(value: string): boolean {
  return (
    value !== "0001-01-01T00:00:00Z" && revisionEpochNanoseconds(value) !== null
  );
}

function revisionEpochNanoseconds(value: string): bigint | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const offsetSign = match[8] ?? "+";
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (
    offsetHours > 14 ||
    offsetMinutes > 59 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return null;
  }
  if (year < 2000 || month < 1 || month > 12 || day < 1) return null;
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
  if (day > (daysInMonth[month - 1] ?? 0)) return null;

  // Construct UTC explicitly and keep the fractional component as BigInt:
  // Date loses the server's PostgreSQL microseconds and the contract permits
  // nanoseconds.
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  const localMillis = calendar.getTime();
  if (!Number.isFinite(localMillis)) return null;
  const signedOffsetMinutes =
    (offsetSign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const epochMillis = localMillis - signedOffsetMinutes * 60_000;
  const nanos = BigInt(fraction.padEnd(9, "0") || "0");
  return BigInt(epochMillis) * 1_000_000n + nanos;
}
