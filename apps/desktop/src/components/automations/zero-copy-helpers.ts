/**
 * Pure helpers for the Zero-copy triggers section (#28).
 *
 * Everything here is render-free so it can be unit-tested under the
 * node vitest environment. The React components in this folder import
 * from here; nothing here imports React.
 */

import type {
  ZeroCopyTrigger,
  ZeroCopyTriggerInput,
  ZeroCopyValidationResult,
} from "../../lib/api-client";

/* ---------- editor draft ---------- */

/**
 * String-typed editor draft. Numeric wire fields are kept as strings
 * so the inputs stay controlled while empty (same rationale as the
 * InboundRoutes priority field — `Number("") || default` silently
 * coerces valid zeros).
 */
export interface TriggerDraft {
  name: string;
  description: string;
  provider: string;
  connectionId: string;
  journeyId: string;
  query: string;
  cursorColumn: string;
  profileKeyColumn: string;
  pollingIntervalSeconds: string;
  maxRowsPerTick: string;
  status: string;
  /** Opaque provider settings are preserved on full-replacement edits. */
  config?: Record<string, unknown>;
}

export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_MAX_ROWS_PER_TICK = 500;
export const MIN_POLL_INTERVAL_SECONDS = 15;
export const MAX_POLL_INTERVAL_SECONDS = 86_400;
export const MAX_ROWS_PER_TICK = 1_000;

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalTriggerReference(value: string): boolean {
  return CANONICAL_UUID.test(value.trim());
}

/** Known provider keys the server-side poller ships drivers for. The
 *  editor renders these as a datalist (free text still allowed — the
 *  authoritative check is the server-side validate endpoint). */
export const KNOWN_PROVIDERS = [
  "snowflake",
  "bigquery",
  "redshift",
  "postgres",
] as const;

export function draftFromTrigger(t?: ZeroCopyTrigger | null): TriggerDraft {
  return {
    name: t?.name ?? "",
    description: t?.description ?? "",
    provider: t?.provider ?? "",
    connectionId: t?.connection_id ?? "",
    journeyId: t?.journey_id ?? "",
    query: t?.query ?? "",
    cursorColumn: t?.cursor_column ?? "",
    profileKeyColumn: t?.profile_key_column ?? "",
    pollingIntervalSeconds: String(
      t?.polling_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    ),
    maxRowsPerTick: String(t?.max_rows_per_tick ?? DEFAULT_MAX_ROWS_PER_TICK),
    status: t?.status ?? "draft",
    ...(t?.config ? { config: t.config } : {}),
  };
}

/**
 * Local (client-side) required-field validation. This is NOT a
 * substitute for the server-side validate endpoint — it only stops
 * obviously-empty submissions so the live validator has something
 * meaningful to send.
 */
export function draftErrors(d: TriggerDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (!d.provider.trim()) e.provider = "Provider is required";
  if (d.connectionId.trim() && !isCanonicalTriggerReference(d.connectionId)) {
    e.connectionId = "Connection ID must be a canonical UUID";
  }
  if (d.journeyId.trim() && !isCanonicalTriggerReference(d.journeyId)) {
    e.journeyId = "Journey ID must be a canonical UUID";
  }
  if (!d.query.trim()) e.query = "Query is required";
  if (!d.cursorColumn.trim()) e.cursorColumn = "Cursor column is required";
  if (!d.profileKeyColumn.trim()) {
    e.profileKeyColumn = "Profile-key column is required";
  }
  const interval = Number(d.pollingIntervalSeconds.trim());
  if (
    d.pollingIntervalSeconds.trim() === "" ||
    !Number.isInteger(interval) ||
    interval < MIN_POLL_INTERVAL_SECONDS ||
    interval > MAX_POLL_INTERVAL_SECONDS
  ) {
    e.pollingIntervalSeconds =
      "Interval must be a whole number from 15 to 86,400 seconds";
  }
  const maxRows = Number(d.maxRowsPerTick.trim());
  if (
    d.maxRowsPerTick.trim() === "" ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > MAX_ROWS_PER_TICK
  ) {
    e.maxRowsPerTick = "Max rows must be a whole number from 1 to 1,000";
  }
  if (d.status === "active") {
    e.status =
      "Activation is unavailable until the durable automation runtime is qualified";
  }
  return e;
}

/**
 * True when the draft carries enough substance for a server-side
 * validate round-trip to return something useful. Gates the live
 * (debounced) validation so we don't spam the endpoint with empty
 * drafts on first keystroke.
 */
export function canValidate(d: TriggerDraft): boolean {
  return Boolean(
    d.provider.trim() &&
    d.query.trim() &&
    d.cursorColumn.trim() &&
    d.profileKeyColumn.trim(),
  );
}

export function draftToInput(d: TriggerDraft): ZeroCopyTriggerInput {
  const input: ZeroCopyTriggerInput = {
    name: d.name.trim(),
    provider: d.provider.trim(),
    query: d.query.trim(),
    cursor_column: d.cursorColumn.trim(),
    profile_key_column: d.profileKeyColumn.trim(),
  };
  if (d.description.trim()) input.description = d.description.trim();
  if (d.connectionId.trim()) {
    input.connection_id = d.connectionId.trim().toLowerCase();
  }
  if (d.journeyId.trim()) {
    input.journey_id = d.journeyId.trim().toLowerCase();
  }
  if (d.config) input.config = d.config;
  if (d.status.trim()) input.status = d.status.trim();
  const interval = Number(d.pollingIntervalSeconds.trim());
  if (
    Number.isInteger(interval) &&
    interval >= MIN_POLL_INTERVAL_SECONDS &&
    interval <= MAX_POLL_INTERVAL_SECONDS
  ) {
    input.polling_interval_seconds = interval;
  }
  const maxRows = Number(d.maxRowsPerTick.trim());
  if (
    Number.isInteger(maxRows) &&
    maxRows >= 1 &&
    maxRows <= MAX_ROWS_PER_TICK
  ) {
    input.max_rows_per_tick = maxRows;
  }
  return input;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/** Verify every full-replacement input field against the returned resource. */
export function savedTriggerMatchesInput(
  trigger: ZeroCopyTrigger,
  input: ZeroCopyTriggerInput,
): boolean {
  return (
    trigger.name === input.name &&
    (trigger.description ?? "") === (input.description ?? "") &&
    trigger.status === (input.status ?? "draft") &&
    trigger.provider === input.provider &&
    trigger.query === input.query &&
    trigger.cursor_column === input.cursor_column &&
    trigger.profile_key_column === input.profile_key_column &&
    trigger.polling_interval_seconds ===
      (input.polling_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS) &&
    trigger.max_rows_per_tick ===
      (input.max_rows_per_tick ?? DEFAULT_MAX_ROWS_PER_TICK) &&
    (trigger.connection_id ?? "") === (input.connection_id ?? "") &&
    (trigger.journey_id ?? "") === (input.journey_id ?? "") &&
    jsonValuesEqual(trigger.config ?? {}, input.config ?? {})
  );
}

/** Strictly accepts only the validator fields this renderer consumes. */
export function normalizeValidationResult(
  input: unknown,
): ZeroCopyValidationResult | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (typeof row.valid !== "boolean") return null;

  const normalizeMessages = (value: unknown): string[] | undefined | null => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > 100) return null;
    const messages: string[] = [];
    for (const candidate of value) {
      if (typeof candidate !== "string") return null;
      const message = candidate.trim();
      if (!message || message.length > 1_024) return null;
      messages.push(message);
    }
    return messages;
  };

  const errors = normalizeMessages(row.errors);
  const warnings = normalizeMessages(row.warnings);
  if (errors === null || warnings === null) return null;
  if (row.valid ? Boolean(errors?.length) : !errors?.length) return null;
  return {
    valid: row.valid,
    ...(errors ? { errors } : {}),
    ...(warnings ? { warnings } : {}),
  };
}

/* ---------- validation-as-error-body recovery ---------- */

/**
 * Zero-copy create/update return HTTP 400 whose JSON body IS the
 * ZeroCopyValidationResult (not the standard `{error}` envelope) — see
 * WIRING-WRAPPERS.md deviation #5. The api-client surfaces that body
 * as `res.error.message` (raw text, sliced to 200 chars). This helper
 * tries to recover the structured result so the editor can render the
 * same error/warning list it shows for the validate endpoint.
 *
 * Returns null when the message isn't a parseable validation result
 * (truncated JSON, plain-text error, …) — callers fall back to the
 * plain message.
 */
export function extractValidationResult(
  message: string | undefined,
): ZeroCopyValidationResult | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return normalizeValidationResult(parsed);
}

/* ---------- display helpers ---------- */

export type BadgeTone = "success" | "warning" | "danger" | "neutral";

export interface TriggerHealth {
  tone: BadgeTone;
  label: string;
  /** Extra context for a title/tooltip; empty when healthy. */
  detail: string;
}

/**
 * Collapse (status, consecutive_failures, last_error) into one badge.
 * Honest precedence: a paused trigger is paused even if it also has
 * stale failures; an active trigger with consecutive failures is
 * failing, not "active".
 */
export function triggerHealth(t: ZeroCopyTrigger): TriggerHealth {
  const status = (t.status || "").toLowerCase();
  if (status !== "active") {
    return { tone: "neutral", label: status || "unknown", detail: "" };
  }
  if (t.consecutive_failures > 0) {
    return {
      tone: t.consecutive_failures >= 3 ? "danger" : "warning",
      label: `failing ×${t.consecutive_failures}`,
      detail: t.last_error ?? "",
    };
  }
  return { tone: "success", label: "active", detail: "" };
}

export function fireStatusTone(status: string): BadgeTone {
  const s = status.toLowerCase();
  if (s === "delivered" || s === "ok" || s === "success") {
    return "success";
  }
  if (s === "failed" || s === "error" || s === "dead") return "danger";
  if (s === "pending" || s === "queued" || s === "retrying") return "warning";
  return "neutral";
}

/**
 * Operational identifiers can contain customer data. Keep list/detail views
 * useful for correlation without rendering the complete value by default.
 */
export function maskOperationalIdentifier(value?: string | null): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) return "—";
  if (normalized.length <= 4) return "••••";
  return `••••${normalized.slice(-4)}`;
}

export function fmtRelative(iso?: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const abs = Math.abs(Date.now() - t);
  if (abs < 60_000) return "just now";
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
  return `${Math.round(abs / 86_400_000)}d ago`;
}

/** "300" → "5m", "90" → "1m 30s", "3600" → "1h". */
export function fmtDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  if (totalSeconds === 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(" ");
}
