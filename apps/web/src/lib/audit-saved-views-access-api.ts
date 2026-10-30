// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";
import type { AuditFilters } from "@/lib/audit-api";

const ONLINE_WRITE = { requireOnline: true, maxAttempts: 1 } as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_RE = /[\u0000\r\n]/u;
const MAX_SAVED_VIEWS = 250;
const MAX_ACCESS_REQUESTS = 200;

export type AuditAccessDecision = "approved" | "denied" | "dismissed";
export type AuditAccessStatus = "pending" | AuditAccessDecision;

export interface AuditCapabilities {
  scopes: string[];
  auditScopes: string[];
  isAdmin: boolean;
}

export interface AuditAccessRequest {
  id: string;
  userId?: string;
  userEmail?: string;
  actorLabel?: string;
  note?: string;
  status: AuditAccessStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditSavedFilterSnapshot {
  actorType?: "any" | "human" | "agent" | "system" | "platform_operator";
  actorLabel?: string;
  actionQuery?: string;
  resourceType?: string;
  resourceId?: string;
  days?: 0 | 7 | 30 | 90;
  category?:
    | "all"
    | "destructive"
    | "auth"
    | "export"
    | "one_click"
    | "meta_audit";
  since?: string;
  until?: string;
}

export interface AuditSavedView {
  id: string;
  name: string;
  description: string;
  filters: AuditSavedFilterSnapshot;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function text(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || CONTROL_RE.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || utf8Bytes(normalized) > maxBytes) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  label: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, maxBytes, true);
}

function uuid(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (!UUID_RE.test(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed.toLowerCase();
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T/u.test(parsed) ||
    !Number.isFinite(Date.parse(parsed))
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return parsed;
}

function stringList(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid ${label}.`);
  }
  const result = value.map((candidate) => text(candidate, label, 128));
  if (new Set(result).size !== result.length) {
    throw new Error(`Invalid duplicate ${label}.`);
  }
  return result;
}

export async function getAuditCapabilities(
  signal?: AbortSignal,
): Promise<AuditCapabilities> {
  const value = await api.get<unknown>("/api/v1/audit/my-scopes", { signal });
  if (
    !record(value) ||
    !exactKeys(value, ["scopes", "auditScopes", "isAdmin"]) ||
    typeof value.isAdmin !== "boolean"
  ) {
    throw new Error("The audit-capability response was invalid.");
  }
  const scopes = stringList(value.scopes, "scope", 512);
  const auditScopes = stringList(value.auditScopes, "audit scope", 32);
  if (
    auditScopes.some(
      (scope) => !scope.startsWith("audit:") || !scopes.includes(scope),
    ) ||
    scopes.some(
      (scope) => scope.startsWith("audit:") && !auditScopes.includes(scope),
    )
  ) {
    throw new Error("The audit-capability response was inconsistent.");
  }
  return { scopes, auditScopes, isAdmin: value.isAdmin };
}

export function canReadRawAudit(capabilities: AuditCapabilities): boolean {
  return (
    capabilities.auditScopes.includes("audit:read") &&
    capabilities.auditScopes.includes("audit:read_pii")
  );
}

export function canManageAuditSavedViews(
  capabilities: AuditCapabilities,
): boolean {
  return (
    capabilities.isAdmin &&
    canReadRawAudit(capabilities) &&
    capabilities.auditScopes.includes("audit:execute_actions")
  );
}

function parseAccessRequest(value: unknown): AuditAccessRequest {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "userId",
      "userEmail",
      "actorLabel",
      "note",
      "status",
      "createdAt",
      "resolvedAt",
    ])
  ) {
    throw new Error("The audit-access request response was invalid.");
  }
  const status = value.status;
  if (
    status !== "pending" &&
    status !== "approved" &&
    status !== "denied" &&
    status !== "dismissed"
  ) {
    throw new Error("The audit-access request status was invalid.");
  }
  const userId =
    value.userId === undefined ? undefined : uuid(value.userId, "requester ID");
  const userEmail = optionalText(value.userEmail, "requester email", 320);
  if (userEmail !== undefined && !userEmail.includes("@")) {
    throw new Error("The audit-access requester email was invalid.");
  }
  const actorLabel = optionalText(value.actorLabel, "actor label", 512);
  const note = optionalText(value.note, "request note", 1_000);
  const resolvedAt =
    value.resolvedAt === undefined
      ? undefined
      : timestamp(value.resolvedAt, "resolution timestamp");
  if (status === "pending" && resolvedAt !== undefined) {
    throw new Error("A pending audit-access request was marked resolved.");
  }
  return {
    id: uuid(value.id, "access-request ID"),
    status,
    createdAt: timestamp(value.createdAt, "request timestamp"),
    ...(userId ? { userId } : {}),
    ...(userEmail !== undefined ? { userEmail } : {}),
    ...(actorLabel !== undefined ? { actorLabel } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
  };
}

export function auditAccessRequesterKey(request: AuditAccessRequest): string {
  if (request.userId) return `user:${request.userId}`;
  if (request.actorLabel) return `actor:${request.actorLabel}`;
  return "unidentified";
}

export function auditAccessRequesterLabel(request: AuditAccessRequest): string {
  return request.userEmail || request.actorLabel || request.userId || "Unidentified actor";
}

export async function createAuditAccessRequest(
  input: {
    note: string;
    expectedUserId: string;
    expectedEmail: string;
  },
  signal?: AbortSignal,
): Promise<AuditAccessRequest> {
  const note = normalizeAccessRequestNote(input.note);
  const expectedUserId = uuid(input.expectedUserId, "current user ID");
  const expectedEmail = text(input.expectedEmail, "current user email", 320);
  const value = await api.post<unknown>(
    "/api/v1/audit/access-requests",
    note ? { note } : {},
    { ...ONLINE_WRITE, signal },
  );
  if (!record(value) || !exactKeys(value, ["request"])) {
    throw new Error("The audit-access request receipt was invalid.");
  }
  const request = parseAccessRequest(value.request);
  if (
    request.status !== "pending" ||
    request.userId !== expectedUserId ||
    (request.userEmail !== undefined &&
      request.userEmail.toLowerCase() !== expectedEmail.toLowerCase())
  ) {
    throw new Error("The audit-access request receipt did not match this session.");
  }
  return request;
}

export function normalizeAccessRequestNote(note: string): string {
  const normalized = note.trim();
  if (CONTROL_RE.test(normalized) || utf8Bytes(normalized) > 1_000) {
    throw new Error("The request note must be 1,000 UTF-8 bytes or fewer.");
  }
  return normalized;
}

export async function listAuditAccessRequests(
  status: AuditAccessStatus | "all",
  signal?: AbortSignal,
): Promise<AuditAccessRequest[]> {
  const value = await api.get<unknown>(
    `/api/v1/audit/access-requests?status=${encodeURIComponent(status)}&limit=${MAX_ACCESS_REQUESTS}`,
    { signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, ["items"]) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_ACCESS_REQUESTS
  ) {
    throw new Error("The audit-access review queue was invalid.");
  }
  const items = value.items.map(parseAccessRequest);
  const ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (ids.has(item.id)) throw new Error("The audit-access queue repeated an ID.");
    if (status !== "all" && item.status !== status) {
      throw new Error("The audit-access queue crossed the requested status filter.");
    }
    if (index > 0 && Date.parse(item.createdAt) > Date.parse(items[index - 1]!.createdAt)) {
      throw new Error("The audit-access queue was not newest first.");
    }
    ids.add(item.id);
  }
  return items;
}

export async function resolveAuditAccessRequest(
  request: AuditAccessRequest,
  decision: AuditAccessDecision,
  signal?: AbortSignal,
): Promise<{ request: AuditAccessRequest; grantVerified: boolean }> {
  if (request.status !== "pending" || !["approved", "denied", "dismissed"].includes(decision)) {
    throw new Error("Only a pending audit-access request can be decided.");
  }
  const value = await api.patch<unknown>(
    `/api/v1/audit/access-requests/${encodeURIComponent(uuid(request.id, "access-request ID"))}`,
    {
      status: decision,
      expectedStatus: "pending",
      expectedRequesterKey: auditAccessRequesterKey(request),
      expectedCreatedAt: timestamp(request.createdAt, "request timestamp"),
    },
    { ...ONLINE_WRITE, signal },
  );
  if (
    !record(value) ||
    !exactKeys(value, ["request", "grantVerified"]) ||
    typeof value.grantVerified !== "boolean"
  ) {
    throw new Error("The audit-access decision receipt was invalid.");
  }
  const resolved = parseAccessRequest(value.request);
  if (
    resolved.id !== request.id ||
    resolved.status !== decision ||
    resolved.createdAt !== request.createdAt ||
    auditAccessRequesterKey(resolved) !== auditAccessRequesterKey(request) ||
    !resolved.resolvedAt ||
    value.grantVerified !== (decision === "approved")
  ) {
    throw new Error("The audit-access decision receipt did not match the reviewed request.");
  }
  return { request: resolved, grantVerified: value.grantVerified };
}

function parseSavedFilters(value: unknown): AuditSavedFilterSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, [
      "actorType",
      "actorLabel",
      "actionQuery",
      "resourceType",
      "resourceId",
      "days",
      "category",
      "since",
      "until",
    ])
  ) {
    throw new Error("The saved audit filter snapshot was invalid.");
  }
  let actorType = value.actorType;
  if (actorType === "user") actorType = "human";
  if (
    actorType !== undefined &&
    actorType !== "any" &&
    actorType !== "human" &&
    actorType !== "agent" &&
    actorType !== "system" &&
    actorType !== "platform_operator"
  ) {
    throw new Error("The saved audit actor type was invalid.");
  }
  const days = value.days;
  if (days !== undefined && days !== 0 && days !== 7 && days !== 30 && days !== 90) {
    throw new Error("The saved audit day range was invalid.");
  }
  const category = value.category;
  if (
    category !== undefined &&
    category !== "all" &&
    category !== "destructive" &&
    category !== "auth" &&
    category !== "export" &&
    category !== "one_click" &&
    category !== "meta_audit"
  ) {
    throw new Error("The saved audit category was invalid.");
  }
  const since =
    value.since === undefined || value.since === ""
      ? undefined
      : timestamp(value.since, "saved since timestamp");
  const until =
    value.until === undefined || value.until === ""
      ? undefined
      : timestamp(value.until, "saved until timestamp");
  if (since && until && Date.parse(since) > Date.parse(until)) {
    throw new Error("The saved audit date range was inverted.");
  }
  return {
    ...(actorType === undefined ? {} : { actorType }),
    ...(optionalText(value.actorLabel, "saved actor label", 256) === undefined
      ? {}
      : { actorLabel: optionalText(value.actorLabel, "saved actor label", 256) }),
    ...(optionalText(value.actionQuery, "saved action query", 256) === undefined
      ? {}
      : { actionQuery: optionalText(value.actionQuery, "saved action query", 256) }),
    ...(optionalText(value.resourceType, "saved resource type", 128) === undefined
      ? {}
      : { resourceType: optionalText(value.resourceType, "saved resource type", 128) }),
    ...(optionalText(value.resourceId, "saved resource ID", 512) === undefined
      ? {}
      : { resourceId: optionalText(value.resourceId, "saved resource ID", 512) }),
    ...(days === undefined ? {} : { days }),
    ...(category === undefined ? {} : { category }),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
  } as AuditSavedFilterSnapshot;
}

function parseSavedView(value: unknown): AuditSavedView {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "name",
      "description",
      "filters",
      "createdAt",
      "updatedAt",
      "createdBy",
    ])
  ) {
    throw new Error("The saved audit view response was invalid.");
  }
  const createdAt = timestamp(value.createdAt, "saved-view creation timestamp");
  const updatedAt = timestamp(value.updatedAt, "saved-view revision");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("The saved audit view revision predates its creation.");
  }
  const description = optionalText(value.description, "saved-view description", 2_048) ?? "";
  return {
    id: uuid(value.id, "saved-view ID"),
    name: text(value.name, "saved-view name", 256),
    description,
    filters: parseSavedFilters(value.filters),
    createdAt,
    updatedAt,
    ...(value.createdBy === undefined
      ? {}
      : { createdBy: uuid(value.createdBy, "saved-view creator ID") }),
  };
}

export async function listAuditSavedViews(
  signal?: AbortSignal,
  fresh = false,
): Promise<AuditSavedView[]> {
  const value = await api.get<unknown>("/api/v1/audit/saved-views", {
    signal,
    ...(fresh ? ONLINE_WRITE : {}),
  });
  if (
    !record(value) ||
    !exactKeys(value, ["views"]) ||
    !Array.isArray(value.views) ||
    value.views.length > MAX_SAVED_VIEWS
  ) {
    throw new Error("The saved audit views response was invalid.");
  }
  const views = value.views.map(parseSavedView);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (let index = 0; index < views.length; index += 1) {
    const view = views[index]!;
    if (ids.has(view.id) || names.has(view.name)) {
      throw new Error("The saved audit views response contained duplicates.");
    }
    if (index > 0 && Date.parse(view.updatedAt) > Date.parse(views[index - 1]!.updatedAt)) {
      throw new Error("The saved audit views response was not newest-updated first.");
    }
    ids.add(view.id);
    names.add(view.name);
  }
  return views;
}

function normalizeSavedViewDraft(input: {
  name: string;
  description: string;
  filters: AuditSavedFilterSnapshot;
}): { name: string; description: string; filters: AuditSavedFilterSnapshot } {
  const normalized = {
    name: text(input.name, "saved-view name", 256),
    description: text(input.description, "saved-view description", 2_048, true),
    filters: parseSavedFilters(input.filters),
  };
  if (utf8Bytes(JSON.stringify(normalized)) > 28 * 1_024) {
    throw new Error("The saved-view request exceeds 28 KiB.");
  }
  return normalized;
}

export function auditSavedViewDraftError(input: {
  name: string;
  description: string;
  filters: AuditSavedFilterSnapshot;
}): string | null {
  try {
    normalizeSavedViewDraft(input);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The saved-view draft is invalid.";
  }
}

export async function createAuditSavedView(
  input: { name: string; description: string; filters: AuditSavedFilterSnapshot },
  signal?: AbortSignal,
): Promise<AuditSavedView> {
  const normalized = normalizeSavedViewDraft(input);
  const value = await api.post<unknown>(
    "/api/v1/audit/saved-views",
    normalized,
    { ...ONLINE_WRITE, signal },
  );
  const view = parseSavedView(value);
  if (
    view.name !== normalized.name ||
    view.description !== normalized.description ||
    JSON.stringify(view.filters) !== JSON.stringify(normalized.filters)
  ) {
    throw new Error("The saved-view creation receipt did not match the request.");
  }
  return view;
}

export async function updateAuditSavedView(
  current: AuditSavedView,
  input: { name: string; description: string; filters: AuditSavedFilterSnapshot },
  signal?: AbortSignal,
): Promise<AuditSavedView> {
  const normalized = normalizeSavedViewDraft(input);
  const value = await api.patch<unknown>(
    `/api/v1/audit/saved-views/${encodeURIComponent(uuid(current.id, "saved-view ID"))}`,
    { ...normalized, expectedUpdatedAt: timestamp(current.updatedAt, "saved-view revision") },
    { ...ONLINE_WRITE, signal },
  );
  const view = parseSavedView(value);
  if (
    view.id !== current.id ||
    view.name !== normalized.name ||
    view.description !== normalized.description ||
    JSON.stringify(view.filters) !== JSON.stringify(normalized.filters)
  ) {
    throw new Error("The saved-view update receipt did not match the request.");
  }
  return view;
}

export async function deleteAuditSavedView(
  current: AuditSavedView,
  signal?: AbortSignal,
): Promise<void> {
  const id = uuid(current.id, "saved-view ID");
  const revision = timestamp(current.updatedAt, "saved-view revision");
  const value = await api.delete<unknown>(
    `/api/v1/audit/saved-views/${encodeURIComponent(id)}?expected_updated_at=${encodeURIComponent(revision)}`,
    { ...ONLINE_WRITE, signal },
  );
  if (!record(value) || !exactKeys(value, ["ok"]) || value.ok !== true) {
    throw new Error("The saved-view deletion receipt was invalid.");
  }
}

export function sameAuditSavedViewRevision(
  left: AuditSavedView,
  right: AuditSavedView,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.updatedAt === right.updatedAt &&
    JSON.stringify(left.filters) === JSON.stringify(right.filters)
  );
}

export function auditFiltersToSavedSnapshot(
  filters: AuditFilters,
): AuditSavedFilterSnapshot {
  return parseSavedFilters({
    actorType: filters.actorType || "any",
    actorLabel: filters.actorLabel || "",
    actionQuery: filters.action || "",
    resourceType: filters.resourceType || "",
    resourceId: filters.resourceId || "",
    days: 0,
    category: "all",
    since: filters.since || "",
    until: filters.until || "",
  });
}

export function auditFiltersFromSavedSnapshot(
  snapshot: AuditSavedFilterSnapshot,
  now = Date.now(),
): Required<Pick<AuditFilters, "actorType" | "actorLabel" | "action" | "resourceType" | "resourceId" | "since" | "until">> {
  const parsed = parseSavedFilters(snapshot);
  const categoryAction: Record<string, string> = {
    destructive: "delete",
    auth: "login",
    export: "export",
    one_click: "one_click",
    meta_audit: "audit.read",
  };
  let since = parsed.since ?? "";
  if (!since && parsed.days) {
    const date = new Date(now - parsed.days * 86_400_000);
    date.setUTCHours(0, 0, 0, 0);
    since = date.toISOString();
  }
  return {
    actorType: parsed.actorType === "any" ? "" : parsed.actorType ?? "",
    actorLabel: parsed.actorLabel ?? "",
    action: parsed.actionQuery || categoryAction[parsed.category ?? ""] || "",
    resourceType: parsed.resourceType ?? "",
    resourceId: parsed.resourceId ?? "",
    since,
    until: parsed.until ?? "",
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
