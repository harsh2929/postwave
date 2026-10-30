/**
 * lib/privacyIncidentsWire.ts — the bounded wire contract for the incident feed.
 *
 * Split out of lib/privacyIncidents.ts, which owns normalization and the typed
 * failures. This half answers exactly one question — "does this payload match
 * what the server promised?" — and answers it WITHOUT THROWING, so each caller
 * decides for itself whether a mismatch is a contract error or an identity
 * mismatch.
 *
 * Read the five server facts in the header of lib/privacyIncidents.ts; they
 * shape both halves. Fact 5 is the one this file exists to enforce: live
 * list/detail parsers reject enum drift as a contract failure rather than
 * silently blessing a new workflow state. Every predicate here therefore fails
 * closed on anything it does not positively recognise.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** Mirrors `validIncidentStates` (incidents.go:44-49). */
export type IncidentState =
  | "open"
  | "contained"
  | "notifications_pending"
  | "closed";

export const INCIDENT_STATES: readonly IncidentState[] = [
  "open",
  "contained",
  "notifications_pending",
  "closed",
];

/** Mirrors `normalizeSeverity` (incidents.go:816-831). */
export type IncidentSeverity =
  | "investigating"
  | "low"
  | "medium"
  | "high"
  | "critical";

export const SEVERITIES: readonly IncidentSeverity[] = [
  "investigating",
  "low",
  "medium",
  "high",
  "critical",
];

/** Non-actionable code/name selection metadata. */
export interface JurisdictionReference {
  code: string;
  name: string;
}

/** Explicit refusal to manufacture legal obligations from incomplete facts. */
export interface JurisdictionResolutionHold {
  status: "release_held";
  releaseHoldCode: "jurisdiction_rules_release_hold";
  recognized: JurisdictionReference[];
  unknown: string[];
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
export const CURSOR = /^[A-Za-z0-9+/_=-]+$/u;
const CONTROL = /\p{Cc}/u;
const NUL = /\u0000/u;
// Keep this aligned with the server's explicit bidi-formatting deny-list.
// A blanket Unicode Cf rejection would also reject valid ZWJ emoji.
const BIDI_FORMATTING_CONTROL =
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u206F]/u;
const SHA256_HEX = /^[0-9a-f]{64}$/iu;
export const INCIDENT_MAX_PAGE = 200;
export const INCIDENT_MAX_SCOPE_ITEMS = 64;
export const INCIDENT_MAX_SCOPE_RUNES = 256;
const INCIDENT_MAX_SUMMARY_RUNES = 4_000;
export const INCIDENT_MAX_EVENTS = 10_000;

const INCIDENT_KEYS = new Set([
  "id",
  "severity",
  "status",
  "detected_at",
  "discovered_at",
  "clock_started_at",
  "gdpr_72h_deadline",
  "counsel_signoff_at",
  "signoff_by",
  "template_version",
  "affected_regions",
  "affected_data_categories",
  "affected_subject_count",
  "notification_decisions",
  "jurisdictions",
  "summary",
  "created_at",
  "updated_at",
  "jurisdiction_resolution",
]);
const TRANSITION_EVENT_KEYS = new Set([
  "event_id",
  "source",
  "schema_version",
  "kind",
  "at",
  "from_state",
  "to_state",
  "actor",
  "reason",
]);
const NOTIFICATION_EVENT_KEYS = new Set([
  "event_id",
  "source",
  "schema_version",
  "kind",
  "at",
  "audience",
  "actor",
  "template_key",
  "body_sha256",
  "recipient_ref",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (s) out.push(s);
  }
  return out;
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function runeLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedText(value: unknown, maxRunes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    runeLength(value) <= maxRunes &&
    !NUL.test(value) &&
    !BIDI_FORMATTING_CONTROL.test(value)
  );
}

function isBoundedToken(value: unknown, maxRunes: number): value is string {
  return isBoundedText(value, maxRunes) && !CONTROL.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isScopeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= INCIDENT_MAX_SCOPE_ITEMS &&
    value.every((entry) => isBoundedToken(entry, INCIDENT_MAX_SCOPE_RUNES)) &&
    new Set(value).size === value.length
  );
}

function isBoundedRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536;
  } catch {
    return false;
  }
}

/** Identity plus the two enums that must be exactly what this build knows. */
function hasIncidentIdentity(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    UUID.test(value.id) &&
    typeof value.severity === "string" &&
    (SEVERITIES as readonly string[]).includes(value.severity) &&
    typeof value.status === "string" &&
    (INCIDENT_STATES as readonly string[]).includes(value.status)
  );
}

/**
 * The clock fields. Only `detected_at` is mandatory; `gdpr_72h_deadline` is the
 * legacy operational target calculated from it (fact 2), never proof that a
 * statutory clock applies or began.
 */
function hasIncidentClock(value: Record<string, unknown>): boolean {
  return (
    isTimestamp(value.detected_at) &&
    isOptionalTimestamp(value.discovered_at) &&
    isOptionalTimestamp(value.clock_started_at) &&
    isOptionalTimestamp(value.gdpr_72h_deadline) &&
    isOptionalTimestamp(value.counsel_signoff_at) &&
    isTimestamp(value.created_at) &&
    isTimestamp(value.updated_at)
  );
}

/** Who signed the record off, and which notice template version it recorded. */
function hasIncidentAttribution(value: Record<string, unknown>): boolean {
  return (
    (value.signoff_by === undefined || isBoundedToken(value.signoff_by, 320)) &&
    isBoundedToken(value.template_version, 64)
  );
}

/**
 * Blast radius. An explicit `affected_subject_count: 0` is a real answer and
 * passes here; an omitted one also passes and stays unknown through
 * normalization (fact 3). Neither is ever coerced into the other.
 */
function hasIncidentScope(value: Record<string, unknown>): boolean {
  return (
    isScopeArray(value.affected_regions) &&
    isScopeArray(value.affected_data_categories) &&
    (value.affected_subject_count === undefined ||
      (Number.isSafeInteger(value.affected_subject_count) &&
        (value.affected_subject_count as number) >= 0 &&
        (value.affected_subject_count as number) <= 2_147_483_647)) &&
    isBoundedRecord(value.notification_decisions) &&
    isScopeArray(value.jurisdictions) &&
    isBoundedText(value.summary, INCIDENT_MAX_SUMMARY_RUNES)
  );
}

export function isIncidentWire(
  value: unknown,
  resolutionMode: "absent" | "required",
): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, INCIDENT_KEYS)) return false;
  if (
    !hasIncidentIdentity(value) ||
    !hasIncidentClock(value) ||
    !hasIncidentAttribution(value) ||
    !hasIncidentScope(value)
  ) {
    return false;
  }
  if (resolutionMode === "absent") {
    return value.jurisdiction_resolution === undefined;
  }
  const resolution = jurisdictionResolution(value.jurisdiction_resolution);
  return (
    resolution !== null &&
    resolutionMatchesJurisdictions(value.jurisdictions as string[], resolution)
  );
}

export function isSortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}

const JURISDICTION_REFERENCE_KEYS = new Set(["code", "name"]);
const JURISDICTION_RESOLUTION_KEYS = new Set([
  "status",
  "release_hold_code",
  "recognized",
  "unknown_jurisdictions",
]);

export function jurisdictionReference(
  raw: unknown,
): JurisdictionReference | null {
  if (!isRecord(raw)) return null;
  const reference = raw;
  if (!hasOnlyKeys(reference, JURISDICTION_REFERENCE_KEYS)) return null;
  if (
    !isBoundedToken(reference.code, INCIDENT_MAX_SCOPE_RUNES) ||
    !isBoundedToken(reference.name, INCIDENT_MAX_SCOPE_RUNES)
  ) {
    return null;
  }
  const code = reference.code;
  const name = reference.name;
  return code && name ? { code, name } : null;
}

export function jurisdictionResolution(
  raw: unknown,
): JurisdictionResolutionHold | null {
  if (!isRecord(raw)) return null;
  const resolution = raw;
  if (
    !hasOnlyKeys(resolution, JURISDICTION_RESOLUTION_KEYS) ||
    resolution.status !== "release_held" ||
    resolution.release_hold_code !== "jurisdiction_rules_release_hold" ||
    !Array.isArray(resolution.recognized) ||
    resolution.recognized.length > INCIDENT_MAX_SCOPE_ITEMS
  ) {
    return null;
  }
  const recognized = resolution.recognized.map(jurisdictionReference);
  if (
    recognized.some((entry) => entry === null) ||
    !isSortedUnique(recognized.map((entry) => entry!.code))
  ) {
    return null;
  }
  const unknown = strList(resolution.unknown_jurisdictions);
  if (
    (resolution.unknown_jurisdictions !== undefined &&
      (!Array.isArray(resolution.unknown_jurisdictions) ||
        resolution.unknown_jurisdictions.length > INCIDENT_MAX_SCOPE_ITEMS ||
        unknown.length !== resolution.unknown_jurisdictions.length ||
        !resolution.unknown_jurisdictions.every((entry) =>
          isBoundedToken(entry, INCIDENT_MAX_SCOPE_RUNES),
        ))) ||
    !isSortedUnique(unknown)
  ) {
    return null;
  }
  return {
    status: "release_held",
    releaseHoldCode: "jurisdiction_rules_release_hold",
    recognized: recognized as JurisdictionReference[],
    unknown,
  };
}

export function resolutionMatchesJurisdictions(
  jurisdictions: readonly string[],
  resolution: JurisdictionResolutionHold,
): boolean {
  const normalized = jurisdictions.map((value) => value.trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) return false;
  normalized.sort();
  const recognized = resolution.recognized.map((entry) => entry.code);
  const recognizedSet = new Set(recognized);
  if (resolution.unknown.some((code) => recognizedSet.has(code))) return false;
  const resolved = [...recognized, ...resolution.unknown].sort();
  return (
    resolved.length === normalized.length &&
    resolved.every((code, index) => code === normalized[index])
  );
}

function isOptionalBoundedToken(value: unknown, maxRunes: number): boolean {
  return value === undefined || isBoundedToken(value, maxRunes);
}

function isOptionalBoundedText(value: unknown, maxRunes: number): boolean {
  return value === undefined || isBoundedText(value, maxRunes);
}

export function isIncidentEventWire(
  value: unknown,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.event_id !== "string" ||
    !UUID.test(value.event_id) ||
    value.schema_version !== 1 ||
    !isTimestamp(value.at) ||
    !isOptionalBoundedToken(value.actor, 320) ||
    !isOptionalBoundedText(value.reason, 2_000) ||
    !isOptionalBoundedToken(value.template_key, 256) ||
    !isOptionalBoundedToken(value.recipient_ref, 2_048) ||
    (value.body_sha256 !== undefined &&
      (typeof value.body_sha256 !== "string" ||
        !SHA256_HEX.test(value.body_sha256)))
  ) {
    return false;
  }
  if (value.kind === "transition") {
    return (
      hasOnlyKeys(value, TRANSITION_EVENT_KEYS) &&
      value.source === "incident_state_transitions" &&
      (value.from_state === undefined ||
        (typeof value.from_state === "string" &&
          (INCIDENT_STATES as readonly string[]).includes(value.from_state))) &&
      typeof value.to_state === "string" &&
      (INCIDENT_STATES as readonly string[]).includes(value.to_state)
    );
  }
  if (value.kind === "notification") {
    return (
      hasOnlyKeys(value, NOTIFICATION_EVENT_KEYS) &&
      value.source === "incident_notifications" &&
      typeof value.audience === "string" &&
      ["authority", "customer", "data_subject"].includes(value.audience)
    );
  }
  return false;
}
