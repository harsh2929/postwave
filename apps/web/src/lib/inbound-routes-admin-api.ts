// SPDX-License-Identifier: AGPL-3.0-only

import { api, ApiError } from "@/lib/api";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const ENDPOINT_SECRET = /^iem_[0-9a-f]{48}$/;
const ENDPOINT_SLUG = /^[0-9a-f]{16}$/;
const ACTION_KINDS = [
  "tag",
  "automation_trigger",
  "webhook",
  "forward",
  "store_only",
] as const;
const MAX_ROUTES = 500;
const MAX_ACTIONS = 50;
const MAX_BODY_BYTES = 30 * 1024;

export type InboundRouteActionKind = (typeof ACTION_KINDS)[number];
export type InboundJson =
  | null
  | boolean
  | number
  | string
  | InboundJson[]
  | { [key: string]: InboundJson };

export interface InboundRouteAction {
  kind: InboundRouteActionKind;
  tag?: string;
  eventType?: string;
  url?: string;
  to?: string;
  extra: Record<string, InboundJson>;
  hasStoredHmacSecret: boolean;
  sourceIndex: number;
}

export interface InboundRoute {
  id: string;
  name: string;
  priority: number;
  stopOnMatch: boolean;
  enabled: boolean;
  matchRecipient: string;
  matchSubjectPrefix: string;
  matchFromDomain: string;
  actions: InboundRouteAction[];
  lastMatchedAt?: string;
  matchCount: number;
  actionRetryMax: number;
  actionRetryBackoffSeconds: number;
  updatedAt: string;
}

export interface InboundRouteActionDraft {
  kind: InboundRouteActionKind;
  tag?: string;
  eventType?: string;
  url?: string;
  to?: string;
  extra?: Record<string, InboundJson>;
  hmacSecret?: string;
  preserveHmacFromIndex?: number;
  removeStoredHmac?: boolean;
}

export interface InboundRouteDraft {
  name: string;
  priority: number;
  stopOnMatch: boolean;
  enabled: boolean;
  matchRecipient: string;
  matchSubjectPrefix?: string;
  matchFromDomain?: string;
  actions: InboundRouteActionDraft[];
  actionRetryMax: number;
  actionRetryBackoffSeconds: number;
}

interface InboundRouteWireAction {
  kind: InboundRouteActionKind;
  tag?: string;
  event_type?: string;
  url?: string;
  to?: string;
  extra?: Record<string, InboundJson>;
  preserve_hmac_from_index?: number;
  remove_stored_hmac?: boolean;
}

interface InboundRouteWireInput {
  name: string;
  priority: number;
  stop_on_match: boolean;
  enabled: boolean;
  match_recipient: string;
  match_subject_prefix: string;
  match_from_domain: string;
  actions: InboundRouteWireAction[];
  action_retry_max: number;
  action_retry_backoff_seconds: number;
  clear_actions?: boolean;
  expected_updated_at?: string;
}

export interface InboundRoutePreview {
  matches: Array<{ route: InboundRoute; reason: string }>;
  evaluated: number;
  stoppedAtRouteId?: string;
  noMatches: boolean;
}

export interface InboundEmailEndpoint {
  id: string;
  tenantId: string;
  slug: string;
  secretConfigured: boolean;
  rotationRequired: boolean;
  secretRotatedAt?: string;
  createdAt: string;
}

export interface InboundEmailEndpointReveal extends InboundEmailEndpoint {
  secret: string;
}

export class InboundRouteContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundRouteContractError";
  }
}

export class InboundRouteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundRouteInputError";
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let outputBytes = 0;
  const encoder = new TextEncoder();
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (outputBytes + characterBytes > maxBytes) break;
    output += character;
    outputBytes += characterBytes;
  }
  return output;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InboundRouteContractError(`${label} returned an invalid response.`);
  return value as Record<string, unknown>;
}

function collection(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new InboundRouteContractError(
      `${label} returned an invalid or oversized collection.`,
    );
  return value;
}

function responseText(
  value: unknown,
  field: string,
  options: { empty?: boolean; max?: number } = {},
): string {
  if (typeof value !== "string" || (!options.empty && !value.trim()))
    throw new InboundRouteContractError(
      `The inbound-route service returned an invalid ${field}.`,
    );
  if (bytes(value) > (options.max ?? 4_096))
    throw new InboundRouteContractError(
      `The inbound-route service returned an oversized ${field}.`,
    );
  return value;
}

function responseOptionalText(
  value: unknown,
  field: string,
  max = 4_096,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return responseText(value, field, { max });
}

function responseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new InboundRouteContractError(
      `The inbound-route service returned an invalid ${field}.`,
    );
  return value;
}

function responseInteger(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    throw new InboundRouteContractError(
      `The inbound-route service returned an invalid ${field}.`,
    );
  return Number(value);
}

function responseUuid(value: unknown, field: string): string {
  const normalized = responseText(value, field, { max: 36 }).toLowerCase();
  if (!UUID.test(normalized))
    throw new InboundRouteContractError(
      `The inbound-route service returned an invalid ${field}.`,
    );
  return normalized;
}

function responseTimestamp(value: unknown, field: string): string {
  const normalized = responseText(value, field, { max: 64 });
  if (!Number.isFinite(Date.parse(normalized)))
    throw new InboundRouteContractError(
      `The inbound-route service returned an invalid ${field}.`,
    );
  return normalized;
}

function safeJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): InboundJson {
  state.nodes += 1;
  if (state.nodes > 1_000 || depth > 8)
    throw new InboundRouteContractError(
      "An inbound action exceeded the safe structural limit.",
    );
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value === "string") {
    if (bytes(value) > 4_096)
      throw new InboundRouteContractError(
        "An inbound action contained an oversized string.",
      );
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100)
      throw new InboundRouteContractError(
        "An inbound action contained an oversized array.",
      );
    return value.map((item) => safeJson(item, state, depth + 1));
  }
  const source = object(value, "Inbound action data");
  const keys = Object.keys(source).sort();
  if (keys.length > 100)
    throw new InboundRouteContractError(
      "An inbound action contained too many keys.",
    );
  const out: Record<string, InboundJson> = {};
  for (const key of keys) {
    if (
      !key ||
      bytes(key) > 128 ||
      /[\u0000-\u001f\u007f]/.test(key) ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      throw new InboundRouteContractError(
        "An inbound action contained an unsafe key.",
      );
    out[key] = safeJson(source[key], state, depth + 1);
  }
  return out;
}

function safeJsonObject(value: unknown): Record<string, InboundJson> {
  const parsed = safeJson(value ?? {}, { nodes: 0 });
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    throw new InboundRouteContractError("Inbound action extra must be an object.");
  return parsed;
}

function zeroBytes(value: Uint8Array): void {
  value.fill(0);
}

export function clearInboundRouteSecretVault(
  _tenantId: string,
  _routeId?: string,
): void {
  // Kept as a compatibility no-op for mounted clients that used to clear the
  // short-lived plaintext vault. Stored HMAC material is no longer returned to
  // or retained by the browser.
}

function decodeAction(
  value: unknown,
  sourceIndex: number,
): InboundRouteAction {
  const row = object(value, `Inbound route action ${sourceIndex + 1}`);
  const kind = responseText(row.kind, "action kind", { max: 32 });
  if (!ACTION_KINDS.includes(kind as InboundRouteActionKind))
    throw new InboundRouteContractError(
      "The inbound-route service returned an unsupported action kind.",
    );
  const extra = safeJsonObject(row.extra);
  if (Object.prototype.hasOwnProperty.call(extra, "hmac_secret")) {
    throw new InboundRouteContractError(
      "The inbound-route service unexpectedly exposed webhook signing material.",
    );
  }
  const hasStoredHmacSecret = responseBoolean(
    row.has_stored_hmac_secret ?? false,
    "stored HMAC marker",
  );
  if (hasStoredHmacSecret && kind !== "webhook")
    throw new InboundRouteContractError(
      "The inbound-route service returned a stored HMAC marker on a non-webhook action.",
    );
  return {
    kind: kind as InboundRouteActionKind,
    ...(responseOptionalText(row.tag, "action tag", 256)
      ? { tag: responseText(row.tag, "action tag", { max: 256 }) }
      : {}),
    ...(responseOptionalText(row.event_type, "action event type", 256)
      ? {
          eventType: responseText(row.event_type, "action event type", {
            max: 256,
          }),
        }
      : {}),
    ...(responseOptionalText(row.url, "action URL", 2_048)
      ? { url: responseText(row.url, "action URL", { max: 2_048 }) }
      : {}),
    ...(responseOptionalText(row.to, "forward address", 320)
      ? { to: responseText(row.to, "forward address", { max: 320 }) }
      : {}),
    extra,
    hasStoredHmacSecret,
    sourceIndex,
  };
}

function decodeRoute(
  value: unknown,
  _tenantId: string,
): InboundRoute {
  const row = object(value, "Inbound route");
  const id = responseUuid(row.id, "route identity");
  const actions = collection(row.actions, "Inbound route actions", MAX_ACTIONS).map(
    (action, index) => decodeAction(action, index),
  );
  return {
    id,
    name: responseText(row.name, "route name", { empty: true, max: 120 }),
    priority: responseInteger(row.priority, "route priority", 0, 10_000),
    stopOnMatch: responseBoolean(row.stop_on_match, "stop-on-match flag"),
    enabled: responseBoolean(row.enabled, "enabled flag"),
    matchRecipient: responseText(row.match_recipient, "recipient matcher", {
      max: 320,
    }),
    matchSubjectPrefix: responseText(
      row.match_subject_prefix ?? "",
      "subject matcher",
      { empty: true, max: 255 },
    ),
    matchFromDomain: responseText(
      row.match_from_domain ?? "",
      "sender-domain matcher",
      { empty: true, max: 253 },
    ),
    actions,
    ...(row.last_matched_at !== undefined && row.last_matched_at !== null
      ? { lastMatchedAt: responseTimestamp(row.last_matched_at, "last match time") }
      : {}),
    matchCount: responseInteger(row.match_count, "route match count"),
    actionRetryMax: responseInteger(
      row.action_retry_max ?? 0,
      "action retry count",
      0,
      5,
    ),
    actionRetryBackoffSeconds: responseInteger(
      row.action_retry_backoff_seconds ?? 0,
      "action retry backoff",
      0,
      60,
    ),
    updatedAt: responseTimestamp(row.updated_at, "route configuration revision"),
  };
}

function assertTenantId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized))
    throw new InboundRouteInputError("The workspace identity is invalid.");
  return normalized;
}

function assertRouteId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized))
    throw new InboundRouteInputError("The route identity is invalid.");
  return normalized;
}

function assertOperationKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value))
    throw new InboundRouteInputError("The operation identity is invalid.");
}

function assertConfigurationRevision(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (
    !normalized ||
    bytes(normalized) > 64 ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  )
    throw new InboundRouteInputError(
      "The route configuration revision is invalid. Refresh before saving.",
    );
  return normalized;
}

function inputText(
  value: string | undefined,
  field: string,
  options: { empty?: boolean; max: number },
): string {
  const normalized = value?.trim() ?? "";
  if ((!options.empty && !normalized) || bytes(normalized) > options.max)
    throw new InboundRouteInputError(
      `${field} must use ${options.empty ? "at most" : "1–"}${options.max.toLocaleString()} bytes.`,
    );
  if (/[\u0000-\u001f\u007f]/.test(normalized))
    throw new InboundRouteInputError(`${field} cannot contain control characters.`);
  return normalized;
}

function normalizeAction(
  value: InboundRouteActionDraft,
  context?: { tenantId: string; routeId: string },
): InboundRouteWireAction {
  if (!ACTION_KINDS.includes(value.kind))
    throw new InboundRouteInputError("Choose a supported inbound action kind.");
  const extra = safeJsonObject(value.extra);
  if (Object.prototype.hasOwnProperty.call(extra, "hmac_secret"))
    throw new InboundRouteInputError(
      "Raw HMAC signing material cannot be supplied through action extras. Use the dedicated replacement field.",
    );
  const output: InboundRouteWireAction = { kind: value.kind };
  if (value.kind === "tag")
    output.tag = inputText(value.tag, "Tag", { max: 256 });
  if (value.kind === "automation_trigger")
    output.event_type = inputText(value.eventType, "Event type", { max: 256 });
  if (value.kind === "webhook") {
    const target = inputText(value.url, "Webhook URL", { max: 2_048 });
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new InboundRouteInputError("Webhook URL must be an absolute HTTP or HTTPS URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new InboundRouteInputError(
        "Webhook URL must be HTTP or HTTPS and cannot contain credentials.",
      );
    output.url = target;
    if (value.removeStoredHmac && value.hmacSecret?.trim())
      throw new InboundRouteInputError(
        "Choose either HMAC replacement or removal, not both.",
      );
    const replacement = value.hmacSecret?.trim() ?? "";
    if (bytes(replacement) > 4_096 || /[\u0000-\u001f\u007f]/.test(replacement))
      throw new InboundRouteInputError(
        "HMAC secret must use at most 4,096 bytes without control characters.",
      );
    if (replacement) {
      extra.hmac_secret = replacement;
    } else if (value.removeStoredHmac) {
      output.remove_stored_hmac = true;
    } else if (value.preserveHmacFromIndex !== undefined) {
      if (!context)
        throw new InboundRouteInputError(
          "A new route cannot preserve signing material from another route.",
        );
      if (
        !Number.isSafeInteger(value.preserveHmacFromIndex) ||
        value.preserveHmacFromIndex < 0 ||
        value.preserveHmacFromIndex >= MAX_ACTIONS
      )
        throw new InboundRouteInputError(
          "The stored webhook secret reference is invalid. Refresh before saving.",
        );
      output.preserve_hmac_from_index = value.preserveHmacFromIndex;
    }
  }
  if (value.kind === "forward")
    output.to = inputText(value.to, "Forward address", { max: 320 });
  if (Object.keys(extra).length > 0) output.extra = extra;
  return output;
}

function normalizeDraft(
  value: InboundRouteDraft,
  context?: {
    tenantId: string;
    routeId: string;
    update?: boolean;
    expectedUpdatedAt?: string;
  },
): InboundRouteWireInput {
  if (!Number.isSafeInteger(value.priority) || value.priority < 0 || value.priority > 10_000)
    throw new InboundRouteInputError(
      "Priority must be a whole number from 0 through 10,000.",
    );
  if (
    !Number.isSafeInteger(value.actionRetryMax) ||
    value.actionRetryMax < 0 ||
    value.actionRetryMax > 5
  )
    throw new InboundRouteInputError(
      "Retry count must be a whole number from 0 through 5.",
    );
  if (
    !Number.isSafeInteger(value.actionRetryBackoffSeconds) ||
    value.actionRetryBackoffSeconds < 0 ||
    value.actionRetryBackoffSeconds > 60
  )
    throw new InboundRouteInputError(
      "Retry backoff must be a whole number from 0 through 60 seconds.",
    );
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS)
    throw new InboundRouteInputError(`A route may contain at most ${MAX_ACTIONS} actions.`);
  const output: InboundRouteWireInput = {
    name: inputText(value.name, "Name", { max: 120 }),
    priority: value.priority,
    stop_on_match: Boolean(value.stopOnMatch),
    enabled: Boolean(value.enabled),
    match_recipient: inputText(value.matchRecipient || "*", "Recipient matcher", {
      max: 320,
    }),
    match_subject_prefix: inputText(value.matchSubjectPrefix, "Subject matcher", {
      empty: true,
      max: 255,
    }),
    match_from_domain: inputText(value.matchFromDomain, "Sender domain", {
      empty: true,
      max: 253,
    }).toLowerCase(),
    actions: value.actions.map((action) => normalizeAction(action, context)),
    action_retry_max: value.actionRetryMax,
    action_retry_backoff_seconds: value.actionRetryBackoffSeconds,
    ...(context?.update && value.actions.length === 0
      ? { clear_actions: true }
      : {}),
    ...(context?.update
      ? {
          expected_updated_at: assertConfigurationRevision(
            context.expectedUpdatedAt,
          ),
        }
      : {}),
  };
  if (bytes(JSON.stringify(output)) > MAX_BODY_BYTES)
    throw new InboundRouteInputError(
      "The route definition exceeds the safe 30 KiB request limit.",
    );
  return output;
}

function zeroizeWireSecrets(value: InboundRouteWireInput): void {
  for (const action of value.actions) {
    if (typeof action.extra?.hmac_secret === "string")
      action.extra.hmac_secret = "";
  }
}

function safeActionExpectation(value: InboundRouteActionDraft) {
  const extra = safeJsonObject(value.extra);
  delete extra.hmac_secret;
  return {
    kind: value.kind,
    tag: value.kind === "tag" ? value.tag?.trim() : undefined,
    eventType:
      value.kind === "automation_trigger" ? value.eventType?.trim() : undefined,
    url: value.kind === "webhook" ? value.url?.trim() : undefined,
    to: value.kind === "forward" ? value.to?.trim() : undefined,
    extra,
    expectsHmac:
      value.kind === "webhook" &&
      !value.removeStoredHmac &&
      Boolean(value.hmacSecret?.trim() || value.preserveHmacFromIndex !== undefined),
  };
}

export function inboundRouteMatchesDraft(
  route: InboundRoute,
  value: InboundRouteDraft,
): boolean {
  const expectedActions = value.actions.map(safeActionExpectation);
  return (
    route.name === value.name.trim() &&
    route.priority === value.priority &&
    route.stopOnMatch === value.stopOnMatch &&
    route.enabled === value.enabled &&
    route.matchRecipient === (value.matchRecipient.trim() || "*") &&
    route.matchSubjectPrefix === (value.matchSubjectPrefix?.trim() ?? "") &&
    route.matchFromDomain === (value.matchFromDomain?.trim().toLowerCase() ?? "") &&
    route.actionRetryMax === value.actionRetryMax &&
    route.actionRetryBackoffSeconds === value.actionRetryBackoffSeconds &&
    route.actions.length === expectedActions.length &&
    route.actions.every((action, index) => {
      const expected = expectedActions[index];
      return Boolean(
        expected &&
          action.kind === expected.kind &&
          action.tag === expected.tag &&
          action.eventType === expected.eventType &&
          action.url === expected.url &&
          action.to === expected.to &&
          JSON.stringify(action.extra) === JSON.stringify(expected.extra) &&
          action.hasStoredHmacSecret === expected.expectsHmac,
      );
    })
  );
}

export function inboundRouteConfigurationEqual(
  left: InboundRoute,
  right: InboundRoute,
): boolean {
  const configuration = (route: InboundRoute) => ({
    id: route.id,
    name: route.name,
    priority: route.priority,
    stopOnMatch: route.stopOnMatch,
    enabled: route.enabled,
    matchRecipient: route.matchRecipient,
    matchSubjectPrefix: route.matchSubjectPrefix,
    matchFromDomain: route.matchFromDomain,
    actions: route.actions,
    actionRetryMax: route.actionRetryMax,
    actionRetryBackoffSeconds: route.actionRetryBackoffSeconds,
  });
  return JSON.stringify(configuration(left)) === JSON.stringify(configuration(right));
}

export async function listInboundRoutesStrict(input: {
  tenantId: string;
  retainHmacSecrets?: boolean;
  signal?: AbortSignal;
}): Promise<InboundRoute[]> {
  const tenantId = assertTenantId(input.tenantId);
  const root = object(
    await api.get<unknown>("/api/v1/inbound-routes", {
      requireOnline: true,
      maxAttempts: 1,
      signal: input.signal,
    }),
    "Inbound route catalogue",
  );
  const routes = collection(root.routes, "Inbound route catalogue", MAX_ROUTES).map(
    (route) => decodeRoute(route, tenantId),
  );
  if (new Set(routes.map((route) => route.id)).size !== routes.length)
    throw new InboundRouteContractError(
      "The inbound-route service returned duplicate route identities.",
    );
  return routes;
}

export async function inboundRouteWriteFingerprint(input: {
  tenantId: string;
  routeId?: string;
  expectedUpdatedAt?: string;
  draft: InboundRouteDraft;
}): Promise<string> {
  const tenantId = assertTenantId(input.tenantId);
  const routeId = input.routeId ? assertRouteId(input.routeId) : undefined;
  const wire = normalizeDraft(
    input.draft,
    routeId
      ? {
          tenantId,
          routeId,
          update: true,
          expectedUpdatedAt: input.expectedUpdatedAt,
        }
      : undefined,
  );
  const encoded = new TextEncoder().encode(JSON.stringify(wire));
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
    return Array.from(new Uint8Array(digest), (part) =>
      part.toString(16).padStart(2, "0"),
    ).join("");
  } finally {
    zeroBytes(encoded);
    zeroizeWireSecrets(wire);
  }
}

export async function createInboundRouteStrict(input: {
  tenantId: string;
  draft: InboundRouteDraft;
  idempotencyKey: string;
}): Promise<string> {
  assertTenantId(input.tenantId);
  assertOperationKey(input.idempotencyKey);
  const wire = normalizeDraft(input.draft);
  try {
    const receipt = object(
      await api.post<unknown>("/api/v1/inbound-routes", wire, {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
      }),
      "Inbound route creation receipt",
    );
    return responseUuid(receipt.id, "created route identity");
  } finally {
    zeroizeWireSecrets(wire);
  }
}

export async function updateInboundRouteStrict(input: {
  tenantId: string;
  routeId: string;
  expectedUpdatedAt: string;
  draft: InboundRouteDraft;
  idempotencyKey: string;
}): Promise<void> {
  const tenantId = assertTenantId(input.tenantId);
  const routeId = assertRouteId(input.routeId);
  assertOperationKey(input.idempotencyKey);
  const wire = normalizeDraft(input.draft, {
    tenantId,
    routeId,
    update: true,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
  try {
    await api.patch(
      `/api/v1/inbound-routes/${encodeURIComponent(routeId)}`,
      wire,
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
      },
    );
  } finally {
    zeroizeWireSecrets(wire);
  }
}

export async function deleteInboundRouteStrict(input: {
  routeId: string;
  idempotencyKey: string;
}): Promise<void> {
  const routeId = assertRouteId(input.routeId);
  assertOperationKey(input.idempotencyKey);
  await api.delete(`/api/v1/inbound-routes/${encodeURIComponent(routeId)}`, {
    requireOnline: true,
    maxAttempts: 1,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function previewInboundRoutesStrict(input: {
  tenantId: string;
  recipient: string;
  subject?: string;
  from?: string;
  signal?: AbortSignal;
}): Promise<InboundRoutePreview> {
  const tenantId = assertTenantId(input.tenantId);
  const recipient = inputText(input.recipient, "Preview recipient", { max: 320 });
  const subject = inputText(input.subject, "Preview subject", {
    empty: true,
    max: 998,
  });
  const from = inputText(input.from, "Preview sender", { empty: true, max: 320 });
  const root = object(
    await api.post<unknown>(
      "/api/v1/inbound-routes/preview",
      { recipient, subject, from },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: null,
        signal: input.signal,
      },
    ),
    "Inbound route preview",
  );
  const matches = collection(root.matches, "Inbound route preview matches", MAX_ROUTES).map(
    (value) => {
      const hit = object(value, "Inbound route preview match");
      return {
        route: decodeRoute(hit.route, tenantId),
        reason: responseText(hit.reason, "preview reason", { max: 1_024 }),
      };
    },
  );
  const evaluated = responseInteger(root.evaluated, "preview evaluation count", 0, MAX_ROUTES);
  if (matches.length > evaluated)
    throw new InboundRouteContractError(
      "The inbound-route preview returned more matches than evaluated routes.",
    );
  const stoppedAtRouteId =
    root.stopped_at_route_id === undefined || root.stopped_at_route_id === null
      ? undefined
      : responseUuid(root.stopped_at_route_id, "preview stop identity");
  if (stoppedAtRouteId && !matches.some((hit) => hit.route.id === stoppedAtRouteId))
    throw new InboundRouteContractError(
      "The inbound-route preview returned an unknown stop identity.",
    );
  const noMatches = responseBoolean(root.no_matches ?? false, "no-match flag");
  if (noMatches !== (matches.length === 0))
    throw new InboundRouteContractError(
      "The inbound-route preview returned a contradictory empty result.",
    );
  return { matches, evaluated, ...(stoppedAtRouteId ? { stoppedAtRouteId } : {}), noMatches };
}

function decodeEndpoint(
  value: unknown,
  expectedTenantId: string,
  requireSecret: boolean,
): InboundEmailEndpoint | InboundEmailEndpointReveal {
  const row = object(value, "Inbound email endpoint");
  const tenantId = responseUuid(row.tenantId, "endpoint tenant identity");
  if (tenantId !== expectedTenantId)
    throw new InboundRouteContractError(
      "The inbound endpoint service returned another workspace's endpoint.",
    );
  const slug = responseText(row.slug, "endpoint slug", { max: 16 }).toLowerCase();
  if (!ENDPOINT_SLUG.test(slug))
    throw new InboundRouteContractError(
      "The inbound endpoint service returned an invalid endpoint slug.",
    );
  const endpoint: InboundEmailEndpoint = {
    id: responseUuid(row.id, "endpoint identity"),
    tenantId,
    slug,
    secretConfigured: responseBoolean(
      row.secretConfigured,
      "endpoint secret configuration flag",
    ),
    rotationRequired: responseBoolean(
      row.rotationRequired,
      "endpoint rotation flag",
    ),
    ...(row.secretRotatedAt !== undefined && row.secretRotatedAt !== null
      ? {
          secretRotatedAt: responseTimestamp(
            row.secretRotatedAt,
            "endpoint rotation time",
          ),
        }
      : {}),
    createdAt: responseTimestamp(row.createdAt, "endpoint creation time"),
  };
  if (!requireSecret) {
    if (row.secret !== undefined && row.secret !== null && row.secret !== "")
      throw new InboundRouteContractError(
        "The metadata endpoint unexpectedly exposed signing material.",
      );
    return endpoint;
  }
  const secret = responseText(row.secret, "one-time endpoint secret", { max: 52 });
  if (!ENDPOINT_SECRET.test(secret))
    throw new InboundRouteContractError(
      "The endpoint rotation receipt did not contain a valid one-time secret.",
    );
  if (!endpoint.secretConfigured || endpoint.rotationRequired)
    throw new InboundRouteContractError(
      "The endpoint rotation receipt contradicted its secret state.",
    );
  return { ...endpoint, secret };
}

export async function getInboundEmailEndpointStrict(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<InboundEmailEndpoint | null> {
  const tenantId = assertTenantId(input.tenantId);
  try {
    return decodeEndpoint(
      await api.get<unknown>("/api/v1/inbound-emails/endpoint", {
        requireOnline: true,
        maxAttempts: 1,
        signal: input.signal,
      }),
      tenantId,
      false,
    ) as InboundEmailEndpoint;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function rotateInboundEmailEndpointStrict(input: {
  tenantId: string;
  idempotencyKey: string;
}): Promise<InboundEmailEndpointReveal> {
  const tenantId = assertTenantId(input.tenantId);
  assertOperationKey(input.idempotencyKey);
  return decodeEndpoint(
    await api.post<unknown>(
      "/api/v1/inbound-emails/endpoint/rotate",
      undefined,
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
      },
    ),
    tenantId,
    true,
  ) as InboundEmailEndpointReveal;
}

export function endpointMetadata(
  reveal: InboundEmailEndpointReveal,
): InboundEmailEndpoint {
  const { secret: _secret, ...metadata } = reveal;
  void _secret;
  return metadata;
}

export function inboundEndpointUrl(slug: string): string {
  if (!ENDPOINT_SLUG.test(slug))
    throw new InboundRouteInputError("The endpoint slug is invalid.");
  const configured = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";
  if (configured) return `${configured}/api/public/inbound-email/${slug}`;
  if (typeof window !== "undefined")
    return new URL(`/api/public/inbound-email/${slug}`, window.location.origin).href;
  return `/api/public/inbound-email/${slug}`;
}

export function newInboundRouteOperationKey(prefix: string): string {
  const clean = prefix.trim().replace(/[^a-z0-9-]/gi, "-").slice(0, 48);
  const id = globalThis.crypto?.randomUUID?.();
  if (!clean || !id || !UUID.test(id))
    throw new InboundRouteInputError(
      "A secure operation identity could not be generated.",
    );
  const key = `${clean}-${id}`;
  assertOperationKey(key);
  return key;
}

export function duplicateInboundRouteDraft(route: InboundRoute): InboundRouteDraft {
  const suffix = " (copy)";
  const sourceName = route.name || "Untitled route";
  return {
    name: `${truncateUtf8(sourceName, 120 - bytes(suffix))}${suffix}`,
    priority: Math.min(10_000, route.priority + 1),
    stopOnMatch: route.stopOnMatch,
    enabled: false,
    matchRecipient: route.matchRecipient,
    matchSubjectPrefix: route.matchSubjectPrefix,
    matchFromDomain: route.matchFromDomain,
    actions: route.actions.map((action) => ({
      kind: action.kind,
      ...(action.tag ? { tag: action.tag } : {}),
      ...(action.eventType ? { eventType: action.eventType } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.to ? { to: action.to } : {}),
      ...(Object.keys(action.extra).length ? { extra: action.extra } : {}),
      // Deliberately no preserveHmacFromIndex: duplicates are disabled and
      // never carry a server-stored signing secret into another route.
    })),
    actionRetryMax: route.actionRetryMax,
    actionRetryBackoffSeconds: route.actionRetryBackoffSeconds,
  };
}

/**
 * A full-definition draft that only flips `enabled`.
 *
 * The mounted PATCH is not a true partial update: `priority` is a plain
 * integer that resets to 0 when omitted, the subject and sender matchers are
 * written unconditionally, and the configuration-revision lock is only
 * checked when actions travel with the request. A row-level switch therefore
 * re-sends the reviewed definition verbatim and preserves stored webhook
 * signing material by revision-locked index, never by value.
 */
export function inboundRouteEnabledDraft(
  route: InboundRoute,
  enabled: boolean,
): InboundRouteDraft {
  return {
    name: route.name,
    priority: route.priority,
    stopOnMatch: route.stopOnMatch,
    enabled,
    matchRecipient: route.matchRecipient,
    matchSubjectPrefix: route.matchSubjectPrefix,
    matchFromDomain: route.matchFromDomain,
    actions: route.actions.map((action) => ({
      kind: action.kind,
      ...(action.tag ? { tag: action.tag } : {}),
      ...(action.eventType ? { eventType: action.eventType } : {}),
      ...(action.url ? { url: action.url } : {}),
      ...(action.to ? { to: action.to } : {}),
      ...(Object.keys(action.extra).length ? { extra: action.extra } : {}),
      ...(action.hasStoredHmacSecret
        ? { preserveHmacFromIndex: action.sourceIndex }
        : {}),
    })),
    actionRetryMax: route.actionRetryMax,
    actionRetryBackoffSeconds: route.actionRetryBackoffSeconds,
  };
}

/**
 * POST /api/v1/inbound-routes/reorder with the COMPLETE ordered catalogue.
 *
 * Order is evaluation order (the first enabled match can stop the chain), so
 * the server assigns dense priorities to exactly the ids it receives and
 * refuses blank or duplicated lists rather than leaving the chain
 * half-reordered. A partial list would silently demote the routes left out.
 */
export async function reorderInboundRoutesStrict(input: {
  routeIds: string[];
  idempotencyKey: string;
}): Promise<void> {
  assertOperationKey(input.idempotencyKey);
  if (
    !Array.isArray(input.routeIds) ||
    input.routeIds.length === 0 ||
    input.routeIds.length > MAX_ROUTES
  )
    throw new InboundRouteInputError(
      `A reorder must carry the complete catalogue of 1–${MAX_ROUTES} routes.`,
    );
  const routeIds = input.routeIds.map(assertRouteId);
  if (new Set(routeIds).size !== routeIds.length)
    throw new InboundRouteInputError(
      "A reorder cannot repeat a route identity.",
    );
  const receipt = object(
    await api.post<unknown>(
      "/api/v1/inbound-routes/reorder",
      { route_ids: routeIds },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: input.idempotencyKey,
      },
    ),
    "Inbound route reorder receipt",
  );
  if (
    receipt.ok !== true ||
    responseInteger(receipt.count, "reordered route count", 0, MAX_ROUTES) !==
      routeIds.length
  )
    throw new InboundRouteContractError(
      "The inbound-route service did not acknowledge the complete reorder.",
    );
}

export interface InboundRouteMatch {
  id: number;
  routeId: string;
  inboundEmailId?: number;
  recipient: string;
  subject: string;
  fromEmail: string;
  matchedAt: string;
}

export const INBOUND_ROUTE_MATCH_HISTORY_LIMIT = 50;
const MAX_MATCH_HISTORY = 500;

function decodeMatch(value: unknown, routeId: string): InboundRouteMatch {
  const row = object(value, "Inbound route match");
  if (responseUuid(row.route_id, "match route identity") !== routeId)
    throw new InboundRouteContractError(
      "The inbound-route service returned another route's match history.",
    );
  return {
    id: responseInteger(row.id, "match identity", 1),
    routeId,
    ...(row.inbound_email_id !== undefined && row.inbound_email_id !== null
      ? {
          inboundEmailId: responseInteger(
            row.inbound_email_id,
            "matched email identity",
            1,
          ),
        }
      : {}),
    recipient: responseText(row.recipient, "match recipient", {
      empty: true,
      max: 320,
    }),
    subject: responseText(row.subject, "match subject", { empty: true }),
    fromEmail: responseText(row.from_email, "match sender", {
      empty: true,
      max: 320,
    }),
    matchedAt: responseTimestamp(row.matched_at, "match time"),
  };
}

/**
 * GET /api/v1/inbound-routes/{id}/matches — the route's recorded matches,
 * newest first, capped by `limit`. An empty list is an ordinary state for a
 * rule that has not fired yet, not an error.
 */
export async function listInboundRouteMatchesStrict(input: {
  routeId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<InboundRouteMatch[]> {
  const routeId = assertRouteId(input.routeId);
  const limit = input.limit ?? INBOUND_ROUTE_MATCH_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MATCH_HISTORY)
    throw new InboundRouteInputError(
      `Match history can show 1–${MAX_MATCH_HISTORY} rows.`,
    );
  const root = object(
    await api.get<unknown>(
      `/api/v1/inbound-routes/${encodeURIComponent(routeId)}/matches`,
      {
        query: { limit },
        requireOnline: true,
        maxAttempts: 1,
        signal: input.signal,
      },
    ),
    "Inbound route match history",
  );
  const matches = collection(
    root.matches,
    "Inbound route match history",
    limit,
  ).map((value) => decodeMatch(value, routeId));
  if (
    responseInteger(root.count, "match history count", 0, MAX_MATCH_HISTORY) !==
    matches.length
  )
    throw new InboundRouteContractError(
      "The inbound-route service returned a contradictory match count.",
    );
  if (new Set(matches.map((match) => match.id)).size !== matches.length)
    throw new InboundRouteContractError(
      "The inbound-route service returned duplicate match identities.",
    );
  return matches;
}
