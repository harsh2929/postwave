// SPDX-License-Identifier: AGPL-3.0-only
//
// API playground — the catalog half. Normalizes the server's own OpenAPI 3.1
// document (GET /api/v1/openapi.json) into bounded, display-safe operations
// and decides, per operation, whether the web runner may execute it.
//
// Desktop reference: apps/desktop/src/pages/api-playground-openapi.ts and
// api-playground-policy.ts. Two deliberate differences:
//
//   - The web runner has exactly ONE credential — the dashboard session
//     cookie on the same origin — where desktop can also hold a bearer API
//     key. So there is no API-key entry, and an operation whose contract
//     demands an API key (`x-required-auth-method: api_key`), a non-session
//     scheme (portal cookie, signed HMAC, site key), or no authentication at
//     all (public capability and callback routes) is reference-only here.
//
//   - The fingerprints below are computed over this normalizer's output, not
//     copied from desktop, because the two normalizers shape the contract
//     differently. The mechanism is the same.
//
// What stays identical: live execution is desktop's allowlist of thirteen
// reviewed operations, each pinned to a fingerprint of its exact contract;
// everything else — including release-held, deprecated, streaming, binary and
// structured-parameter operations — is reference-only, and the reason (the
// hold, by name) is shown. Every non-GET is reviewed as the exact request
// before it leaves; DELETE also needs the route typed back.

import type { AuthRole } from "@/lib/auth-api";

export const PLAYGROUND_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;
export type PlaygroundMethod = (typeof PLAYGROUND_METHODS)[number];
export type PlaygroundParameterLocation = "path" | "query" | "header" | "cookie";

const MAX_PATHS = 4_096;
const MAX_OPERATIONS = 4_096;
const MAX_PARAMETERS = 128;
const MAX_TAGS = 16;
const MAX_TEXT = 16_384;
const MAX_SHORT_TEXT = 512;
const MAX_ENUM_VALUES = 256;
const DISPLAY_SCHEMA_MAX_DEPTH = 8;
const DISPLAY_SCHEMA_MAX_NODES = 2_048;

export interface PlaygroundParameter {
  name: string;
  location: PlaygroundParameterLocation;
  required: boolean;
  description?: string;
  schema?: Record<string, unknown>;
  example?: unknown;
  style?: string;
  explode?: boolean;
}

export interface PlaygroundRequestBody {
  required: boolean;
  description?: string;
  mediaTypes: string[];
  /** The JSON media type the runner sends, when one is declared. */
  jsonMediaType?: string;
  schema?: unknown;
  example?: unknown;
  exampleSource?: "explicit" | "schema";
}

export interface PlaygroundResponses {
  statuses: string[];
  mediaTypes: string[];
  mediaTypesByStatus: Record<string, string[]>;
}

export interface PlaygroundOperation {
  /** `METHOD /path/{template}` — the identity used by favorites and history. */
  key: string;
  method: PlaygroundMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  primaryTag: string;
  deprecated: boolean;
  parameters: PlaygroundParameter[];
  requestBody?: PlaygroundRequestBody;
  responses: PlaygroundResponses;
  /** Alternatives; the schemes inside one alternative are all required. */
  security: string[][];
  explicitlyPublic: boolean;
  requiredRole?: string;
  requiredScopes: string[];
  requiredScopeMode?: string;
  requiredAuthMethod?: string;
  releaseHold?: string;
  maxBodyBytes?: number;
  contractIssues: string[];
  /** Lower-cased haystack for the reference filter. */
  searchText: string;
}

export interface PlaygroundCatalog {
  title: string;
  version: string;
  operations: PlaygroundOperation[];
}

export class PlaygroundCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundCatalogError";
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .slice(0, maxItems)
    .map((item) => (item.length <= 128 ? item : `${item.slice(0, 127)}…`));
}

function resolveLocalRef(
  spec: UnknownRecord,
  value: unknown,
  seen: Set<string> = new Set(),
): UnknownRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = typeof record.$ref === "string" ? record.$ref : undefined;
  if (!ref) return record;
  if (!ref.startsWith("#/") || seen.has(ref) || seen.size >= 16) return null;
  seen.add(ref);
  let cursor: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const parent = asRecord(cursor);
    if (!parent || !Object.prototype.hasOwnProperty.call(parent, segment)) {
      return null;
    }
    cursor = parent[segment];
  }
  const resolved = resolveLocalRef(spec, cursor, seen);
  if (!resolved) return null;
  const siblings = { ...record };
  delete siblings.$ref;
  return { ...resolved, ...siblings };
}

/**
 * Inline local refs for display, bounded in depth and node count. A cycle or
 * an exhausted budget keeps the `$ref` pointer instead of expanding it, so a
 * recursive schema renders finitely rather than hanging the tab.
 */
function displaySchema(
  spec: UnknownRecord,
  value: unknown,
  budget: { nodes: number },
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  budget.nodes += 1;
  if (budget.nodes > DISPLAY_SCHEMA_MAX_NODES) return "…";
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map((item) => displaySchema(spec, item, budget, depth + 1, seen));
  }
  const record = asRecord(value);
  if (!record) return value;
  const ref = typeof record.$ref === "string" ? record.$ref : undefined;
  if (ref) {
    if (seen.has(ref) || depth >= DISPLAY_SCHEMA_MAX_DEPTH) return { $ref: ref };
    const resolved = resolveLocalRef(spec, record);
    if (!resolved) return { $ref: ref };
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return displaySchema(spec, resolved, budget, depth + 1, nextSeen);
  }
  if (depth >= DISPLAY_SCHEMA_MAX_DEPTH) return "…";
  const out: UnknownRecord = {};
  for (const [key, child] of Object.entries(record).slice(0, 128)) {
    out[key] = displaySchema(spec, child, budget, depth + 1, seen);
  }
  return out;
}

/** A plausible example for a schema — desktop's generator, same precedence. */
function schemaExample(
  spec: UnknownRecord,
  rawSchema: unknown,
  depth = 0,
  seenRefs: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > 8) return undefined;
  const original = asRecord(rawSchema);
  if (!original) return undefined;
  const ref = typeof original.$ref === "string" ? original.$ref : undefined;
  if (ref) {
    if (seenRefs.has(ref)) return undefined;
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    const resolved = resolveLocalRef(spec, original);
    return resolved
      ? schemaExample(spec, resolved, depth + 1, nextSeen)
      : undefined;
  }
  if ("example" in original) return original.example;
  if ("default" in original) return original.default;
  if (Array.isArray(original.enum) && original.enum.length > 0) {
    return original.enum[0];
  }
  const type = typeof original.type === "string" ? original.type : undefined;
  if (type === "object" || asRecord(original.properties)) {
    const properties = asRecord(original.properties) ?? {};
    const required = new Set(stringList(original.required, 256));
    const names = Object.keys(properties)
      .sort((a, b) => Number(required.has(b)) - Number(required.has(a)))
      .slice(0, 24);
    const result: UnknownRecord = {};
    for (const name of names) {
      if (!required.has(name) && Object.keys(result).length >= 8) continue;
      const value = schemaExample(spec, properties[name], depth + 1, seenRefs);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") {
    return typeof original.minimum === "number" ? original.minimum : 0;
  }
  if (type === "string" || !type) {
    const format = typeof original.format === "string" ? original.format : "";
    if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (format === "email") return "developer@example.com";
    if (format === "date-time") return "2026-01-01T00:00:00Z";
    if (format === "date") return "2026-01-01";
    return "";
  }
  return undefined;
}

const JSON_MEDIA = /^(application\/json|application\/[^;\s]+\+json)(?:;|$)/i;
const STREAM_MEDIA = /^(text\/event-stream|application\/x-ndjson)(?:;|$)/i;
const BINARY_MEDIA =
  /^(image\/|audio\/|video\/|application\/(octet-stream|zip|pdf|gzip|x-tar)|text\/csv)/i;

export function isJsonMediaType(value: string): boolean {
  return JSON_MEDIA.test(value.trim());
}

function normalizeParameters(
  spec: UnknownRecord,
  pathLevel: unknown,
  operationLevel: unknown,
  issues: string[],
): PlaygroundParameter[] {
  const merged = new Map<string, PlaygroundParameter>();
  for (const source of [pathLevel, operationLevel]) {
    if (source === undefined) continue;
    if (!Array.isArray(source)) {
      issues.push("parameters must be an array");
      continue;
    }
    for (const raw of source) {
      const parameter = resolveLocalRef(spec, raw);
      const name = text(parameter?.name, 256);
      const location = parameter?.in;
      if (
        !parameter ||
        !name ||
        (location !== "path" &&
          location !== "query" &&
          location !== "header" &&
          location !== "cookie")
      ) {
        issues.push("a parameter is unresolved or malformed");
        continue;
      }
      const schema = resolveLocalRef(spec, parameter.schema) ?? undefined;
      merged.set(`${location}:${name}`, {
        name,
        location,
        required: location === "path" ? true : parameter.required === true,
        description: text(parameter.description, 4_096),
        schema,
        example: parameter.example,
        style: text(parameter.style, 64),
        explode:
          typeof parameter.explode === "boolean" ? parameter.explode : undefined,
      });
    }
  }
  if (merged.size > MAX_PARAMETERS) {
    issues.push(`operation declares more than ${MAX_PARAMETERS} parameters`);
  }
  return [...merged.values()].slice(0, MAX_PARAMETERS);
}

function normalizeRequestBody(
  spec: UnknownRecord,
  raw: unknown,
  issues: string[],
): PlaygroundRequestBody | undefined {
  if (raw === undefined) return undefined;
  const body = resolveLocalRef(spec, raw);
  const content = asRecord(body?.content);
  if (!body || !content) {
    issues.push("request body is unresolved or has no content map");
    return undefined;
  }
  const mediaTypes = Object.keys(content).slice(0, 32).sort();
  const jsonMediaType = mediaTypes.includes("application/json")
    ? "application/json"
    : mediaTypes.find((item) => isJsonMediaType(item));
  const media = jsonMediaType ? asRecord(content[jsonMediaType]) : null;
  const explicit = media && "example" in media ? media.example : undefined;
  const generated =
    explicit === undefined && media
      ? schemaExample(spec, media.schema)
      : explicit;
  return {
    required: body.required === true,
    description: text(body.description, 4_096),
    mediaTypes,
    jsonMediaType,
    schema: media ? displaySchema(spec, media.schema, { nodes: 0 }) : undefined,
    example: generated,
    exampleSource:
      generated === undefined
        ? undefined
        : explicit === undefined
          ? "schema"
          : "explicit",
  };
}

function normalizeResponses(
  spec: UnknownRecord,
  raw: unknown,
  issues: string[],
): PlaygroundResponses {
  const responses = asRecord(raw);
  if (!responses) issues.push("responses must be an object");
  const mediaTypes = new Set<string>();
  const mediaTypesByStatus: Record<string, string[]> = {};
  for (const [status, value] of Object.entries(responses ?? {})
    .slice(0, 64)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^(?:default|[1-5](?:[0-9]{2}|XX))$/i.test(status)) {
      issues.push(`invalid response status ${status.slice(0, 32)}`);
      continue;
    }
    const response = resolveLocalRef(spec, value);
    if (!response) {
      issues.push(`response ${status} is unresolved`);
      continue;
    }
    const media = Object.keys(asRecord(response.content) ?? {})
      .slice(0, 32)
      .sort();
    mediaTypesByStatus[status] = media;
    for (const item of media) mediaTypes.add(item);
  }
  return {
    statuses: Object.keys(mediaTypesByStatus),
    mediaTypes: [...mediaTypes].sort(),
    mediaTypesByStatus,
  };
}

function normalizeSecurity(raw: unknown, issues: string[]): string[][] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push("security requirements must be an array");
    return [];
  }
  const out: string[][] = [];
  for (const requirement of raw.slice(0, 16)) {
    const record = asRecord(requirement);
    if (!record) {
      issues.push("a security requirement is malformed");
      continue;
    }
    out.push(Object.keys(record).slice(0, 16).sort());
  }
  return out;
}

function validatePathPlaceholders(
  path: string,
  parameters: PlaygroundParameter[],
  issues: string[],
): void {
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!);
  const declared = new Set(
    parameters.filter((p) => p.location === "path").map((p) => p.name),
  );
  for (const name of placeholders) {
    if (!declared.has(name)) {
      issues.push(`path placeholder ${name} has no declared parameter`);
    }
  }
  for (const name of declared) {
    if (!placeholders.includes(name)) {
      issues.push(`path parameter ${name} has no placeholder`);
    }
  }
}

function normalizeOperation(
  spec: UnknownRecord,
  path: string,
  pathItem: UnknownRecord,
  method: PlaygroundMethod,
  raw: UnknownRecord,
): PlaygroundOperation {
  const issues: string[] = [];
  if (
    !path.startsWith("/") ||
    /[?#\\]/.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 0x20)
  ) {
    issues.push("path is not a canonical route template");
  }
  const parameters = normalizeParameters(
    spec,
    pathItem.parameters,
    raw.parameters,
    issues,
  );
  validatePathPlaceholders(path, parameters, issues);
  const securitySource = raw.security === undefined ? spec.security : raw.security;
  const security = normalizeSecurity(securitySource, issues);
  const explicitlyPublic =
    (Array.isArray(securitySource) && securitySource.length === 0) ||
    security.some((option) => option.length === 0);
  const tags = stringList(raw.tags, MAX_TAGS);
  const operationId = text(raw.operationId, 256) ?? `${method}-${path}`;
  const maxBody = raw["x-postwave-max-body-bytes"];
  const releaseHold =
    raw["x-postwave-release-hold"] === undefined
      ? undefined
      : (text(raw["x-postwave-release-hold"], 4_096) ??
        "release hold declared without a reason");
  const operation: Omit<PlaygroundOperation, "searchText"> = {
    key: `${method.toUpperCase()} ${path}`,
    method,
    path,
    operationId,
    summary: text(raw.summary, MAX_SHORT_TEXT) ?? operationId,
    description: text(raw.description, MAX_TEXT) ?? "",
    tags: tags.length > 0 ? tags : ["Other"],
    primaryTag: tags[0] ?? "Other",
    deprecated: raw.deprecated === true,
    parameters,
    requestBody: normalizeRequestBody(spec, raw.requestBody, issues),
    responses: normalizeResponses(spec, raw.responses, issues),
    security,
    explicitlyPublic,
    requiredRole: text(raw["x-required-role"], 64),
    requiredScopes: stringList(raw["x-required-scopes"], 128),
    requiredScopeMode: text(raw["x-required-scope-mode"], 64),
    requiredAuthMethod: text(raw["x-required-auth-method"], 64),
    releaseHold,
    maxBodyBytes:
      typeof maxBody === "number" && Number.isSafeInteger(maxBody) && maxBody >= 0
        ? maxBody
        : undefined,
    contractIssues: issues,
  };
  return { ...operation, searchText: searchTextFor(operation) };
}

function searchTextFor(operation: Omit<PlaygroundOperation, "searchText">): string {
  return [
    operation.method,
    operation.path,
    operation.operationId,
    operation.summary,
    operation.primaryTag,
    ...operation.tags,
    operation.requiredRole ?? "",
    ...operation.requiredScopes,
    operation.releaseHold ?? "",
    ...operation.parameters.map((parameter) => parameter.name),
    ...operation.security.flat(),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Fails closed on anything that is not a complete OpenAPI 3.1 document: a
 * partial catalog would silently drop operations from the reference and make
 * the runner's coverage a lie.
 */
export function normalizePlaygroundCatalog(input: unknown): PlaygroundCatalog {
  const spec = asRecord(input);
  if (!spec) throw new PlaygroundCatalogError("The API contract is not an object.");
  const version = typeof spec.openapi === "string" ? spec.openapi : "";
  if (!/^3\.1\.\d+/.test(version)) {
    throw new PlaygroundCatalogError(
      "The API playground requires an explicit OpenAPI 3.1 document.",
    );
  }
  const paths = asRecord(spec.paths);
  if (!paths) throw new PlaygroundCatalogError("The API contract has no paths.");
  const entries = Object.entries(paths);
  if (entries.length > MAX_PATHS) {
    throw new PlaygroundCatalogError(
      `The API contract exceeds the ${MAX_PATHS}-path playground limit.`,
    );
  }
  const operations: PlaygroundOperation[] = [];
  for (const [path, rawItem] of entries) {
    const pathItem = resolveLocalRef(spec, rawItem);
    if (!pathItem) {
      throw new PlaygroundCatalogError(
        `The API contract is incomplete: path ${path.slice(0, 200)} is unresolved.`,
      );
    }
    for (const method of PLAYGROUND_METHODS) {
      if (pathItem[method] === undefined) continue;
      const raw = resolveLocalRef(spec, pathItem[method]);
      if (!raw) {
        throw new PlaygroundCatalogError(
          `The API contract is incomplete: ${method.toUpperCase()} ${path.slice(0, 200)} is unresolved.`,
        );
      }
      if (operations.length >= MAX_OPERATIONS) {
        throw new PlaygroundCatalogError(
          `The API contract exceeds the ${MAX_OPERATIONS}-operation playground limit.`,
        );
      }
      operations.push(normalizeOperation(spec, path, pathItem, method, raw));
    }
  }
  if (operations.length === 0) {
    throw new PlaygroundCatalogError("The API contract declares no operations.");
  }
  operations.sort((a, b) =>
    a.path === b.path
      ? PLAYGROUND_METHODS.indexOf(a.method) - PLAYGROUND_METHODS.indexOf(b.method)
      : a.path.localeCompare(b.path),
  );
  const info = asRecord(spec.info);
  return {
    title: text(info?.title, MAX_SHORT_TEXT) ?? "Moosewave API",
    version: text(info?.version, 128) ?? "unknown",
    operations,
  };
}

// ---------------------------------------------------------------------------
// Execution policy
// ---------------------------------------------------------------------------

export type PlaygroundEffect = "read" | "effectful" | "destructive";
export type PlaygroundRole = "viewer" | "editor" | "admin";
export type PlaygroundResponseKind =
  | "json"
  | "undeclared"
  | "stream"
  | "binary"
  | "unsupported";

export interface PlaygroundPolicy {
  executable: boolean;
  /** Why the runner will not execute this operation (reference-only). */
  reason?: string;
  effect: PlaygroundEffect;
  requiredRole: PlaygroundRole;
  idempotency: "none" | "optional" | "required";
  responseKind: PlaygroundResponseKind;
  /** Declared headers the runner lets the operator set. */
  editableHeaders: PlaygroundParameter[];
}

/**
 * Headers an operator may set. Everything else — Authorization, Cookie,
 * tenant and Moosewave identity headers, signatures, Origin — stays owned by
 * the browser and the proxy. Idempotency-Key is minted per attempt by the
 * runner rather than typed.
 */
const EDITABLE_HEADERS = new Set(["accept", "if-match", "if-none-match"]);

const ROLE_RANK: Record<PlaygroundRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

interface ReviewedExecutionContract {
  effect: PlaygroundEffect;
  fingerprint: string;
}

// Live execution is deliberately tied to the exact normalized safety contract.
// An intentional OpenAPI change must be independently reviewed before updating
// one of these fingerprints; matching only a familiar method/path is not enough.
//
// The keys and effect classes are desktop's (apps/desktop/src/pages/
// api-playground-policy.ts REVIEWED_EXECUTION). The fingerprints are the
// web's own: desktop's mechanism (canonical JSON + FNV-1a-64) over THIS
// normalizer's reviewed-contract shape, computed from the repo contract
// (apps/api/internal/apidocs/openapi.json). A contract change to any of these
// operations makes it reference-only here until someone re-reviews it.
//
// GET /api/v1/api-keys/me is pinned but stays reference-only on web: its
// contract declares `x-required-auth-method: api_key`, and the web runner only
// ever holds the dashboard session, so the structural check refuses it first.
const REVIEWED_EXECUTION = new Map<string, ReviewedExecutionContract>([
  [
    "GET /api/v1/accounts",
    { effect: "read", fingerprint: "517:24e56a1b8d5f5172" },
  ],
  [
    "GET /api/v1/api-keys/me",
    { effect: "read", fingerprint: "577:4f66452d22d2789a" },
  ],
  [
    "GET /api/v1/campaigns",
    { effect: "read", fingerprint: "946:9a757f14d69bca3a" },
  ],
  [
    "GET /api/v1/campaigns/{id}",
    { effect: "read", fingerprint: "775:f99e9e43a5371d1f" },
  ],
  [
    "GET /api/v1/segments",
    { effect: "read", fingerprint: "695:153d4f0dc32567c0" },
  ],
  [
    "GET /api/v1/segments/{id}",
    { effect: "read", fingerprint: "707:58b6bc3877559a94" },
  ],
  [
    "GET /api/v1/subscribers",
    { effect: "read", fingerprint: "3048:948801ca64dc8f08" },
  ],
  [
    "GET /api/v1/subscribers/{id}",
    { effect: "read", fingerprint: "731:81b804b20b51c053" },
  ],
  [
    "GET /api/v1/tags",
    { effect: "read", fingerprint: "1183:4d13fb54a1ed39bc" },
  ],
  [
    "GET /api/v1/tags/{id}/history",
    { effect: "read", fingerprint: "1194:020cabe116d47e56" },
  ],
  [
    "POST /api/v1/tags",
    { effect: "effectful", fingerprint: "1667:a680b250d2879c44" },
  ],
  [
    "PATCH /api/v1/tags/{id}",
    { effect: "effectful", fingerprint: "2172:093799a1ade3de48" },
  ],
  [
    "DELETE /api/v1/tags/{id}",
    { effect: "destructive", fingerprint: "984:475bc15132de4510" },
  ],
]);

export const NOT_REVIEWED_REASON =
  "Not reviewed for live execution — reference only. Web runs only the operations desktop has reviewed.";
export const REVIEWED_CONTRACT_CHANGED_REASON =
  "Reviewed runner contract changed; independent re-review is required before it runs again.";

export function reviewedExecutionKeys(): readonly string[] {
  return [...REVIEWED_EXECUTION.keys()].sort();
}

function canonicalContractValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return '"<undefined>"';
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : '"<non-finite>"';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalContractValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalContractValue(record[key])}`)
      .join(",")}}`;
  }
  return `"<${typeof value}>"`;
}

/** Everything about an operation that bears on whether running it is safe. */
function reviewedContractShape(operation: PlaygroundOperation): Record<string, unknown> {
  return {
    method: operation.method,
    path: operation.path,
    operationId: operation.operationId,
    deprecated: operation.deprecated,
    parameters: operation.parameters,
    requestBody: operation.requestBody,
    responses: operation.responses,
    security: operation.security,
    explicitlyPublic: operation.explicitlyPublic,
    requiredRole: operation.requiredRole,
    requiredScopes: operation.requiredScopes,
    requiredScopeMode: operation.requiredScopeMode,
    requiredAuthMethod: operation.requiredAuthMethod,
    releaseHold: operation.releaseHold,
    maxBodyBytes: operation.maxBodyBytes,
    contractIssues: operation.contractIssues,
  };
}

/** `${byteLength}:${fnv1a64 hex}` of the canonical reviewed-contract shape. */
export function reviewedContractFingerprint(operation: PlaygroundOperation): string {
  const bytes = new TextEncoder().encode(
    canonicalContractValue(reviewedContractShape(operation)),
  );
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${bytes.byteLength}:${hash.toString(16).padStart(16, "0")}`;
}

function requiredRoleFor(operation: PlaygroundOperation): PlaygroundRole {
  const explicit = operation.requiredRole?.toLowerCase();
  if (explicit === "admin" || explicit === "owner") return "admin";
  if (explicit === "editor" || explicit === "member") return "editor";
  if (explicit === "viewer") return "viewer";
  if (operation.requiredScopes.some((scope) => scope === "admin")) return "admin";
  if (operation.requiredScopes.some((scope) => scope.startsWith("write:"))) {
    return "editor";
  }
  // Desktop falls back to viewer. A write with no declared requirement is
  // held to editor here so a viewer is told up front instead of meeting a 403.
  return operation.method === "get" ? "viewer" : "editor";
}

function responseKindFor(operation: PlaygroundOperation): PlaygroundResponseKind {
  const media = operation.responses.mediaTypes;
  if (media.some((item) => STREAM_MEDIA.test(item))) return "stream";
  if (media.some((item) => BINARY_MEDIA.test(item))) return "binary";
  if (media.length === 0) return "undeclared";
  return media.every((item) => isJsonMediaType(item)) ? "json" : "unsupported";
}

/** Session-cookie reachable: some alternative is exactly bearer or session. */
function sessionReachable(operation: PlaygroundOperation): boolean {
  return operation.security.some(
    (option) =>
      option.length === 1 &&
      (option[0] === "bearerAuth" || option[0] === "sessionCookie"),
  );
}

function referenceOnlyReason(
  operation: PlaygroundOperation,
  editableHeaders: PlaygroundParameter[],
  responseKind: PlaygroundResponseKind,
): string | undefined {
  // The hold outranks every other reason: it is the one the server itself
  // enforces (a 503 until released), so it is the one the operator must see.
  if (operation.releaseHold) return `Release hold: ${operation.releaseHold}`;
  if (!operation.path.startsWith("/api/v1/")) {
    return "Only /api/v1 operations run in the web playground; this route is reference-only.";
  }
  if (operation.contractIssues.length > 0) {
    return `Catalog contract issue: ${operation.contractIssues[0]}`;
  }
  if (operation.deprecated) return "Deprecated operations are reference-only.";
  if (operation.explicitlyPublic) {
    return "Public capability and callback routes are reference-only.";
  }
  if (!sessionReachable(operation)) {
    return `This route authenticates with ${operation.security.flat().join(", ") || "an undeclared scheme"}, which the web runner's session cannot represent.`;
  }
  if (operation.requiredAuthMethod?.toLowerCase() === "api_key") {
    return "This route accepts only an API key; the web runner sends your dashboard session and never holds a key.";
  }
  if (operation.requestBody && !operation.requestBody.jsonMediaType) {
    return `Unsupported request media: ${operation.requestBody.mediaTypes.join(", ") || "none declared"}.`;
  }
  for (const parameter of operation.parameters) {
    const type = parameter.schema?.type;
    if (type === "array" || type === "object") {
      return `${parameter.location} parameter ${parameter.name} needs structured serialization the runner does not approximate.`;
    }
    if (parameter.location === "query" && parameter.style && parameter.style !== "form") {
      return `query parameter ${parameter.name} uses unsupported ${parameter.style} serialization.`;
    }
    if (parameter.location === "path" && parameter.style && parameter.style !== "simple") {
      return `path parameter ${parameter.name} uses unsupported ${parameter.style} serialization.`;
    }
    if (parameter.location === "cookie" && parameter.required) {
      return `Requires the ${parameter.name} cookie, which the web runner cannot set.`;
    }
    if (
      parameter.location === "header" &&
      parameter.required &&
      parameter.name.toLowerCase() !== "idempotency-key" &&
      !editableHeaders.includes(parameter)
    ) {
      return `Requires the ${parameter.name} header, which the web runner does not let you set.`;
    }
  }
  if (responseKind === "stream") return "Streaming responses need a dedicated client.";
  if (responseKind === "binary") return "Downloads and binary responses are reference-only.";
  if (responseKind === "unsupported") {
    return `Unsupported response media: ${operation.responses.mediaTypes.join(", ")}.`;
  }
  const reviewed = REVIEWED_EXECUTION.get(operation.key);
  if (!reviewed) return NOT_REVIEWED_REASON;
  if (reviewed.fingerprint !== reviewedContractFingerprint(operation)) {
    return REVIEWED_CONTRACT_CHANGED_REASON;
  }
  return undefined;
}

const policyCache = new WeakMap<PlaygroundOperation, PlaygroundPolicy>();

export function playgroundPolicyFor(operation: PlaygroundOperation): PlaygroundPolicy {
  const cached = policyCache.get(operation);
  if (cached) return cached;
  const editableHeaders = operation.parameters.filter(
    (parameter) =>
      parameter.location === "header" &&
      EDITABLE_HEADERS.has(parameter.name.toLowerCase()),
  );
  const idempotencyParameter = operation.parameters.find(
    (parameter) =>
      parameter.location === "header" &&
      parameter.name.toLowerCase() === "idempotency-key",
  );
  const responseKind = responseKindFor(operation);
  const reason = referenceOnlyReason(operation, editableHeaders, responseKind);
  const reviewed = REVIEWED_EXECUTION.get(operation.key);
  const policy: PlaygroundPolicy = Object.freeze({
    executable: reason === undefined && reviewed !== undefined,
    reason,
    // Desktop's default: anything unreviewed is treated as destructive.
    effect: reviewed?.effect ?? "destructive",
    requiredRole: requiredRoleFor(operation),
    idempotency: idempotencyParameter
      ? idempotencyParameter.required
        ? "required"
        : "optional"
      : "none",
    responseKind,
    editableHeaders,
  });
  policyCache.set(operation, policy);
  return policy;
}

/** Web roles onto the playground's three-step authority ladder. */
export function playgroundRoleAllows(
  role: AuthRole | null | undefined,
  required: PlaygroundRole,
): boolean {
  if (!role) return false;
  const actual: PlaygroundRole =
    role === "owner" || role === "admin"
      ? "admin"
      : role === "editor"
        ? "editor"
        : "viewer";
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function playgroundEnumValues(parameter: PlaygroundParameter): string[] {
  const values = parameter.schema?.enum;
  if (!Array.isArray(values) || values.length > MAX_ENUM_VALUES) return [];
  return values
    .filter(
      (item): item is string | number | boolean =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
    .map(String);
}
