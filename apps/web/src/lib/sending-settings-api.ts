// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for the tenant sending-limits editor: hourly cap + quiet-hours window
// (SETC-012). Backend: apps/api/internal/sendingsettings/sendingsettings.go
// (GET/PUT /api/v1/settings/sending). The PUT is a full-replace of the cap +
// quiet-hours fields, so callers send the complete intended state.

import { api, ApiError } from "./api";
import { isKnownTimeZone } from "./timezones";

const CAP_OUTCOME_HEADER = "x-postwave-sending-cap-outcome";
export const SENDING_SETTINGS_QUIESCENCE_MS = 35_000;
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

export function sendingSettingsMonotonicNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Number.NaN;
}

export interface SendingSettings {
  tenant_id: string;
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient: boolean;
  /** SETA-041: STO cold-start fallback send hour (0–23 UTC); null = none. */
  fallback_hour_utc?: number | null;
  updated_by_user_id?: string | null;
  ip_pool?: { name: string; dedicated: boolean };
  updated_at?: string;
}

export interface SendingSettingsInput {
  /** null / omitted = no workspace-specific ceiling; must be >= 1 when set. */
  max_sends_per_hour: number | null;
  /** HH:MM 24h. Start/end/tz must all be set together, or all be empty. */
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  quiet_hours_per_recipient: boolean;
  /** Exact loaded revision. Empty string asserts that no durable row exists. */
  expected_updated_at: string;
}

export interface SendingSettingsStatus {
  tenant_id: string;
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  cap_coordination_state?: string;
  cap_coordination_ready?: boolean;
  cap_coordination_cap?: number | null;
  cap_coordination_matches_settings?: boolean;
  cap_coordination_fence_started_at?: string | null;
}

export type SendingSettingsMutationDisposition =
  | "not-committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown"
  | "transport-outcome-unknown"
  | "protocol-outcome-unknown";

/**
 * A PUT result whose retry semantics differ from an ordinary HTTP failure.
 * Callers must reconcile every disposition except the exact not-committed one
 * before another write is enabled.
 */
export class SendingSettingsMutationOutcomeError extends Error {
  readonly requiresReconciliation: boolean;

  constructor(
    readonly disposition: SendingSettingsMutationDisposition,
    message: string,
    readonly original: unknown,
  ) {
    super(message);
    this.name = "SendingSettingsMutationOutcomeError";
    this.requiresReconciliation = disposition !== "not-committed";
  }
}

export type SendingSettingsReconciliation =
  | { kind: "applied"; settings: SendingSettings }
  | { kind: "not-applied"; settings: SendingSettings; message: string }
  | { kind: "conflict"; settings: SendingSettings; message: string }
  | { kind: "pending"; settings?: SendingSettings; message: string };

function errorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

function classifyMutationFailure(
  error: unknown,
  response: { status: number; capOutcome: string | null } | null,
): SendingSettingsMutationOutcomeError | null {
  if (error instanceof SendingSettingsMutationOutcomeError) return error;
  if (error instanceof ApiError && error.status === 0) {
    if (error.kind === "offline") {
      return new SendingSettingsMutationOutcomeError(
        "not-committed",
        error.message,
        error,
      );
    }
    return new SendingSettingsMutationOutcomeError(
      "transport-outcome-unknown",
      "The request outcome could not be confirmed. Canonical settings must be checked before retrying.",
      error,
    );
  }
  // Every HTTP failure needs an explicit receipt. `not-committed` is the only
  // disposition that makes a fresh manual attempt safe; a proxy-generated
  // 4xx with no header is just as unproven as a malformed 5xx.
  if (response?.capOutcome === "not-committed" && response.status >= 400) {
    return null;
  }
  if (response?.status !== 503 || errorStatus(error) !== 503) {
    const status = response?.status ?? errorStatus(error);
    if (
      (typeof status === "number" && status !== 200) ||
      (response !== null && response.status !== 200) ||
      (error instanceof ApiError && error.kind === "parse")
    ) {
      return new SendingSettingsMutationOutcomeError(
        "protocol-outcome-unknown",
        "The write response could not prove whether settings committed. Canonical settings must be checked before retrying.",
        error,
      );
    }
    return null;
  }

  const code = errorCode(error);
  if (
    response.capOutcome === "committed-conservatively-fenced" &&
    code === "sending_cap_convergence_pending"
  ) {
    return new SendingSettingsMutationOutcomeError(
      "committed-conservatively-fenced",
      "The settings committed, but shared sending-cap convergence is still fenced.",
      error,
    );
  }
  if (
    response.capOutcome === "commit-outcome-unknown-conservatively-fenced" &&
    code === "sending_cap_commit_outcome_unknown"
  ) {
    return new SendingSettingsMutationOutcomeError(
      "commit-outcome-unknown",
      "The database outcome is unknown and sending remains conservatively fenced.",
      error,
    );
  }
  return new SendingSettingsMutationOutcomeError(
    "protocol-outcome-unknown",
    "The server returned an unrecognised sending-settings outcome. Canonical settings must be checked before retrying.",
    error,
  );
}

export function sendingSettingsRevision(
  settings: SendingSettings,
): string | null {
  const revision = settings.updated_at?.trim() ?? "";
  if (revision === "0001-01-01T00:00:00Z") return "";
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(
      revision,
    );
  if (!match || !Number.isFinite(Date.parse(revision))) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const offsetHours = Number(match[4] ?? 0);
  const offsetMinutes = Number(match[5] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    offsetHours > 14 ||
    (offsetHours === 14 && offsetMinutes !== 0)
  ) {
    return null;
  }
  return revision;
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

function revisionStrictlyAdvances(
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

function isSendingSettings(value: unknown): value is SendingSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  if (!hasOnlyKnownFields(row, SENDING_SETTINGS_FIELDS)) return false;
  const cap = row.max_sends_per_hour;
  const settings = value as SendingSettings;
  const quietStart = settings.quiet_hours_start ?? "";
  const quietEnd = settings.quiet_hours_end ?? "";
  const quietTimezone = settings.quiet_hours_tz ?? "";
  const quietSetCount = [quietStart, quietEnd, quietTimezone].filter(
    Boolean,
  ).length;
  const pool = row.ip_pool;
  const poolIsValid =
    pool === undefined ||
    (typeof pool === "object" &&
      pool !== null &&
      !Array.isArray(pool) &&
      hasOnlyKnownFields(pool as Record<string, unknown>, IP_POOL_FIELDS) &&
      typeof (pool as Record<string, unknown>).name === "string" &&
      ((pool as Record<string, unknown>).name as string).trim().length > 0 &&
      ((pool as Record<string, unknown>).name as string).length <= 160 &&
      typeof (pool as Record<string, unknown>).dedicated === "boolean");
  const shapeIsValid =
    typeof row.tenant_id === "string" &&
    CANONICAL_UUID.test(row.tenant_id) &&
    typeof row.quiet_hours_per_recipient === "boolean" &&
    typeof row.updated_at === "string" &&
    (cap === undefined ||
      cap === null ||
      (typeof cap === "number" &&
        Number.isSafeInteger(cap) &&
        cap >= 1 &&
        cap <= 1_000_000)) &&
    optionalSettingsString(row.quiet_hours_start) &&
    optionalSettingsString(row.quiet_hours_end) &&
    optionalSettingsString(row.quiet_hours_tz) &&
    quietStart.length <= 5 &&
    quietEnd.length <= 5 &&
    quietTimezone.length <= 128 &&
    (quietSetCount === 0 ||
      (quietSetCount === 3 &&
        /^([01]\d|2[0-3]):[0-5]\d$/u.test(quietStart) &&
        /^([01]\d|2[0-3]):[0-5]\d$/u.test(quietEnd) &&
        quietStart !== quietEnd &&
        isKnownTimeZone(quietTimezone))) &&
    (row.fallback_hour_utc === undefined ||
      row.fallback_hour_utc === null ||
      (typeof row.fallback_hour_utc === "number" &&
        Number.isInteger(row.fallback_hour_utc) &&
        row.fallback_hour_utc >= 0 &&
        row.fallback_hour_utc <= 23)) &&
    (row.updated_by_user_id === undefined ||
      row.updated_by_user_id === null ||
      (typeof row.updated_by_user_id === "string" &&
        CANONICAL_UUID.test(row.updated_by_user_id))) &&
    poolIsValid;
  if (!shapeIsValid) return false;
  const revision = sendingSettingsRevision(settings);
  return (
    revision !== null &&
    (revision !== "" || isCanonicalNoRowProjection(settings))
  );
}

function optionalSettingsString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function isCanonicalNoRowProjection(settings: SendingSettings): boolean {
  const row = settings as unknown as Record<string, unknown>;
  const hasOwn = (field: string): boolean =>
    Object.prototype.hasOwnProperty.call(row, field);
  return (
    hasOnlyKnownFields(row, SENDING_SETTINGS_FIELDS) &&
    typeof row.tenant_id === "string" &&
    CANONICAL_UUID.test(row.tenant_id) &&
    settings.updated_at?.trim() === "0001-01-01T00:00:00Z" &&
    settings.quiet_hours_per_recipient === true &&
    !hasOwn("max_sends_per_hour") &&
    !hasOwn("quiet_hours_start") &&
    !hasOwn("quiet_hours_end") &&
    !hasOwn("quiet_hours_tz") &&
    !hasOwn("fallback_hour_utc") &&
    !hasOwn("updated_by_user_id")
  );
}

function isCanonicalReadySendingSettingsStatus(
  value: unknown,
): value is SendingSettingsStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const status = value as Record<string, unknown>;
  const settingsCap = status.max_sends_per_hour;
  const coordinationCap = status.cap_coordination_cap;
  return (
    typeof status.tenant_id === "string" &&
    status.tenant_id.length > 0 &&
    typeof status.quiet_hours_per_recipient === "boolean" &&
    status.cap_coordination_state === "ready" &&
    status.cap_coordination_ready === true &&
    status.cap_coordination_matches_settings === true &&
    (status.cap_coordination_fence_started_at === undefined ||
      status.cap_coordination_fence_started_at === null) &&
    (settingsCap === undefined ||
      settingsCap === null ||
      (typeof settingsCap === "number" &&
        Number.isSafeInteger(settingsCap) &&
        settingsCap >= 1 &&
        settingsCap <= 1_000_000)) &&
    (coordinationCap === undefined ||
      coordinationCap === null ||
      (typeof coordinationCap === "number" &&
        Number.isSafeInteger(coordinationCap) &&
        coordinationCap >= 1 &&
        coordinationCap <= 1_000_000)) &&
    optionalSettingsString(status.quiet_hours_start) &&
    optionalSettingsString(status.quiet_hours_end) &&
    optionalSettingsString(status.quiet_hours_tz)
  );
}

export function sendingSettingsMatchInput(
  settings: SendingSettings,
  input: SendingSettingsInput,
): boolean {
  return (
    (settings.max_sends_per_hour ?? null) === input.max_sends_per_hour &&
    (settings.quiet_hours_start ?? "") === input.quiet_hours_start &&
    (settings.quiet_hours_end ?? "") === input.quiet_hours_end &&
    (settings.quiet_hours_tz ?? "") === input.quiet_hours_tz &&
    settings.quiet_hours_per_recipient === input.quiet_hours_per_recipient
  );
}

function statusProvesSettings(
  status: SendingSettingsStatus,
  settings: SendingSettings,
  expectedTenantId: string,
): boolean {
  const cap = settings.max_sends_per_hour ?? null;
  return (
    status.tenant_id === expectedTenantId &&
    status.cap_coordination_state === "ready" &&
    status.cap_coordination_ready === true &&
    status.cap_coordination_matches_settings === true &&
    (status.max_sends_per_hour ?? null) === cap &&
    (status.cap_coordination_cap ?? null) === cap &&
    (status.quiet_hours_start ?? "") === (settings.quiet_hours_start ?? "") &&
    (status.quiet_hours_end ?? "") === (settings.quiet_hours_end ?? "") &&
    (status.quiet_hours_tz ?? "") === (settings.quiet_hours_tz ?? "") &&
    status.quiet_hours_per_recipient === settings.quiet_hours_per_recipient
  );
}

/**
 * Resolve an ambiguous PUT with canonical state only. This function never
 * sends a second PUT.
 */
export async function reconcileSendingSettingsMutation(
  input: SendingSettingsInput,
  expectedTenantId: string,
  signal?: AbortSignal,
  mutationDispatchedAt?: number,
): Promise<SendingSettingsReconciliation> {
  const reconciliationStartedAt = sendingSettingsMonotonicNow();
  const notAppliedProofAllowed = Boolean(
    Number.isFinite(mutationDispatchedAt) &&
    Number.isFinite(reconciliationStartedAt) &&
    reconciliationStartedAt >=
      (mutationDispatchedAt ?? Number.POSITIVE_INFINITY) &&
    reconciliationStartedAt - (mutationDispatchedAt ?? 0) >=
      SENDING_SETTINGS_QUIESCENCE_MS,
  );
  const [settingsResult, statusResult] = await Promise.allSettled([
    sendingSettingsApi.get(signal),
    sendingSettingsApi.status(signal),
  ]);
  if (
    settingsResult.status !== "fulfilled" ||
    !isSendingSettings(settingsResult.value)
  ) {
    return {
      kind: "pending",
      message:
        "The request outcome is still unknown because canonical settings could not be loaded. Restore connectivity and refresh to reconcile.",
    };
  }
  const settings = settingsResult.value;
  if (!expectedTenantId || settings.tenant_id !== expectedTenantId) {
    return {
      kind: "pending",
      message:
        "The verification response did not match the active workspace. Editing remains held until the workspace state can be verified.",
    };
  }
  const statusProvesCurrentSettings =
    statusResult.status === "fulfilled" &&
    isCanonicalReadySendingSettingsStatus(statusResult.value) &&
    statusProvesSettings(statusResult.value, settings, expectedTenantId);
  const verifiedRevision = sendingSettingsRevision(settings);
  if (
    input.expected_updated_at === "" &&
    isCanonicalNoRowProjection(settings)
  ) {
    return notAppliedProofAllowed && statusProvesCurrentSettings
      ? {
          kind: "not-applied",
          settings,
          message:
            "No durable sending-settings row exists after the mutation window, so the first write did not apply. Your draft is intact and can be retried.",
        }
      : {
          kind: "pending",
          settings,
          message:
            "No durable row is visible yet, but the mutation window has not been proven quiescent with ready shared authority. Editing remains held until a fresh reconciliation.",
        };
  }
  if (verifiedRevision === null || verifiedRevision === "") {
    return {
      kind: "pending",
      settings,
      message:
        "Canonical settings did not provide a durable revision. Editing remains held until the write outcome can be verified.",
    };
  }
  const settingsMatch = sendingSettingsMatchInput(settings, input);
  if (verifiedRevision === input.expected_updated_at) {
    return notAppliedProofAllowed && statusProvesCurrentSettings
      ? {
          kind: "not-applied",
          settings,
          message:
            "The prior server revision is still current after the mutation window, so the change did not apply. Your draft is intact and can be retried.",
        }
      : {
          kind: "pending",
          settings,
          message:
            "The prior revision is still visible, but the mutation window has not been proven quiescent with ready shared authority. Editing remains held until a fresh reconciliation.",
        };
  }
  if (
    input.expected_updated_at !== "" &&
    !revisionStrictlyAdvances(verifiedRevision, input.expected_updated_at)
  ) {
    return {
      kind: "pending",
      settings,
      message:
        "Canonical settings did not provide a revision newer than the submitted baseline. Editing remains held until the write outcome can be verified.",
    };
  }
  if (settingsMatch) {
    if (statusProvesCurrentSettings) {
      return { kind: "applied", settings };
    }
    return {
      kind: "pending",
      settings,
      message:
        "The settings are persisted, but the shared sending-cap authority is not yet proven ready. Sending remains conservatively protected; refresh to reconcile.",
    };
  }
  return {
    kind: "conflict",
    settings,
    message:
      "The server now has a different settings revision. Your draft is intact; review the current server version before making another change.",
  };
}

export const sendingSettingsApi = {
  get: async (signal?: AbortSignal): Promise<SendingSettings> => {
    const value = await api.get<unknown>("/api/v1/settings/sending", {
      cache: "no-store",
      signal,
    });
    if (!isSendingSettings(value)) {
      throw new Error(
        "The server sent an invalid sending-settings response. Existing values remain protected.",
      );
    }
    return value;
  },
  status: (signal?: AbortSignal) =>
    api.get<SendingSettingsStatus>("/api/v1/settings/sending/status", {
      cache: "no-store",
      signal,
    }),
  put: async (
    input: SendingSettingsInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<SendingSettings> => {
    let response: { status: number; capOutcome: string | null } | null = null;
    try {
      const value = await api.put<unknown>("/api/v1/settings/sending", input, {
        requireOnline: true,
        maxAttempts: 1,
        // This full-replace compare-and-set write deliberately has no
        // idempotency-key contract. `null` also strips any caller/default
        // header in the shared transport instead of merely declining to mint
        // one, so a successful response can be treated as exactly one attempt.
        idempotencyKey: null,
        allowStepUpRetry: false,
        redirect: "error",
        signal: options.signal,
        onResponse: (res) => {
          response = {
            status: res.status,
            capOutcome: res.headers.get(CAP_OUTCOME_HEADER),
          };
        },
      });
      if (response === null) {
        throw new SendingSettingsMutationOutcomeError(
          "protocol-outcome-unknown",
          "The server response did not include a verifiable sending-cap outcome.",
          null,
        );
      }
      const observed = response as {
        status: number;
        capOutcome: string | null;
      };
      if (observed.status !== 200 || observed.capOutcome !== "committed") {
        throw new SendingSettingsMutationOutcomeError(
          "protocol-outcome-unknown",
          "The server response did not include an exact committed sending-cap receipt.",
          null,
        );
      }
      const committedRevision = isSendingSettings(value)
        ? sendingSettingsRevision(value)
        : null;
      if (
        !isSendingSettings(value) ||
        !sendingSettingsMatchInput(value, input) ||
        !committedRevision ||
        !revisionStrictlyAdvances(committedRevision, input.expected_updated_at)
      ) {
        throw new SendingSettingsMutationOutcomeError(
          "protocol-outcome-unknown",
          "The committed response did not prove the submitted settings and a new canonical revision.",
          value,
        );
      }
      return value;
    } catch (error) {
      throw classifyMutationFailure(error, response) ?? error;
    }
  },
};
