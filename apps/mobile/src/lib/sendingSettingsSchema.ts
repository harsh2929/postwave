// SPDX-License-Identifier: AGPL-3.0-only

import {
  isCanonicalSendsPerHour,
  isCoherentQuietHours,
  sendingSettingsExpectedRevision,
} from "./sendingForm";

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SENDING_SETTINGS_FIELDS = new Set([
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
const IP_POOL_FIELDS = new Set(["name", "dedicated"]);

export interface SendingSettingsRow {
  tenant_id?: string;
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  fallback_hour_utc?: number | null;
  updated_by_user_id?: string | null;
  updated_at?: string;
  /** Read-only pool projection; absence means unknown, never implicitly shared. */
  ip_pool?: { name?: string; dedicated?: boolean } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function isCanonicalQuietHours(row: Record<string, unknown>): boolean {
  for (const field of [
    row.quiet_hours_start,
    row.quiet_hours_end,
    row.quiet_hours_tz,
  ]) {
    if (field !== undefined && typeof field !== "string") return false;
  }
  const start = (row.quiet_hours_start as string | undefined) ?? "";
  const end = (row.quiet_hours_end as string | undefined) ?? "";
  const timezone = (row.quiet_hours_tz as string | undefined) ?? "";
  if (start.length > 5 || end.length > 5 || timezone.length > 128) {
    return false;
  }
  return isCoherentQuietHours(start, end, timezone);
}

function isCanonicalPool(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    hasOnlyKnownFields(value, IP_POOL_FIELDS) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= 160 &&
    typeof value.dedicated === "boolean"
  );
}

export function isCanonicalNoRowProjection(
  value: unknown,
): value is SendingSettingsRow {
  if (!isRecord(value)) return false;
  const hasOwn = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, field);
  return (
    hasOnlyKnownFields(value, SENDING_SETTINGS_FIELDS) &&
    typeof value.tenant_id === "string" &&
    CANONICAL_UUID.test(value.tenant_id) &&
    isCanonicalPool(value.ip_pool) &&
    value.updated_at === "0001-01-01T00:00:00Z" &&
    value.quiet_hours_per_recipient === true &&
    !hasOwn("max_sends_per_hour") &&
    !hasOwn("quiet_hours_start") &&
    !hasOwn("quiet_hours_end") &&
    !hasOwn("quiet_hours_tz") &&
    !hasOwn("fallback_hour_utc") &&
    !hasOwn("updated_by_user_id")
  );
}

/** Runtime boundary for a settings row before it can seed an editable form. */
export function isCanonicalSendingSettingsRow(
  value: unknown,
): value is SendingSettingsRow {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKnownFields(value, SENDING_SETTINGS_FIELDS) ||
    typeof value.tenant_id !== "string" ||
    !CANONICAL_UUID.test(value.tenant_id) ||
    typeof value.quiet_hours_per_recipient !== "boolean" ||
    typeof value.updated_at !== "string" ||
    !isCanonicalSendsPerHour(value.max_sends_per_hour) ||
    !isCanonicalQuietHours(value) ||
    !isCanonicalPool(value.ip_pool)
  ) {
    return false;
  }
  if (
    value.fallback_hour_utc !== undefined &&
    value.fallback_hour_utc !== null &&
    (typeof value.fallback_hour_utc !== "number" ||
      !Number.isSafeInteger(value.fallback_hour_utc) ||
      value.fallback_hour_utc < 0 ||
      value.fallback_hour_utc > 23)
  ) {
    return false;
  }
  if (
    value.updated_by_user_id !== undefined &&
    value.updated_by_user_id !== null &&
    (typeof value.updated_by_user_id !== "string" ||
      !CANONICAL_UUID.test(value.updated_by_user_id))
  ) {
    return false;
  }
  const revision = sendingSettingsExpectedRevision(value.updated_at);
  return (
    revision !== null && (revision !== "" || isCanonicalNoRowProjection(value))
  );
}

function revisionOrderValue(
  revision: string,
): { seconds: number; nanoseconds: number } | null {
  const parsed = Date.parse(revision);
  const fraction =
    /T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      revision,
    );
  if (!Number.isFinite(parsed) || !fraction) return null;
  return {
    seconds: Math.floor(parsed / 1_000),
    nanoseconds: Number((fraction[1] ?? "").padEnd(9, "0")),
  };
}

export function sendingSettingsRevisionStrictlyAdvances(
  candidate: string,
  expected: string,
): boolean {
  if (expected === "") return true;
  const next = revisionOrderValue(candidate);
  const previous = revisionOrderValue(expected);
  return Boolean(
    next &&
    previous &&
    (next.seconds > previous.seconds ||
      (next.seconds === previous.seconds &&
        next.nanoseconds > previous.nanoseconds)),
  );
}
