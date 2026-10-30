// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fail-closed web boundary for the privacy-incident register.
 *
 * The API is tenant-scoped by the authenticated server context but its legacy
 * wire rows do not contain a tenant id. Callers must therefore supply the
 * current tenant for cache/lifecycle scoping, while every mutation additionally
 * requires a short-lived authority minted from a fresh `/auth/me` response.
 */
import { ApiError, api } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";

export const PRIVACY_INCIDENT_STATES = [
  "open",
  "contained",
  "notifications_pending",
  "closed",
] as const;
export const PRIVACY_INCIDENT_SEVERITIES = [
  "investigating",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export const PRIVACY_INCIDENT_AUDIENCES = [
  "authority",
  "customer",
  "data_subject",
] as const;

export type PrivacyIncidentState = (typeof PRIVACY_INCIDENT_STATES)[number];
export type PrivacyIncidentSeverity =
  (typeof PRIVACY_INCIDENT_SEVERITIES)[number];
export type PrivacyIncidentAudience =
  (typeof PRIVACY_INCIDENT_AUDIENCES)[number];

export interface PrivacyJurisdictionReference {
  code: string;
  name: string;
}

export interface PrivacyJurisdictionResolution {
  status: "release_held";
  release_hold_code: "jurisdiction_rules_release_hold";
  recognized: PrivacyJurisdictionReference[];
  unknown_jurisdictions?: string[];
}

export interface PrivacyIncident {
  id: string;
  severity: PrivacyIncidentSeverity;
  status: PrivacyIncidentState;
  detected_at: string;
  discovered_at?: string;
  clock_started_at?: string;
  gdpr_72h_deadline?: string;
  counsel_signoff_at?: string;
  signoff_by?: string;
  template_version: string;
  affected_regions: string[];
  affected_data_categories: string[];
  affected_subject_count?: number;
  notification_decisions: Record<string, unknown>;
  jurisdictions: string[];
  summary: string;
  created_at: string;
  updated_at: string;
  jurisdiction_resolution?: PrivacyJurisdictionResolution;
}

export interface PrivacyIncidentPage {
  tenantId: string;
  incidents: PrivacyIncident[];
  knownJurisdictions: PrivacyJurisdictionReference[];
  nextCursor?: string;
  requestCursor?: string;
}

export interface PrivacyIncidentCreateInput {
  severity?: PrivacyIncidentSeverity;
  summary: string;
  detected_at?: string;
  discovered_at?: string | null;
  affected_regions?: string[];
  affected_data_categories?: string[];
  affected_subject_count?: number | null;
  jurisdictions?: string[];
}

export interface PrivacyIncidentTransitionReceipt {
  incident_id: string;
  from: PrivacyIncidentState;
  to: PrivacyIncidentState;
  at: string;
}

export interface PrivacyIncidentTransitionEvent {
  event_id: string;
  source: "incident_state_transitions";
  schema_version: 1;
  kind: "transition";
  at: string;
  from_state?: PrivacyIncidentState;
  to_state: PrivacyIncidentState;
  actor?: string;
  reason?: string;
}

export interface PrivacyIncidentNotificationEvent {
  event_id: string;
  source: "incident_notifications";
  schema_version: 1;
  kind: "notification";
  at: string;
  audience: PrivacyIncidentAudience;
  actor?: string;
  template_key?: string;
  body_sha256?: string;
  recipient_ref?: string;
}

export type PrivacyIncidentEvent =
  | PrivacyIncidentTransitionEvent
  | PrivacyIncidentNotificationEvent;

export interface PrivacyIncidentEvents {
  tenantId: string;
  incidentId: string;
  events: PrivacyIncidentEvent[];
}

export class PrivacyIncidentContractError extends Error {
  constructor(
    message = "The privacy incident service returned an unverifiable response. Previously verified data was kept.",
  ) {
    super(message);
    this.name = "PrivacyIncidentContractError";
  }
}

export class PrivacyIncidentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivacyIncidentInputError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const CURSOR = /^[A-Za-z0-9+/_=-]+$/u;
const CONTROL = /\p{Cc}/u;
const NUL = /\u0000/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/u;
const SHA256 = /^[0-9a-f]{64}$/iu;
const LIST_MAX = 200;
const ARRAY_MAX = 64;
const TOKEN_MAX = 256;
const SUMMARY_MAX = 4_000;
const EVENT_MAX = 10_000;
const DECISIONS_MAX_BYTES = 65_536;
const authorityBrand = Symbol("privacy-incident-admin-authority");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function runeLength(value: string): number {
  return Array.from(value).length;
}

function boundedNarrative(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    runeLength(value) <= max &&
    !NUL.test(value) &&
    !BIDI.test(value)
  );
}

function boundedToken(value: unknown, max = TOKEN_MAX): value is string {
  return boundedNarrative(value, max) && !CONTROL.test(value);
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    RFC3339.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function state(value: unknown): value is PrivacyIncidentState {
  return PRIVACY_INCIDENT_STATES.includes(value as PrivacyIncidentState);
}

function severity(value: unknown): value is PrivacyIncidentSeverity {
  return PRIVACY_INCIDENT_SEVERITIES.includes(value as PrivacyIncidentSeverity);
}

function audience(value: unknown): value is PrivacyIncidentAudience {
  return PRIVACY_INCIDENT_AUDIENCES.includes(value as PrivacyIncidentAudience);
}

function canonicalTenant(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function canonicalIncidentId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isCanonicalPrivacyIncidentId(value: string): boolean {
  return canonicalIncidentId(value);
}

function boundedScope(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= ARRAY_MAX &&
    value.every((entry) => boundedToken(entry)) &&
    new Set(value).size === value.length
  );
}

function sortedScope(value: unknown): value is string[] {
  return (
    boundedScope(value) &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}

function boundedRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  try {
    return (
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      DECISIONS_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function jurisdictionReference(
  value: unknown,
): value is PrivacyJurisdictionReference {
  return (
    isRecord(value) &&
    exactKeys(value, ["code", "name"]) &&
    boundedToken(value.code) &&
    boundedToken(value.name)
  );
}

function jurisdictionReferences(
  value: unknown,
): value is PrivacyJurisdictionReference[] {
  return (
    Array.isArray(value) &&
    value.length <= ARRAY_MAX &&
    value.every(jurisdictionReference) &&
    new Set(value.map((entry) => entry.code)).size === value.length &&
    value.every(
      (entry, index) => index === 0 || value[index - 1]!.code < entry.code,
    )
  );
}

function jurisdictionResolution(
  value: unknown,
): value is PrivacyJurisdictionResolution {
  return (
    isRecord(value) &&
    exactKeys(
      value,
      ["status", "release_hold_code", "recognized"],
      ["unknown_jurisdictions"],
    ) &&
    value.status === "release_held" &&
    value.release_hold_code === "jurisdiction_rules_release_hold" &&
    jurisdictionReferences(value.recognized) &&
    (value.unknown_jurisdictions === undefined ||
      sortedScope(value.unknown_jurisdictions))
  );
}

function resolutionMatches(
  jurisdictions: readonly string[],
  resolution: PrivacyJurisdictionResolution,
): boolean {
  const normalized = jurisdictions.map((entry) => entry.trim().toUpperCase());
  if (new Set(normalized).size !== normalized.length) return false;
  normalized.sort();
  const recognized = resolution.recognized.map((entry) => entry.code);
  const unknown = resolution.unknown_jurisdictions ?? [];
  const recognizedSet = new Set(recognized);
  if (unknown.some((entry) => recognizedSet.has(entry))) return false;
  const resolved = [...recognized, ...unknown].sort();
  return (
    resolved.length === normalized.length &&
    resolved.every((entry, index) => entry === normalized[index])
  );
}

const INCIDENT_REQUIRED = [
  "id",
  "severity",
  "status",
  "detected_at",
  "template_version",
  "affected_regions",
  "affected_data_categories",
  "notification_decisions",
  "jurisdictions",
  "summary",
  "created_at",
  "updated_at",
] as const;
const INCIDENT_OPTIONAL = [
  "discovered_at",
  "clock_started_at",
  "gdpr_72h_deadline",
  "counsel_signoff_at",
  "signoff_by",
  "affected_subject_count",
  "jurisdiction_resolution",
] as const;

function decodeIncident(
  value: unknown,
  resolution: "required" | "absent",
  expectedId?: string,
): PrivacyIncident {
  if (
    !isRecord(value) ||
    !exactKeys(value, INCIDENT_REQUIRED, INCIDENT_OPTIONAL) ||
    !canonicalIncidentId(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    !severity(value.severity) ||
    !state(value.status) ||
    !timestamp(value.detected_at) ||
    (value.discovered_at !== undefined && !timestamp(value.discovered_at)) ||
    (value.clock_started_at !== undefined &&
      !timestamp(value.clock_started_at)) ||
    (value.gdpr_72h_deadline !== undefined &&
      !timestamp(value.gdpr_72h_deadline)) ||
    (value.counsel_signoff_at !== undefined &&
      !timestamp(value.counsel_signoff_at)) ||
    (value.signoff_by !== undefined && !boundedToken(value.signoff_by, 320)) ||
    !boundedToken(value.template_version, 64) ||
    !boundedScope(value.affected_regions) ||
    !boundedScope(value.affected_data_categories) ||
    (value.affected_subject_count !== undefined &&
      (!Number.isSafeInteger(value.affected_subject_count) ||
        Number(value.affected_subject_count) < 0 ||
        Number(value.affected_subject_count) > 2_147_483_647)) ||
    !boundedRecord(value.notification_decisions) ||
    !boundedScope(value.jurisdictions) ||
    !boundedNarrative(value.summary, SUMMARY_MAX) ||
    !timestamp(value.created_at) ||
    !timestamp(value.updated_at)
  ) {
    throw new PrivacyIncidentContractError();
  }
  if (resolution === "absent") {
    if (value.jurisdiction_resolution !== undefined) {
      throw new PrivacyIncidentContractError();
    }
  } else if (
    !jurisdictionResolution(value.jurisdiction_resolution) ||
    !resolutionMatches(
      value.jurisdictions as string[],
      value.jurisdiction_resolution,
    )
  ) {
    throw new PrivacyIncidentContractError();
  }
  return value as unknown as PrivacyIncident;
}

export function decodePrivacyIncidentPage(
  value: unknown,
  input: { tenantId: string; limit: number; cursor?: string },
): PrivacyIncidentPage {
  if (
    !canonicalTenant(input.tenantId) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > LIST_MAX ||
    !isRecord(value) ||
    !exactKeys(value, ["incidents", "known_jurisdictions"], ["nextCursor"]) ||
    !Array.isArray(value.incidents) ||
    value.incidents.length > input.limit ||
    !jurisdictionReferences(value.known_jurisdictions) ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.length === 0 ||
        new TextEncoder().encode(value.nextCursor).byteLength > 8_192 ||
        !CURSOR.test(value.nextCursor))) ||
    (value.incidents.length === 0 && value.nextCursor !== undefined) ||
    (value.nextCursor !== undefined && value.incidents.length !== input.limit)
  ) {
    throw new PrivacyIncidentContractError();
  }
  const incidents = value.incidents.map((row) => decodeIncident(row, "absent"));
  if (new Set(incidents.map((row) => row.id)).size !== incidents.length) {
    throw new PrivacyIncidentContractError();
  }
  for (let index = 1; index < incidents.length; index += 1) {
    const previous = incidents[index - 1]!;
    const current = incidents[index]!;
    const delta =
      Date.parse(previous.detected_at) - Date.parse(current.detected_at);
    if (delta < 0 || (delta === 0 && previous.id <= current.id)) {
      throw new PrivacyIncidentContractError();
    }
  }
  return {
    tenantId: input.tenantId,
    incidents,
    knownJurisdictions: value.known_jurisdictions,
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
    ...(input.cursor ? { requestCursor: input.cursor } : {}),
  };
}

export async function listPrivacyIncidents(input: {
  tenantId: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<PrivacyIncidentPage> {
  const limit = input.limit ?? 100;
  if (!canonicalTenant(input.tenantId)) {
    throw new PrivacyIncidentInputError(
      "A canonical workspace identity is required.",
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX) {
    throw new PrivacyIncidentInputError("Page size must be between 1 and 200.");
  }
  if (
    input.cursor !== undefined &&
    (input.cursor.length === 0 ||
      new TextEncoder().encode(input.cursor).byteLength > 8_192 ||
      !CURSOR.test(input.cursor))
  ) {
    throw new PrivacyIncidentInputError("Pagination cursor is malformed.");
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await api.get<unknown>(
    `/api/v1/privacy/incidents?${params.toString()}`,
    { signal: input.signal, cache: "no-store" },
  );
  return decodePrivacyIncidentPage(response, {
    tenantId: input.tenantId,
    limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
}

export function mergePrivacyIncidentPages(
  pages: readonly PrivacyIncidentPage[],
): {
  tenantId: string;
  incidents: PrivacyIncident[];
  knownJurisdictions: PrivacyJurisdictionReference[];
  nextCursor?: string;
} {
  if (pages.length === 0 || pages[0]!.requestCursor !== undefined) {
    throw new PrivacyIncidentContractError();
  }
  const first = pages[0]!;
  const incidents: PrivacyIncident[] = [];
  const ids = new Set<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!;
    const previous = pages[pageIndex - 1];
    if (
      page.tenantId !== first.tenantId ||
      JSON.stringify(page.knownJurisdictions) !==
        JSON.stringify(first.knownJurisdictions) ||
      (pageIndex > 0 && page.requestCursor !== previous?.nextCursor) ||
      (pageIndex < pages.length - 1 && !page.nextCursor)
    ) {
      throw new PrivacyIncidentContractError();
    }
    for (const incident of page.incidents) {
      if (ids.has(incident.id)) throw new PrivacyIncidentContractError();
      const prior = incidents.at(-1);
      if (prior) {
        const delta =
          Date.parse(prior.detected_at) - Date.parse(incident.detected_at);
        if (delta < 0 || (delta === 0 && prior.id <= incident.id)) {
          throw new PrivacyIncidentContractError();
        }
      }
      ids.add(incident.id);
      incidents.push(incident);
    }
  }
  return {
    tenantId: first.tenantId,
    incidents,
    knownJurisdictions: first.knownJurisdictions,
    ...(pages.at(-1)?.nextCursor
      ? { nextCursor: pages.at(-1)!.nextCursor }
      : {}),
  };
}

export async function getPrivacyIncident(input: {
  tenantId: string;
  incidentId: string;
  signal?: AbortSignal;
}): Promise<PrivacyIncident> {
  requireTenantAndIncident(input.tenantId, input.incidentId);
  const response = await api.get<unknown>(
    `/api/v1/privacy/incidents/${encodeURIComponent(input.incidentId)}`,
    { signal: input.signal, cache: "no-store" },
  );
  return decodeIncident(response, "required", input.incidentId);
}

function decodeEvent(value: unknown): PrivacyIncidentEvent {
  if (
    !isRecord(value) ||
    !canonicalIncidentId(value.event_id) ||
    value.schema_version !== 1 ||
    !timestamp(value.at) ||
    (value.actor !== undefined && !boundedToken(value.actor, 320))
  ) {
    throw new PrivacyIncidentContractError();
  }
  if (value.kind === "transition") {
    if (
      !exactKeys(
        value,
        ["event_id", "source", "schema_version", "kind", "at", "to_state"],
        ["from_state", "actor", "reason"],
      ) ||
      value.source !== "incident_state_transitions" ||
      !state(value.to_state) ||
      (value.from_state !== undefined && !state(value.from_state)) ||
      (value.reason !== undefined && !boundedNarrative(value.reason, 2_000))
    ) {
      throw new PrivacyIncidentContractError();
    }
    return value as unknown as PrivacyIncidentTransitionEvent;
  }
  if (
    value.kind !== "notification" ||
    !exactKeys(
      value,
      ["event_id", "source", "schema_version", "kind", "at", "audience"],
      ["actor", "template_key", "body_sha256", "recipient_ref"],
    ) ||
    value.source !== "incident_notifications" ||
    !audience(value.audience) ||
    (value.template_key !== undefined && !boundedToken(value.template_key)) ||
    (value.body_sha256 !== undefined &&
      (typeof value.body_sha256 !== "string" ||
        !SHA256.test(value.body_sha256))) ||
    (value.recipient_ref !== undefined &&
      !boundedToken(value.recipient_ref, 2_048))
  ) {
    throw new PrivacyIncidentContractError();
  }
  return value as unknown as PrivacyIncidentNotificationEvent;
}

export async function listPrivacyIncidentEvents(input: {
  tenantId: string;
  incidentId: string;
  signal?: AbortSignal;
}): Promise<PrivacyIncidentEvents> {
  requireTenantAndIncident(input.tenantId, input.incidentId);
  const response = await api.get<unknown>(
    `/api/v1/privacy/incidents/${encodeURIComponent(input.incidentId)}/events`,
    { signal: input.signal, cache: "no-store" },
  );
  if (
    !isRecord(response) ||
    !exactKeys(response, ["incident_id", "events"]) ||
    response.incident_id !== input.incidentId ||
    !Array.isArray(response.events) ||
    response.events.length > EVENT_MAX
  ) {
    throw new PrivacyIncidentContractError();
  }
  const events = response.events.map(decodeEvent);
  if (
    new Set(events.map((event) => `${event.source}:${event.event_id}`)).size !==
    events.length
  ) {
    throw new PrivacyIncidentContractError();
  }
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    const delta = Date.parse(previous.at) - Date.parse(current.at);
    const previousSource = previous.kind === "transition" ? 0 : 1;
    const currentSource = current.kind === "transition" ? 0 : 1;
    if (
      delta > 0 ||
      (delta === 0 && previousSource > currentSource) ||
      (delta === 0 &&
        previousSource === currentSource &&
        previous.event_id >= current.event_id)
    ) {
      throw new PrivacyIncidentContractError();
    }
  }
  return { tenantId: input.tenantId, incidentId: input.incidentId, events };
}

export interface PrivacyIncidentAdminAuthority {
  readonly tenantId: string;
  readonly userId: string;
  readonly [authorityBrand]: true;
}

export function authorizePrivacyIncidentAdmin(
  me: MeResponse,
  expectedTenantId: string,
  expectedUserId: string,
): PrivacyIncidentAdminAuthority {
  const role = effectiveAuthRole(me);
  if (
    !canonicalTenant(expectedTenantId) ||
    !canonicalIncidentId(expectedUserId) ||
    me.tenant_id !== expectedTenantId ||
    me.user_id !== expectedUserId ||
    me.viewer_mode === true ||
    (role !== "owner" && role !== "admin")
  ) {
    throw new PrivacyIncidentInputError(
      "Your workspace identity or effective admin role changed.",
    );
  }
  return Object.freeze({
    tenantId: expectedTenantId,
    userId: expectedUserId,
    [authorityBrand]: true as const,
  });
}

function assertAuthority(
  value: PrivacyIncidentAdminAuthority,
): asserts value is PrivacyIncidentAdminAuthority {
  if (
    !isRecord(value) ||
    value[authorityBrand] !== true ||
    !canonicalTenant(value.tenantId) ||
    !canonicalIncidentId(value.userId)
  ) {
    throw new PrivacyIncidentInputError(
      "Fresh tenant-bound admin authorization is required.",
    );
  }
}

function requireTenantAndIncident(tenantId: string, incidentId: string): void {
  if (!canonicalTenant(tenantId)) {
    throw new PrivacyIncidentInputError(
      "A canonical workspace identity is required.",
    );
  }
  if (!canonicalIncidentId(incidentId)) {
    throw new PrivacyIncidentInputError("Incident id is malformed.");
  }
}

function assertIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 255 ||
    CONTROL.test(value)
  ) {
    throw new PrivacyIncidentInputError(
      "A stable 1–255 byte idempotency key is required.",
    );
  }
}

function assertCreateInput(input: PrivacyIncidentCreateInput): void {
  if (!boundedNarrative(input.summary, SUMMARY_MAX)) {
    throw new PrivacyIncidentInputError(
      "Summary is required and must be at most 4,000 characters.",
    );
  }
  if (input.severity !== undefined && !severity(input.severity)) {
    throw new PrivacyIncidentInputError("Choose a supported severity.");
  }
  if (input.detected_at !== undefined && !timestamp(input.detected_at)) {
    throw new PrivacyIncidentInputError("Detected time is invalid.");
  }
  if (
    input.discovered_at !== undefined &&
    input.discovered_at !== null &&
    !timestamp(input.discovered_at)
  ) {
    throw new PrivacyIncidentInputError("Discovery time is invalid.");
  }
  for (const [label, value] of [
    ["Affected regions", input.affected_regions],
    ["Data categories", input.affected_data_categories],
    ["Jurisdictions", input.jurisdictions],
  ] as const) {
    if (value !== undefined && !boundedScope(value)) {
      throw new PrivacyIncidentInputError(
        `${label} must contain at most 64 unique, safe entries of 256 characters or fewer.`,
      );
    }
  }
  if (
    input.affected_subject_count !== undefined &&
    input.affected_subject_count !== null &&
    (!Number.isSafeInteger(input.affected_subject_count) ||
      input.affected_subject_count < 0 ||
      input.affected_subject_count > 2_147_483_647)
  ) {
    throw new PrivacyIncidentInputError(
      "Affected subjects must be a whole number from 0 to 2,147,483,647.",
    );
  }
  const futureLimit = Date.now() + 5 * 60_000;
  if (
    (input.detected_at !== undefined &&
      Date.parse(input.detected_at) > futureLimit) ||
    (typeof input.discovered_at === "string" &&
      Date.parse(input.discovered_at) > futureLimit)
  ) {
    throw new PrivacyIncidentInputError(
      "Incident times cannot be more than five minutes in the future.",
    );
  }
}

export async function createPrivacyIncident(input: {
  authority: PrivacyIncidentAdminAuthority;
  incident: PrivacyIncidentCreateInput;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<PrivacyIncident> {
  assertAuthority(input.authority);
  assertCreateInput(input.incident);
  assertIdempotencyKey(input.idempotencyKey);
  const response = await api.post<unknown>(
    "/api/v1/privacy/incidents",
    input.incident,
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  return decodeIncident(response, "required");
}

export async function transitionPrivacyIncident(input: {
  authority: PrivacyIncidentAdminAuthority;
  incidentId: string;
  expectedFrom: PrivacyIncidentState;
  to: PrivacyIncidentState;
  reason: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<PrivacyIncidentTransitionReceipt> {
  assertAuthority(input.authority);
  requireTenantAndIncident(input.authority.tenantId, input.incidentId);
  assertIdempotencyKey(input.idempotencyKey);
  if (!state(input.expectedFrom) || !state(input.to)) {
    throw new PrivacyIncidentInputError("Transition state is invalid.");
  }
  if (input.to === "closed") {
    throw new PrivacyIncidentInputError(
      "Incident closure is release-held until verified legal and delivery evidence exists.",
    );
  }
  if (!boundedNarrative(input.reason, 2_000)) {
    throw new PrivacyIncidentInputError(
      "A transition reason of at most 2,000 characters is required.",
    );
  }
  const response = await api.post<unknown>(
    `/api/v1/privacy/incidents/${encodeURIComponent(input.incidentId)}/transition`,
    {
      expected_from: input.expectedFrom,
      to: input.to,
      reason: input.reason.trim(),
    },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  if (
    !isRecord(response) ||
    !exactKeys(response, ["incident_id", "from", "to", "at"]) ||
    response.incident_id !== input.incidentId ||
    response.from !== input.expectedFrom ||
    response.to !== input.to ||
    !timestamp(response.at)
  ) {
    throw new PrivacyIncidentContractError(
      "The service did not return an exact transition receipt. The incident will be refreshed before another attempt.",
    );
  }
  return response as unknown as PrivacyIncidentTransitionReceipt;
}

export function isAmbiguousPrivacyIncidentMutation(error: unknown): boolean {
  if (error instanceof PrivacyIncidentContractError) return true;
  if (!(error instanceof ApiError)) return false;
  if (["network", "offline", "timeout"].includes(error.kind)) return true;
  return error.status >= 500 || [408, 409, 425, 429].includes(error.status);
}
