// SPDX-License-Identifier: AGPL-3.0-only

import {
  isCanonicalSendsPerHour,
  isCoherentQuietHours,
  sendingSettingsExpectedRevision,
} from "./sendingForm";
import { WireShapeError } from "./wireShapeError";

export interface SendingStatus {
  tenantId: string;
  maxSendsPerHour: number | null;
  quietHoursStart: string;
  quietHoursEnd: string;
  quietHoursTz: string;
  quietHoursPerRecipient: boolean;
  bucketCount: number | null;
  windowStart: string | null;
  windowResetsAt: string | null;
  inQuietHours: boolean | null;
  quietChangesAt: string | null;
  counterAuthoritative: boolean;
  counterSource: string;
  counterScope: "shared" | "process" | "unavailable";
  capCoordinationState: "ready" | "conservatively_fenced" | "unavailable";
  capCoordinationReady: boolean;
  capCoordinationCap: number | null;
  capCoordinationMatchesSettings: boolean;
  capCoordinationFenceStartedAt: string | null;
}

type QuietHours = Pick<
  SendingStatus,
  "quietHoursStart" | "quietHoursEnd" | "quietHoursTz"
>;

type Coordination = Pick<
  SendingStatus,
  | "capCoordinationState"
  | "capCoordinationReady"
  | "capCoordinationCap"
  | "capCoordinationMatchesSettings"
  | "capCoordinationFenceStartedAt"
>;

const INVALID = Symbol("invalid-wire-value");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictCap(value: unknown): number | null | typeof INVALID {
  return isCanonicalSendsPerHour(value)
    ? ((value as number | null | undefined) ?? null)
    : INVALID;
}

function strictTimestamp(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  return sendingSettingsExpectedRevision(value) ? value : INVALID;
}

function parseQuietHours(row: Record<string, unknown>): QuietHours | null {
  const start = row.quiet_hours_start ?? "";
  const end = row.quiet_hours_end ?? "";
  const timezone = row.quiet_hours_tz ?? "";
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    typeof timezone !== "string" ||
    start.length > 5 ||
    end.length > 5 ||
    timezone.length > 128 ||
    !isCoherentQuietHours(start, end, timezone)
  ) {
    return null;
  }
  return {
    quietHoursStart: start,
    quietHoursEnd: end,
    quietHoursTz: timezone,
  };
}

function hasUnavailableCounterContract(row: Record<string, unknown>): boolean {
  return (
    row.counter_authoritative === false &&
    row.counter_source === "unavailable" &&
    row.counter_scope === "unavailable" &&
    (row.bucket_count === undefined || row.bucket_count === null) &&
    (row.window_start === undefined || row.window_start === null) &&
    (row.window_resets_at === undefined || row.window_resets_at === null)
  );
}

function parseCoordination(
  row: Record<string, unknown>,
  settingsCap: number | null,
): Coordination | null {
  const state = row.cap_coordination_state;
  const ready = row.cap_coordination_ready;
  const matches = row.cap_coordination_matches_settings;
  const cap = strictCap(row.cap_coordination_cap);
  const fence = strictTimestamp(row.cap_coordination_fence_started_at);
  if (cap === INVALID || fence === INVALID) return null;

  if (state === "ready") {
    if (ready !== true || typeof matches !== "boolean" || fence !== null) {
      return null;
    }
    if (matches && cap !== settingsCap) return null;
  } else if (state === "conservatively_fenced") {
    if (ready !== false || matches !== false || fence === null) return null;
  } else if (state === "unavailable") {
    if (
      ready !== false ||
      matches !== false ||
      cap !== null ||
      fence !== null
    ) {
      return null;
    }
  } else {
    return null;
  }

  return {
    capCoordinationState: state,
    capCoordinationReady: ready,
    capCoordinationCap: cap,
    capCoordinationMatchesSettings: matches,
    capCoordinationFenceStartedAt: fence,
  };
}

export function parseSendingStatus(value: unknown): SendingStatus {
  if (!isRecord(value)) throw new WireShapeError("sending status");
  const tenantId = value.tenant_id;
  const cap = strictCap(value.max_sends_per_hour);
  const quiet = parseQuietHours(value);
  const coordination = cap === INVALID ? null : parseCoordination(value, cap);
  const quietChangesAt = strictTimestamp(value.quiet_changes_at);
  const inQuietHours = value.in_quiet_hours ?? null;
  if (
    typeof tenantId !== "string" ||
    tenantId.trim().length === 0 ||
    tenantId.length > 128 ||
    cap === INVALID ||
    quiet === null ||
    typeof value.quiet_hours_per_recipient !== "boolean" ||
    (inQuietHours !== null && typeof inQuietHours !== "boolean") ||
    quietChangesAt === INVALID ||
    !hasUnavailableCounterContract(value) ||
    coordination === null
  ) {
    throw new WireShapeError("sending status");
  }

  return {
    tenantId,
    maxSendsPerHour: cap,
    ...quiet,
    quietHoursPerRecipient: value.quiet_hours_per_recipient,
    bucketCount: null,
    windowStart: null,
    windowResetsAt: null,
    inQuietHours,
    quietChangesAt,
    counterAuthoritative: false,
    counterSource: "unavailable",
    counterScope: "unavailable",
    ...coordination,
  };
}
