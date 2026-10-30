/**
 * lib/privacyIncidents.ts — parsing the breach-response incident feed.
 *
 * WHY MOBILE GETS THIS AT ALL. A breach is unplanned and out of hours, so the
 * phone needs a bounded operational view of what is open and which workflow
 * state was recorded. This is an administrative register, not a legal advice
 * or delivery-evidence surface.
 *
 * FIVE SERVER FACTS THAT SHAPE THIS FILE, all read from the Go source:
 *
 *  1. LIST ROWS OMIT `jurisdiction_resolution`; detail/create responses carry
 *     only an explicit `jurisdiction_rules_release_hold` plus code/name
 *     recognition metadata. No deadline, threshold, recipient, or notice
 *     content is available from this API.
 *  2. `gdpr_72h_deadline` is a legacy operational target calculated from
 *     `detected_at`; it is not proof that a statutory clock applies or began.
 *  3. An explicit `affected_subject_count: 0` is preserved. An omitted count
 *     remains unknown and renders as an em-dash.
 *  4. Event responses carry the parent incident UUID; event rows carry a UUID,
 *     source, and `schema_version: 1`. Live reads fail closed when any identity
 *     or envelope invariant is violated.
 *  5. `normalizeIncident` preserves unknown enum text for defensive local
 *     rendering, but live list/detail parsers reject enum drift as a contract
 *     failure rather than silently blessing a new workflow state.
 *
 * The bounded wire contract those parsers check against — every predicate, key
 * set, and bound — lives in lib/privacyIncidentsWire.ts. This file owns
 * normalization and the typed failures; that one owns recognition.
 *
 * DELIBERATELY IMPORT-FREE of anything but its wire sibling, so it runs under
 * the node vitest environment.
 */
import {
  CURSOR,
  INCIDENT_MAX_EVENTS,
  INCIDENT_MAX_PAGE,
  INCIDENT_MAX_SCOPE_ITEMS,
  INCIDENT_STATES,
  SEVERITIES,
  UUID,
  hasOnlyKeys,
  isIncidentEventWire,
  isIncidentWire,
  isRecord,
  isSortedUnique,
  jurisdictionReference,
  jurisdictionResolution,
  str,
  strList,
  type IncidentSeverity,
  type IncidentState,
  type JurisdictionReference,
  type JurisdictionResolutionHold,
} from "@/lib/privacyIncidentsWire";

export { INCIDENT_STATES };
export type {
  IncidentSeverity,
  IncidentState,
  JurisdictionReference,
  JurisdictionResolutionHold,
};

export interface PrivacyIncident {
  id: string;
  /** null when the server sent a severity this build does not know. */
  severity: IncidentSeverity | null;
  /** Exactly what the server said, for display when `severity` is null. */
  severityRaw: string;
  /** null when the server sent a state this build does not know. */
  status: IncidentState | null;
  statusRaw: string;
  summary: string;
  detectedAt: string;
  discoveredAt: string;
  clockStartedAt: string;
  /** Legacy 72-hour operational target, or "" when unset. Not legal advice. */
  deadlineAt: string;
  counselSignoffAt: string;
  signoffBy: string;
  affectedRegions: string[];
  affectedDataCategories: string[];
  jurisdictions: string[];
  /** null = never recorded. NEVER coerce to 0. */
  affectedSubjectCount: number | null;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyIncidentDetail extends PrivacyIncident {
  /** null means the server did not return the exact fail-closed contract. */
  jurisdictionResolution: JurisdictionResolutionHold | null;
}

export interface PrivacyIncidentPage {
  incidents: PrivacyIncident[];
  /** "" when the server said this was the last page. */
  nextCursor: string;
  /** True when the server offered more rows than this screen asked for. */
  truncated: boolean;
}

export type IncidentEventKind = "transition" | "notification" | "other";

export interface IncidentEvent {
  eventId: string;
  source: string;
  schemaVersion: number | null;
  kind: IncidentEventKind;
  at: string;
  fromState: string;
  toState: string;
  actor: string;
  reason: string;
  audience: string;
  templateKey: string;
  recipientRef: string;
}

export class PrivacyIncidentContractError extends Error {
  readonly status = 0;
  readonly code:
    | "invalid_privacy_incident_response_contract"
    | "privacy_incident_response_identity_mismatch";

  constructor(
    code:
      | "invalid_privacy_incident_response_contract"
      | "privacy_incident_response_identity_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PrivacyIncidentContractError";
    this.code = code;
  }
}

function contractFailure(message: string): never {
  throw new PrivacyIncidentContractError(
    "invalid_privacy_incident_response_contract",
    message,
  );
}

function identityFailure(message: string): never {
  throw new PrivacyIncidentContractError(
    "privacy_incident_response_identity_mismatch",
    message,
  );
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A timestamp, or "" when the value is absent OR is Go's zero time.
 *
 * The 1900 floor rather than an exact string match on "0001-01-01T00:00:00Z":
 * the same zero value reaches us as `0001-01-01T00:00:00Z` from
 * `encoding/json` and as `-62135596800` from anything that has been through a
 * numeric encoder, and no real breach predates the epoch.
 */
export function isoOrEmpty(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return "";
  if (ms < Date.UTC(1900, 0, 1)) return "";
  return raw;
}

/** null (not 0) when the server omitted the count. */
function optionalCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n < 0 ? null : n;
}

function severityOf(raw: string): IncidentSeverity | null {
  const lower = raw.toLowerCase();
  return (SEVERITIES as readonly string[]).includes(lower)
    ? (lower as IncidentSeverity)
    : null;
}

function stateOf(raw: string): IncidentState | null {
  const lower = raw.toLowerCase();
  return (INCIDENT_STATES as readonly string[]).includes(lower)
    ? (lower as IncidentState)
    : null;
}

/**
 * One incident, from either the list or the detail payload.
 *
 * Never touches `jurisdiction_resolution` — see fact 1 in the module header.
 */
export function normalizeIncident(raw: unknown): PrivacyIncident {
  const row = obj(raw);
  const severityRaw = str(row.severity);
  const statusRaw = str(row.status);
  return {
    id: str(row.id),
    severity: severityOf(severityRaw),
    severityRaw,
    status: stateOf(statusRaw),
    statusRaw,
    summary: str(row.summary),
    detectedAt: isoOrEmpty(row.detected_at),
    discoveredAt: isoOrEmpty(row.discovered_at),
    clockStartedAt: isoOrEmpty(row.clock_started_at),
    deadlineAt: isoOrEmpty(row.gdpr_72h_deadline),
    counselSignoffAt: isoOrEmpty(row.counsel_signoff_at),
    signoffBy: str(row.signoff_by),
    affectedRegions: strList(row.affected_regions),
    affectedDataCategories: strList(row.affected_data_categories),
    jurisdictions: strList(row.jurisdictions),
    affectedSubjectCount: optionalCount(row.affected_subject_count),
    templateVersion: str(row.template_version),
    createdAt: isoOrEmpty(row.created_at),
    updatedAt: isoOrEmpty(row.updated_at),
  };
}

/**
 * The list page.
 *
 * `truncated` rather than a paging cursor the phone walks: this screen is a
 * glance at what is open, and the honest thing when the server has more is to
 * SAY there are more, not to grow an infinite list of historical breaches on a
 * 390pt screen. The caller asks for a small page precisely so `nextCursor`
 * being present is meaningful.
 */
export function normalizePrivacyIncidentPage(
  raw: unknown,
): PrivacyIncidentPage {
  if (!isRecord(raw)) contractFailure("Incident list body is not an object.");
  const body = raw;
  if (
    !hasOnlyKeys(
      body,
      new Set(["incidents", "known_jurisdictions", "nextCursor"]),
    ) ||
    !Array.isArray(body.incidents) ||
    body.incidents.length > INCIDENT_MAX_PAGE ||
    !body.incidents.every((row) => isIncidentWire(row, "absent")) ||
    !Array.isArray(body.known_jurisdictions) ||
    body.known_jurisdictions.length > INCIDENT_MAX_SCOPE_ITEMS
  ) {
    contractFailure(
      "Incident list body does not match the bounded wire contract.",
    );
  }
  const known = body.known_jurisdictions.map(jurisdictionReference);
  if (
    known.some((entry) => entry === null) ||
    !isSortedUnique(known.map((entry) => entry!.code))
  ) {
    contractFailure("Incident jurisdiction catalog is malformed or unordered.");
  }
  const nextCursorValue = body.nextCursor;
  if (
    nextCursorValue !== undefined &&
    (typeof nextCursorValue !== "string" ||
      nextCursorValue.trim() === "" ||
      new TextEncoder().encode(nextCursorValue).byteLength > 8_192 ||
      !CURSOR.test(nextCursorValue))
  ) {
    contractFailure("Incident list cursor is malformed.");
  }
  const nextCursor = nextCursorValue ?? "";
  if (body.incidents.length === 0 && nextCursor !== "") {
    contractFailure("An empty incident page cannot be nonterminal.");
  }
  const incidents = body.incidents.map(normalizeIncident);
  if (new Set(incidents.map((row) => row.id)).size !== incidents.length) {
    contractFailure("Incident list contains duplicate identities.");
  }
  for (let index = 1; index < incidents.length; index += 1) {
    const previous = incidents[index - 1]!;
    const current = incidents[index]!;
    const timeDelta =
      Date.parse(previous.detectedAt) - Date.parse(current.detectedAt);
    if (timeDelta < 0 || (timeDelta === 0 && previous.id <= current.id)) {
      contractFailure(
        "Incident list ordering does not match the wire contract.",
      );
    }
  }
  return {
    incidents,
    nextCursor,
    truncated: nextCursor !== "",
  };
}

/**
 * The detail payload, including only the exact release-hold projection. Any
 * legacy obligation-shaped or malformed result throws a typed contract error.
 */
export function normalizePrivacyIncidentDetail(
  raw: unknown,
  expectedIncidentId?: string,
): PrivacyIncidentDetail {
  if (!isIncidentWire(raw, "required")) {
    contractFailure(
      "Incident detail does not match the bounded wire contract.",
    );
  }
  const body = raw;
  if (
    expectedIncidentId !== undefined &&
    String(body.id).toLowerCase() !== expectedIncidentId.toLowerCase()
  ) {
    identityFailure("Incident detail belongs to a different incident.");
  }
  const base = normalizeIncident(body);
  const resolution = jurisdictionResolution(body.jurisdiction_resolution);
  if (resolution === null) {
    contractFailure(
      "Incident detail omitted its exact jurisdiction release hold.",
    );
  }
  return {
    ...base,
    jurisdictionResolution: resolution,
  };
}

/**
 * The merged transition + notification ledger.
 *
 * The server already re-sorts the two sources by timestamp ASC
 * (incidents.go:806-810). This reverses it: a ledger read at 2am is read
 * newest-first, and re-sorting here rather than reversing at the call site
 * keeps the one ordering decision testable.
 */
export function normalizeIncidentEvents(
  raw: unknown,
  expectedIncidentId?: string,
): IncidentEvent[] {
  if (
    !isRecord(raw) ||
    !hasOnlyKeys(raw, new Set(["incident_id", "events"])) ||
    typeof raw.incident_id !== "string" ||
    !UUID.test(raw.incident_id) ||
    !Array.isArray(raw.events) ||
    raw.events.length > INCIDENT_MAX_EVENTS ||
    !raw.events.every(isIncidentEventWire)
  ) {
    contractFailure(
      "Incident event ledger does not match the bounded wire contract.",
    );
  }
  if (
    expectedIncidentId !== undefined &&
    raw.incident_id.toLowerCase() !== expectedIncidentId.toLowerCase()
  ) {
    identityFailure("Incident event ledger belongs to a different incident.");
  }
  const list = raw.events;
  const identities = list.map(
    (row) => `${String(row.source)}:${String(row.event_id)}`,
  );
  if (new Set(identities).size !== identities.length) {
    contractFailure(
      "Incident event ledger contains duplicate source identities.",
    );
  }
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1]!;
    const current = list[index]!;
    const timeDelta =
      Date.parse(String(previous.at)) - Date.parse(String(current.at));
    const previousSourceOrder =
      previous.source === "incident_state_transitions" ? 0 : 1;
    const currentSourceOrder =
      current.source === "incident_state_transitions" ? 0 : 1;
    if (
      timeDelta > 0 ||
      (timeDelta === 0 && previousSourceOrder > currentSourceOrder) ||
      (timeDelta === 0 &&
        previousSourceOrder === currentSourceOrder &&
        String(previous.event_id) >= String(current.event_id))
    ) {
      contractFailure(
        "Incident event ledger ordering does not match the wire contract.",
      );
    }
  }
  const out: IncidentEvent[] = [];
  for (const entry of list) {
    const row = obj(entry);
    const kindRaw = str(row.kind);
    const eventId = str(row.event_id);
    const source = str(row.source);
    const schemaVersion =
      typeof row.schema_version === "number" &&
      Number.isSafeInteger(row.schema_version)
        ? row.schema_version
        : null;
    const kind = kindRaw as Exclude<IncidentEventKind, "other">;
    out.push({
      eventId,
      source,
      schemaVersion,
      kind,
      at: isoOrEmpty(row.at),
      fromState: str(row.from_state),
      toState: str(row.to_state),
      actor: str(row.actor),
      reason: str(row.reason),
      audience: str(row.audience),
      templateKey: str(row.template_key),
      recipientRef: str(row.recipient_ref),
    });
  }
  return out.reverse();
}

/**
 * Epoch ms, or 0 for an absent/unparseable timestamp.
 *
 * NOT `Date.parse(value || "0")`: "0" is a valid date string in V8 (year 2000)
 * and NaN on other engines, so an event with no timestamp would sort into the
 * middle of a 2026 ledger on one platform and vanish on the other.
 */
export function epochOf(value: string): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
