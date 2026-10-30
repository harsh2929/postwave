import type {
  TriggerDelayPreference,
  ZeroCopyRuntimeDescriptor,
  ZeroCopyTrigger,
} from "../../lib/api-client";

import {
  isCanonicalSubscriberUUID,
  MAX_DELAY_SECONDS,
} from "./trigger-delay-helpers";
import {
  MAX_POLL_INTERVAL_SECONDS,
  MAX_ROWS_PER_TICK,
  MIN_POLL_INTERVAL_SECONDS,
  isCanonicalTriggerReference,
} from "./zero-copy-helpers";

export type ResponseNormalization<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export interface SafeFireRecord {
  id: number;
  triggerId: string;
  status: string;
  firedAt: string;
  hasCursor: boolean;
  hasProfileKey: boolean;
  hasSubscriber: boolean;
  hasPayload: boolean;
  hasFlowRun: boolean;
  errorCategory?: "execution_error";
}

export interface SafeRuntimeDescriptor {
  capability: string;
  runtimeStatus: string;
  executionEnabled: boolean;
  code: string;
  message: string;
  prerequisites: string[];
}

export interface SafeAlertConfig {
  triggerId: string;
  runtime: SafeRuntimeDescriptor;
  consecutiveFailuresThreshold: number;
  lagSecondsThreshold: number;
  firesPerTickThreshold: number;
  webhookConfigured: boolean;
  cooldownSeconds: number;
  lastAlertFiredAt?: string;
  lastAlertKind?: "failures" | "lag" | "fires_burst";
  hasLastAlertMessage: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SafeDLQRecord {
  id: number;
  triggerId: string;
  reason: "unresolved_subscriber" | "enqueue_failed" | "driver_partial_row";
  retryCount: number;
  lastRetriedAt?: string;
  status: "pending" | "resolved" | "abandoned";
  createdAt: string;
  updatedAt: string;
  hasCursor: boolean;
  hasProfileKey: boolean;
  hasPayload: boolean;
  lastErrorCategory?: "execution_error";
}

export interface TriggerDefinitionsPage {
  items: ZeroCopyTrigger[];
  nextCursor?: string;
  totalEstimate?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function optionalText(value: unknown, max = 512): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, max);
}

function integer(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) &&
    Number(value) >= min &&
    Number(value) <= max
    ? Number(value)
    : null;
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | null {
  return typeof value === "string" && allowed.includes(value)
    ? (value as T[number])
    : null;
}

function timestamp(
  value: unknown,
  optional = false,
): string | null | undefined {
  if (optional && (value === undefined || value === null || value === ""))
    return undefined;
  const normalized = text(value, 64);
  return normalized && Number.isFinite(Date.parse(normalized))
    ? normalized
    : null;
}

function suffix(value: unknown): string | undefined | null {
  const normalized = optionalText(value, 2_048);
  if (normalized === null) return null;
  return normalized ? normalized.slice(-4) : undefined;
}

const INVALID_JSON = Symbol("invalid-json");
const FORBIDDEN_CONFIG_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function safeConfig(
  value: unknown,
): Record<string, unknown> | undefined | null {
  if (value === undefined || value === null) return undefined;
  let nodes = 0;

  const clone = (
    candidate: unknown,
    depth: number,
  ): unknown | typeof INVALID_JSON => {
    nodes += 1;
    if (nodes > 50_000 || depth > 32) return INVALID_JSON;
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate;
    }
    if (typeof candidate === "string") {
      return candidate.length <= 1_048_576 ? candidate : INVALID_JSON;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > 10_000) return INVALID_JSON;
      const output: unknown[] = [];
      for (const item of candidate) {
        const cloned = clone(item, depth + 1);
        if (cloned === INVALID_JSON) return INVALID_JSON;
        output.push(cloned);
      }
      return output;
    }
    if (!candidate || typeof candidate !== "object") return INVALID_JSON;
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_JSON;
    }
    const entries = Object.entries(candidate);
    if (entries.length > 10_000) return INVALID_JSON;
    const output: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (!key || key.length > 256 || FORBIDDEN_CONFIG_KEYS.has(key)) {
        return INVALID_JSON;
      }
      const cloned = clone(item, depth + 1);
      if (cloned === INVALID_JSON) return INVALID_JSON;
      output[key] = cloned;
    }
    return output;
  };

  const cloned = clone(value, 0);
  if (
    cloned === INVALID_JSON ||
    !cloned ||
    typeof cloned !== "object" ||
    Array.isArray(cloned) ||
    JSON.stringify(cloned).length > 1_048_576
  ) {
    return null;
  }
  return cloned as Record<string, unknown>;
}

function runtimeDescriptor(value: unknown): SafeRuntimeDescriptor | null {
  const row = record(value);
  if (!row) return null;
  const capability = text(row.capability, 128);
  const runtimeStatus = text(row.runtime_status, 64);
  const executionEnabled = boolean(row.execution_enabled);
  const code = text(row.code, 128);
  const message = text(row.message, 1_024);
  const rawPrerequisites = row.prerequisites ?? [];
  if (
    !capability ||
    !runtimeStatus ||
    executionEnabled === null ||
    !code ||
    !message ||
    !Array.isArray(rawPrerequisites) ||
    rawPrerequisites.length > 50
  ) {
    return null;
  }
  // Accept BOTH runtime states.
  //
  // This used to require `unavailable` and reject anything else, which meant
  // the first observable effect of the server enabling execution was
  // `normalizeTriggerDefinitions` returning malformed for the ENTIRE list — a
  // client that only parses the answer it already expects is a client that
  // breaks on the day the answer changes. The pairs are still checked against
  // each other, so a descriptor that says "available" while claiming the
  // unavailable code is still rejected: it is contradictory, not merely new.
  if (capability !== "zero_copy_trigger_execution") return null;
  const consistentlyUnavailable =
    runtimeStatus === "unavailable" &&
    !executionEnabled &&
    code === "zero_copy_runtime_unavailable";
  const consistentlyAvailable =
    runtimeStatus === "available" &&
    executionEnabled &&
    code === "zero_copy_runtime_available";
  if (!consistentlyUnavailable && !consistentlyAvailable) return null;
  const prerequisites = rawPrerequisites.map((item) => text(item, 128));
  if (prerequisites.some((item) => item === null)) return null;
  return {
    capability,
    runtimeStatus,
    executionEnabled,
    code,
    message,
    prerequisites: prerequisites as string[],
  };
}

export function normalizeTriggerDefinitions(
  input: unknown,
): ResponseNormalization<ZeroCopyTrigger[]> {
  if (!Array.isArray(input)) return malformed("trigger definition list");
  const ids = new Set<string>();
  const items: ZeroCopyTrigger[] = [];
  for (const candidate of input) {
    const row = record(candidate);
    if (!row) return malformed("trigger definition list");
    const id = text(row.id, 128);
    const name = text(row.name, 256);
    const description = optionalText(row.description, Number.MAX_SAFE_INTEGER);
    const status = text(row.status, 64);
    const provider = text(row.provider, 64);
    const query =
      typeof row.query === "string" && row.query.length <= 100_000
        ? row.query
        : null;
    const cursorColumn =
      typeof row.cursor_column === "string" ? row.cursor_column : null;
    const profileKeyColumn =
      typeof row.profile_key_column === "string"
        ? row.profile_key_column
        : null;
    const interval = integer(
      row.polling_interval_seconds,
      MIN_POLL_INTERVAL_SECONDS,
      MAX_POLL_INTERVAL_SECONDS,
    );
    const maxRows = integer(row.max_rows_per_tick, 1, MAX_ROWS_PER_TICK);
    const failures = integer(
      row.consecutive_failures,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const enqueueRows = integer(
      row.rows_fired_total,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const lastPolled = timestamp(row.last_polled_at, true);
    const lastSuccess = timestamp(row.last_success_at, true);
    const lastSeen = suffix(row.last_seen_cursor);
    const connectionId = optionalText(row.connection_id, 128);
    const journeyId = optionalText(row.journey_id, 128);
    const config = safeConfig(row.config);
    const createdAt = timestamp(row.created_at, true);
    const updatedAt = timestamp(row.updated_at, true);
    const safeRuntime = runtimeDescriptor(row.runtime);
    if (
      !id ||
      !name ||
      !status ||
      !provider ||
      ids.has(id) ||
      query === null ||
      cursorColumn === null ||
      profileKeyColumn === null ||
      interval === null ||
      maxRows === null ||
      failures === null ||
      enqueueRows === null ||
      lastPolled === null ||
      lastSuccess === null ||
      lastSeen === null ||
      description === null ||
      connectionId === null ||
      journeyId === null ||
      (connectionId !== undefined &&
        !isCanonicalTriggerReference(connectionId)) ||
      (journeyId !== undefined && !isCanonicalTriggerReference(journeyId)) ||
      config === null ||
      createdAt === null ||
      updatedAt === null ||
      !safeRuntime
    )
      return malformed("trigger definition identities or fields");
    ids.add(id);
    items.push({
      id,
      name,
      status,
      provider,
      query,
      cursor_column: cursorColumn,
      profile_key_column: profileKeyColumn,
      polling_interval_seconds: interval,
      max_rows_per_tick: maxRows,
      consecutive_failures: failures,
      rows_fired_total: enqueueRows,
      ...(description ? { description } : {}),
      ...(connectionId ? { connection_id: connectionId.toLowerCase() } : {}),
      ...(journeyId ? { journey_id: journeyId.toLowerCase() } : {}),
      ...(config ? { config } : {}),
      ...(lastPolled ? { last_polled_at: lastPolled } : {}),
      ...(lastSuccess ? { last_success_at: lastSuccess } : {}),
      ...(lastSeen ? { last_seen_cursor: lastSeen } : {}),
      ...(row.last_error ? { last_error: "recorded" } : {}),
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      runtime: {
        capability: safeRuntime.capability,
        runtime_status: safeRuntime.runtimeStatus,
        execution_enabled: safeRuntime.executionEnabled,
        code: safeRuntime.code,
        message: safeRuntime.message,
        ...(safeRuntime.prerequisites.length > 0
          ? { prerequisites: safeRuntime.prerequisites }
          : {}),
      } satisfies ZeroCopyRuntimeDescriptor,
    });
  }
  return { ok: true, value: items };
}

export function normalizeTriggerDefinition(
  input: unknown,
  expectedId?: string,
): ResponseNormalization<ZeroCopyTrigger> {
  const normalized = normalizeTriggerDefinitions([input]);
  if (!normalized.ok) return normalized;
  const trigger = normalized.value[0];
  if (!trigger || (expectedId !== undefined && trigger.id !== expectedId)) {
    return malformed("trigger definition identity");
  }
  return { ok: true, value: trigger };
}

export function normalizeTriggerDefinitionsPage(
  input: unknown,
): ResponseNormalization<TriggerDefinitionsPage> {
  const source = record(input);
  if (!source) return malformed("trigger definition page");
  const normalizedItems = normalizeTriggerDefinitions(source.items);
  if (!normalizedItems.ok) return normalizedItems;
  const nextCursor = optionalText(source.nextCursor, 4_096);
  const totalEstimate =
    source.totalEstimate === undefined
      ? undefined
      : integer(source.totalEstimate, 0, Number.MAX_SAFE_INTEGER);
  if (
    nextCursor === null ||
    (nextCursor !== undefined && !/^[A-Za-z0-9_-]+$/u.test(nextCursor)) ||
    totalEstimate === null
  ) {
    return malformed("trigger definition pagination metadata");
  }
  return {
    ok: true,
    value: {
      items: normalizedItems.value,
      ...(nextCursor ? { nextCursor } : {}),
      ...(totalEstimate !== undefined ? { totalEstimate } : {}),
    },
  };
}

export function normalizeFireResponse(
  input: unknown,
  expectedTriggerId?: string,
): ResponseNormalization<{ items: SafeFireRecord[] }> {
  const source = record(input);
  if (!source || !Array.isArray(source.items))
    return malformed("enqueue record list");
  const ids = new Set<number>();
  const items: SafeFireRecord[] = [];
  for (const candidate of source.items) {
    const row = record(candidate);
    if (!row) return malformed("enqueue record list");
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    const triggerId = text(row.trigger_id, 128);
    const status = text(row.status, 64);
    const firedAt = timestamp(row.fired_at);
    const hasCursor = boolean(row.has_cursor);
    const hasProfileKey = boolean(row.has_profile_key);
    const hasSubscriber = boolean(row.has_subscriber);
    const hasPayload = boolean(row.has_payload);
    const hasFlowRun = boolean(row.has_flow_run);
    const errorCategory =
      row.error_category === undefined || row.error_category === ""
        ? undefined
        : oneOf(row.error_category, ["execution_error"] as const);
    if (
      !id ||
      !triggerId ||
      (expectedTriggerId !== undefined && triggerId !== expectedTriggerId) ||
      !status ||
      !firedAt ||
      ids.has(id) ||
      hasCursor === null ||
      hasProfileKey === null ||
      hasSubscriber === null ||
      hasPayload === null ||
      hasFlowRun === null ||
      errorCategory === null
    ) {
      return malformed("enqueue record identities or fields");
    }
    ids.add(id);
    items.push({
      id,
      triggerId,
      status,
      firedAt,
      hasCursor,
      hasProfileKey,
      hasSubscriber,
      hasPayload,
      hasFlowRun,
      ...(errorCategory ? { errorCategory } : {}),
    });
  }
  return { ok: true, value: { items } };
}

export function normalizeAlertConfig(
  input: unknown,
  expectedTriggerId?: string,
): ResponseNormalization<SafeAlertConfig> {
  const row = record(input);
  if (!row) return malformed("alert configuration");
  const triggerId = text(row.trigger_id, 128);
  const runtime = runtimeDescriptor(row.runtime);
  const failures = integer(
    row.consecutive_failures_threshold,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const lag = integer(row.lag_seconds_threshold, 0, Number.MAX_SAFE_INTEGER);
  const perTick = integer(
    row.fires_per_tick_threshold,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const cooldown = integer(row.cooldown_seconds, 0, Number.MAX_SAFE_INTEGER);
  const webhookConfigured = boolean(row.webhook_configured);
  const lastAlert = timestamp(row.last_alert_fired_at, true);
  const lastAlertKind =
    row.last_alert_kind === undefined || row.last_alert_kind === ""
      ? undefined
      : oneOf(row.last_alert_kind, ["failures", "lag", "fires_burst"] as const);
  const hasLastAlertMessage = boolean(row.has_last_alert_message);
  const createdAt = timestamp(row.created_at, true);
  const updatedAt = timestamp(row.updated_at, true);
  if (
    !triggerId ||
    (expectedTriggerId !== undefined && triggerId !== expectedTriggerId) ||
    !runtime ||
    failures === null ||
    lag === null ||
    perTick === null ||
    cooldown === null ||
    webhookConfigured === null ||
    lastAlert === null ||
    lastAlertKind === null ||
    hasLastAlertMessage === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return malformed("alert configuration");
  }
  return {
    ok: true,
    value: {
      triggerId,
      runtime,
      consecutiveFailuresThreshold: failures,
      lagSecondsThreshold: lag,
      firesPerTickThreshold: perTick,
      webhookConfigured,
      cooldownSeconds: cooldown,
      hasLastAlertMessage,
      ...(lastAlert ? { lastAlertFiredAt: lastAlert } : {}),
      ...(lastAlertKind ? { lastAlertKind } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    },
  };
}

export function normalizeDLQResponse(
  input: unknown,
  expectedTriggerId?: string,
): ResponseNormalization<{ items: SafeDLQRecord[] }> {
  const source = record(input);
  if (!source || !Array.isArray(source.items))
    return malformed("recovery record list");
  const ids = new Set<number>();
  const items: SafeDLQRecord[] = [];
  for (const candidate of source.items) {
    const row = record(candidate);
    if (!row) return malformed("recovery record list");
    const id = integer(row.id, 1, Number.MAX_SAFE_INTEGER);
    const triggerId = text(row.trigger_id, 128);
    const status = oneOf(row.status, [
      "pending",
      "resolved",
      "abandoned",
    ] as const);
    const reason = oneOf(row.reason, [
      "unresolved_subscriber",
      "enqueue_failed",
      "driver_partial_row",
    ] as const);
    const retryCount = integer(row.retry_count, 0, Number.MAX_SAFE_INTEGER);
    const lastRetriedAt = timestamp(row.last_retried_at, true);
    const createdAt = timestamp(row.created_at);
    const updatedAt = timestamp(row.updated_at);
    const hasCursor = boolean(row.has_cursor);
    const hasProfileKey = boolean(row.has_profile_key);
    const hasPayload = boolean(row.has_payload);
    const lastErrorCategory =
      row.last_error_category === undefined || row.last_error_category === ""
        ? undefined
        : oneOf(row.last_error_category, ["execution_error"] as const);
    if (
      !id ||
      !triggerId ||
      (expectedTriggerId !== undefined && triggerId !== expectedTriggerId) ||
      !status ||
      !reason ||
      retryCount === null ||
      lastRetriedAt === null ||
      !createdAt ||
      !updatedAt ||
      hasCursor === null ||
      hasProfileKey === null ||
      hasPayload === null ||
      lastErrorCategory === null ||
      ids.has(id)
    ) {
      return malformed("recovery record identities or fields");
    }
    ids.add(id);
    items.push({
      id,
      triggerId,
      status,
      reason,
      retryCount,
      createdAt,
      updatedAt,
      hasCursor,
      hasProfileKey,
      hasPayload,
      ...(lastRetriedAt ? { lastRetriedAt } : {}),
      ...(lastErrorCategory ? { lastErrorCategory } : {}),
    });
  }
  return { ok: true, value: { items } };
}

export function normalizeTriggerDelayPreference(
  input: unknown,
  expected: { subscriberId: string; eventName: string },
): ResponseNormalization<TriggerDelayPreference> {
  const row = record(input);
  if (!row) return malformed("timing override");
  const subscriberId = text(row.subscriber_id, 256);
  const eventName = text(row.event_name, 256);
  const delay = integer(row.optimal_delay_seconds, 0, MAX_DELAY_SECONDS);
  const samples = integer(row.sample_count, 0, Number.MAX_SAFE_INTEGER);
  const confidence = finite(row.confidence, 0, 1);
  const computedAt = timestamp(row.computed_at);
  const updatedAt = timestamp(row.updated_at);
  const reason = optionalText(row.reason, 500);
  if (
    !subscriberId ||
    !isCanonicalSubscriberUUID(subscriberId) ||
    subscriberId !== expected.subscriberId ||
    eventName !== expected.eventName ||
    delay === null ||
    samples === null ||
    confidence === null ||
    !computedAt ||
    !updatedAt ||
    reason === null
  )
    return malformed("timing override identity or fields");
  return {
    ok: true,
    value: {
      subscriber_id: subscriberId,
      event_name: eventName,
      optimal_delay_seconds: delay,
      sample_count: samples,
      confidence,
      computed_at: computedAt,
      updated_at: updatedAt,
      ...(reason ? { reason } : {}),
    },
  };
}

function malformed(subject: string): { ok: false; message: string } {
  return { ok: false, message: `The server returned malformed ${subject}.` };
}
