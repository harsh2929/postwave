export const PLAYGROUND_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;
export const PLAYGROUND_OPERATION_MAX_PARAMETERS = 128;
export const PLAYGROUND_PARAMETER_ENUM_MAX_VALUES = 256;
export const PLAYGROUND_PARAMETER_ENUM_MAX_VALUE_BYTES = 1_024;

const PLAYGROUND_CATALOG_MAX_PATHS = 4_096;
const PLAYGROUND_CATALOG_MAX_OPERATIONS = 4_096;
const PLAYGROUND_CATALOG_MAX_DISTINCT_TAGS = 512;
export const PLAYGROUND_CATALOG_SCHEMA_MAX_NODES = 131_072;
const PLAYGROUND_OPERATION_MAX_TAGS = 16;
const PLAYGROUND_OPERATION_MAX_RESPONSES = 64;
const PLAYGROUND_OPERATION_MAX_MEDIA_TYPES = 32;
const PLAYGROUND_OPERATION_MAX_SECURITY_REQUIREMENTS = 16;
const PLAYGROUND_SECURITY_MAX_SCHEMES = 16;
const PLAYGROUND_OPERATION_MAX_SCOPES = 128;
const PLAYGROUND_PATH_MAX_LENGTH = 512;
const PLAYGROUND_OPERATION_ID_MAX_LENGTH = 256;
const PLAYGROUND_SUMMARY_MAX_LENGTH = 512;
const PLAYGROUND_DESCRIPTION_MAX_LENGTH = 16_384;
const PLAYGROUND_TAG_MAX_LENGTH = 128;
const PLAYGROUND_PARAMETER_NAME_MAX_LENGTH = 256;
const PLAYGROUND_PARAMETER_STYLE_MAX_LENGTH = 128;
const PLAYGROUND_PARAMETER_DESCRIPTION_MAX_LENGTH = 4_096;
const PLAYGROUND_MEDIA_TYPE_MAX_LENGTH = 255;
const PLAYGROUND_STATUS_MAX_LENGTH = 64;

export type PlaygroundMethod = (typeof PLAYGROUND_METHODS)[number];
export type PlaygroundParameterLocation = "path" | "query" | "header";

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
  selectedMediaType?: string;
  schema?: unknown;
  example?: unknown;
  exampleSource?: "explicit" | "schema";
}

export interface PlaygroundResponseContract {
  statuses: string[];
  mediaTypes: string[];
  mediaTypesByStatus: Record<string, string[]>;
  private: boolean;
}

export interface PlaygroundSecurityRequirement {
  schemes: string[];
}

export interface NormalizedPlaygroundOperation {
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
  responses: PlaygroundResponseContract;
  security: PlaygroundSecurityRequirement[];
  explicitlyPublic: boolean;
  requiredRole?: string;
  requiredScopes: string[];
  requiredScopeMode?: string;
  releaseHold?: string;
  maxBodyBytes?: number;
  bodyless: boolean;
  contractIssues: string[];
}

export interface NormalizedPlaygroundCatalog {
  title: string;
  version: string;
  operations: NormalizedPlaygroundOperation[];
  warnings: string[];
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function boundedText(
  value: unknown,
  maximum: number,
  label: string,
  issues: string[],
): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  if (text.length <= maximum) return text;
  issues.push(`${label} exceeds the ${maximum}-character display limit`);
  return `${text.slice(0, maximum - 1)}…`;
}

function boundedOptionalMetadata(
  value: unknown,
  maximum: number,
  label: string,
  issues: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const text = stringValue(value);
  if (!text) {
    issues.push(`${label} must be a non-empty string`);
    return undefined;
  }
  return boundedText(text, maximum, label, issues);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(
  spec: UnknownRecord,
  value: unknown,
  seen: Set<string> = new Set(),
): UnknownRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = stringValue(record.$ref);
  if (!ref) return record;
  if (!ref.startsWith("#/")) return null;
  if (seen.has(ref) || seen.size >= 16) return null;
  seen.add(ref);
  let cursor: unknown = spec;
  const segments = ref.slice(2).split("/").map(decodePointerSegment);
  if (segments.length > 64) return null;
  for (const segment of segments) {
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

const REQUEST_SCHEMA_RESOLUTION_MAX_DEPTH = 16;
const REQUEST_SCHEMA_RESOLUTION_MAX_NODES = 2_048;
const REQUEST_SCHEMA_RESOLUTION_MAX_PROPERTIES = 512;
const REQUEST_SCHEMA_RESOLUTION_MAX_BRANCHES = 16;

interface RequestSchemaResolutionContext {
  nodes: number;
  exceeded: boolean;
  problem?: string;
  catalog: CatalogSchemaResolutionContext;
}

interface CatalogSchemaResolutionContext {
  nodes: number;
  refs: Map<string, unknown>;
}

function localRefTarget(
  spec: UnknownRecord,
  ref: string,
): { found: boolean; value?: unknown } {
  if (!ref.startsWith("#/")) return { found: false };
  const segments = ref.slice(2).split("/").map(decodePointerSegment);
  if (segments.length > 64) return { found: false };
  let cursor: unknown = spec;
  for (const segment of segments) {
    const parent = asRecord(cursor);
    if (!parent || !Object.prototype.hasOwnProperty.call(parent, segment)) {
      return { found: false };
    }
    cursor = parent[segment];
  }
  return { found: true, value: cursor };
}

function unresolvedRequestSchema(ref: string): UnknownRecord {
  return { $ref: ref };
}

function failRequestSchemaResolution(
  context: RequestSchemaResolutionContext,
  ref: string,
  problem: string,
): UnknownRecord {
  context.problem ??= problem;
  return unresolvedRequestSchema(ref);
}

function resolveRequestSchemaRecord(
  spec: UnknownRecord,
  record: UnknownRecord,
  context: RequestSchemaResolutionContext,
  depth: number,
  activeRefs: ReadonlySet<string>,
): UnknownRecord {
  const resolved: UnknownRecord = { ...record };
  const properties = asRecord(record.properties);
  if (properties) {
    const entries = Object.entries(properties);
    if (entries.length > REQUEST_SCHEMA_RESOLUTION_MAX_PROPERTIES) {
      context.exceeded = true;
      failRequestSchemaResolution(
        context,
        "#workbench-schema-property-budget",
        "request schema exceeds the safe property-map budget",
      );
    } else {
      const resolvedProperties: UnknownRecord = {};
      for (const [name, schema] of entries) {
        resolvedProperties[name] = resolveRequestSchemaNode(
          spec,
          schema,
          context,
          depth + 1,
          activeRefs,
        );
        if (context.exceeded) break;
      }
      resolved.properties = resolvedProperties;
    }
  }
  for (const key of ["items", "additionalProperties"] as const) {
    if (record[key] !== undefined) {
      resolved[key] = resolveRequestSchemaNode(
        spec,
        record[key],
        context,
        depth + 1,
        activeRefs,
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = record[key];
    if (!Array.isArray(branches)) continue;
    if (branches.length > REQUEST_SCHEMA_RESOLUTION_MAX_BRANCHES) {
      context.exceeded = true;
      failRequestSchemaResolution(
        context,
        "#workbench-schema-branch-budget",
        "request schema exceeds the safe alternative-branch budget",
      );
      continue;
    }
    resolved[key] = branches.map((branch) =>
      resolveRequestSchemaNode(spec, branch, context, depth + 1, activeRefs),
    );
  }
  return resolved;
}

function resolveRequestSchemaNode(
  spec: UnknownRecord,
  raw: unknown,
  context: RequestSchemaResolutionContext,
  depth: number,
  activeRefs: ReadonlySet<string>,
): unknown {
  context.nodes += 1;
  context.catalog.nodes += 1;
  if (context.catalog.nodes > PLAYGROUND_CATALOG_SCHEMA_MAX_NODES) {
    throw new PlaygroundCatalogError(
      `OpenAPI document exceeds the ${PLAYGROUND_CATALOG_SCHEMA_MAX_NODES.toLocaleString("en-US")}-node aggregate request-schema limit`,
    );
  }
  if (
    depth > REQUEST_SCHEMA_RESOLUTION_MAX_DEPTH ||
    context.nodes > REQUEST_SCHEMA_RESOLUTION_MAX_NODES
  ) {
    context.exceeded = true;
    return failRequestSchemaResolution(
      context,
      "#workbench-schema-resolution-budget",
      "request schema exceeds the safe reference-resolution budget",
    );
  }
  if (raw === true || raw === false) return raw;
  const record = asRecord(raw);
  if (!record) {
    context.problem ??= "request schema contains a malformed schema node";
    return raw;
  }
  if (!("$ref" in record)) {
    return resolveRequestSchemaRecord(spec, record, context, depth, activeRefs);
  }
  const ref = stringValue(record.$ref);
  if (!ref) {
    return failRequestSchemaResolution(
      context,
      "#workbench-invalid-schema-ref",
      "request schema contains an invalid reference",
    );
  }
  if (activeRefs.has(ref)) {
    return failRequestSchemaResolution(
      context,
      ref,
      `request schema contains a cyclic reference ${ref}`,
    );
  }
  if (context.catalog.refs.has(ref)) {
    const cached = context.catalog.refs.get(ref);
    const siblings = { ...record };
    delete siblings.$ref;
    if (Object.keys(siblings).length === 0) return cached;
    return {
      allOf: [
        cached,
        resolveRequestSchemaRecord(
          spec,
          siblings,
          context,
          depth + 1,
          activeRefs,
        ),
      ],
    };
  }
  const target = localRefTarget(spec, ref);
  if (!target.found) {
    return failRequestSchemaResolution(
      context,
      ref,
      `request schema contains an unresolved reference ${ref}`,
    );
  }
  const targetRecord = asRecord(target.value);
  if (!targetRecord && target.value !== true && target.value !== false) {
    return failRequestSchemaResolution(
      context,
      ref,
      `request schema reference ${ref} does not resolve to a schema`,
    );
  }
  const nextRefs = new Set(activeRefs);
  nextRefs.add(ref);
  const resolvedTarget = resolveRequestSchemaNode(
    spec,
    target.value,
    context,
    depth + 1,
    nextRefs,
  );
  if (!context.problem && !context.exceeded) {
    context.catalog.refs.set(ref, resolvedTarget);
  }
  const siblings = { ...record };
  delete siblings.$ref;
  if (Object.keys(siblings).length === 0) return resolvedTarget;
  return {
    allOf: [
      resolvedTarget,
      resolveRequestSchemaRecord(
        spec,
        siblings,
        context,
        depth + 1,
        activeRefs,
      ),
    ],
  };
}

function resolveRequestSchema(
  spec: UnknownRecord,
  raw: unknown,
  catalog: CatalogSchemaResolutionContext,
  onProblem?: (problem: string) => void,
): unknown {
  if (raw === undefined) return undefined;
  const context: RequestSchemaResolutionContext = {
    nodes: 0,
    exceeded: false,
    catalog,
  };
  const resolved = resolveRequestSchemaNode(spec, raw, context, 0, new Set());
  if (context.problem) onProblem?.(context.problem);
  return context.exceeded
    ? unresolvedRequestSchema("#workbench-schema-resolution-budget")
    : resolved;
}

function parameterKey(parameter: PlaygroundParameter): string {
  const name =
    parameter.location === "header"
      ? parameter.name.toLowerCase()
      : parameter.name;
  return `${parameter.location}\u0000${name}`;
}

function normalizeParameter(
  spec: UnknownRecord,
  raw: unknown,
  issues: string[],
  catalog: CatalogSchemaResolutionContext,
): PlaygroundParameter | null {
  const record = resolveLocalRef(spec, raw);
  if (!record) return null;
  const rawName = stringValue(record.name);
  const location = stringValue(record.in);
  if (
    !rawName ||
    (location !== "path" && location !== "query" && location !== "header")
  ) {
    return null;
  }
  const name =
    boundedText(
      rawName,
      PLAYGROUND_PARAMETER_NAME_MAX_LENGTH,
      `${location} parameter name`,
      issues,
    ) ?? rawName;
  const resolvedSchema = resolveRequestSchema(
    spec,
    record.schema,
    catalog,
    (problem) => issues.push(`${location} parameter ${name}: ${problem}`),
  );
  if (resolvedSchema === false) {
    issues.push(`${location} parameter ${name} declares a false schema`);
  }
  if (record.required !== undefined && typeof record.required !== "boolean") {
    issues.push(
      `${location} parameter ${name} has malformed required metadata`,
    );
  }
  if (location === "path" && record.required !== true) {
    issues.push(`path parameter ${name} must declare required true`);
  }
  const style = boundedText(
    record.style,
    PLAYGROUND_PARAMETER_STYLE_MAX_LENGTH,
    `${location} parameter ${name} style`,
    issues,
  );
  if (record.style !== undefined && !style) {
    issues.push(`${location} parameter ${name} has malformed style metadata`);
  }
  if (record.explode !== undefined && typeof record.explode !== "boolean") {
    issues.push(`${location} parameter ${name} has malformed explode metadata`);
  }
  const schema =
    resolvedSchema === undefined
      ? undefined
      : resolvedSchema === true
        ? {}
        : (asRecord(resolvedSchema) ??
          unresolvedRequestSchema("#workbench-invalid-parameter-schema"));
  return {
    name,
    location,
    required: location === "path" || record.required === true,
    description: boundedText(
      record.description,
      PLAYGROUND_PARAMETER_DESCRIPTION_MAX_LENGTH,
      `${location} parameter ${name} description`,
      issues,
    ),
    schema,
    example: record.example,
    style,
    explode: typeof record.explode === "boolean" ? record.explode : undefined,
  };
}

function mergeParameters(
  spec: UnknownRecord,
  pathParameters: unknown,
  operationParameters: unknown,
  issues: string[],
  catalog: CatalogSchemaResolutionContext,
): PlaygroundParameter[] {
  const merged: PlaygroundParameter[] = [];
  const positions = new Map<string, number>();
  let declarations = 0;
  let declarationLimitReported = false;
  const append = (items: unknown): void => {
    if (items === undefined) return;
    if (!Array.isArray(items)) {
      issues.push("parameters must be an array");
      return;
    }
    for (const raw of items) {
      declarations += 1;
      if (declarations > PLAYGROUND_OPERATION_MAX_PARAMETERS) {
        if (!declarationLimitReported) {
          issues.push(
            `operation declares more than ${PLAYGROUND_OPERATION_MAX_PARAMETERS} parameters`,
          );
          declarationLimitReported = true;
        }
        break;
      }
      const parameter = normalizeParameter(spec, raw, issues, catalog);
      if (!parameter) {
        issues.push("unresolved or invalid parameter");
        continue;
      }
      const key = parameterKey(parameter);
      const position = positions.get(key);
      if (position === undefined) {
        positions.set(key, merged.length);
        merged.push(parameter);
      } else {
        merged[position] = parameter;
      }
    }
  };
  append(pathParameters);
  append(operationParameters);
  for (const parameter of merged.slice(
    0,
    PLAYGROUND_OPERATION_MAX_PARAMETERS,
  )) {
    if (
      Array.isArray(parameter.schema?.enum) &&
      parameter.schema.enum.length > PLAYGROUND_PARAMETER_ENUM_MAX_VALUES
    ) {
      issues.push(
        `${parameter.location} parameter ${parameter.name} declares too many enum values`,
      );
    }
    if (
      Array.isArray(parameter.schema?.enum) &&
      parameter.schema.enum
        .slice(0, PLAYGROUND_PARAMETER_ENUM_MAX_VALUES)
        .some(
          (value) =>
            new TextEncoder().encode(String(value)).byteLength >
            PLAYGROUND_PARAMETER_ENUM_MAX_VALUE_BYTES,
        )
    ) {
      issues.push(
        `${parameter.location} parameter ${parameter.name} declares an oversized enum value`,
      );
    }
  }
  return merged.slice(0, PLAYGROUND_OPERATION_MAX_PARAMETERS);
}

function schemaExample(
  spec: UnknownRecord,
  rawSchema: unknown,
  depth = 0,
  seenRefs: Set<string> = new Set(),
): unknown {
  if (depth > 8) return undefined;
  const original = asRecord(rawSchema);
  if (!original) return undefined;
  const ref = stringValue(original.$ref);
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
  const type = stringValue(original.type);
  if (type === "object" || asRecord(original.properties)) {
    const properties = asRecord(original.properties) ?? {};
    const required = new Set(stringList(original.required));
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
    const format = stringValue(original.format);
    if (format === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (format === "email") return "developer@example.com";
    if (format === "date-time") return "2026-01-01T00:00:00Z";
    if (format === "date") return "2026-01-01";
    return "";
  }
  return undefined;
}

function normalizeRequestBody(
  spec: UnknownRecord,
  raw: unknown,
  issues: string[],
  catalog: CatalogSchemaResolutionContext,
): PlaygroundRequestBody | undefined {
  if (raw === undefined) return undefined;
  const body = resolveLocalRef(spec, raw);
  if (!body) {
    issues.push("unresolved request body");
    return undefined;
  }
  const content = asRecord(body.content);
  if (!content) {
    issues.push("request body has no content map");
    return undefined;
  }
  const rawMediaTypes = Object.keys(content);
  if (rawMediaTypes.length > PLAYGROUND_OPERATION_MAX_MEDIA_TYPES) {
    issues.push(
      `request body declares more than ${PLAYGROUND_OPERATION_MAX_MEDIA_TYPES} media types`,
    );
  }
  const mediaTypes = rawMediaTypes
    .slice(0, PLAYGROUND_OPERATION_MAX_MEDIA_TYPES)
    .sort()
    .filter((mediaType) => {
      if (mediaType.length <= PLAYGROUND_MEDIA_TYPE_MAX_LENGTH) return true;
      issues.push("request body declares an oversized media type");
      return false;
    });
  for (const mediaType of mediaTypes) {
    if (!asRecord(content[mediaType])) {
      issues.push(`request media ${mediaType} must be an object`);
    }
  }
  const selectedMediaType = mediaTypes.includes("application/json")
    ? "application/json"
    : mediaTypes.find((item) => item.endsWith("+json"));
  const media = selectedMediaType
    ? asRecord(content[selectedMediaType])
    : undefined;
  const schema = media
    ? resolveRequestSchema(spec, media.schema, catalog, (problem) =>
        issues.push(problem),
      )
    : undefined;
  const explicit = media && "example" in media ? media.example : undefined;
  const generated =
    explicit === undefined ? schemaExample(spec, schema) : explicit;
  if (body.required !== undefined && typeof body.required !== "boolean") {
    issues.push("request body required metadata must be boolean");
  }
  return {
    required: body.required === true,
    description: boundedText(
      body.description,
      PLAYGROUND_PARAMETER_DESCRIPTION_MAX_LENGTH,
      "request body description",
      issues,
    ),
    mediaTypes,
    selectedMediaType,
    schema,
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
  privateResponse: boolean,
  issues: string[],
): PlaygroundResponseContract {
  const responses = asRecord(raw);
  if (!responses) {
    issues.push("responses must be an object");
  }
  const mediaTypes = new Set<string>();
  const mediaTypesByStatus: Record<string, string[]> = Object.create(
    null,
  ) as Record<string, string[]>;
  const entries = Object.entries(responses ?? {});
  if (entries.length > PLAYGROUND_OPERATION_MAX_RESPONSES) {
    issues.push(
      `operation declares more than ${PLAYGROUND_OPERATION_MAX_RESPONSES} responses`,
    );
  }
  for (const [status, value] of entries
    .slice(0, PLAYGROUND_OPERATION_MAX_RESPONSES)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (
      status.length > PLAYGROUND_STATUS_MAX_LENGTH ||
      !/^(?:default|[1-5](?:[0-9]{2}|XX))$/i.test(status)
    ) {
      issues.push(
        `operation declares invalid response status ${status.slice(0, 64)}`,
      );
      continue;
    }
    const response = resolveLocalRef(spec, value);
    if (!response) {
      issues.push(`response ${status} is unresolved or malformed`);
      continue;
    }
    const content = asRecord(response.content);
    if (response.content !== undefined && !content) {
      issues.push(`response ${status} content must be an object`);
    }
    const rawStatusMediaTypes = Object.keys(content ?? {});
    if (rawStatusMediaTypes.length > PLAYGROUND_OPERATION_MAX_MEDIA_TYPES) {
      issues.push(
        `response ${status} declares more than ${PLAYGROUND_OPERATION_MAX_MEDIA_TYPES} media types`,
      );
    }
    const statusMediaTypes = rawStatusMediaTypes
      .slice(0, PLAYGROUND_OPERATION_MAX_MEDIA_TYPES)
      .sort()
      .filter((mediaType) => {
        if (mediaType.length <= PLAYGROUND_MEDIA_TYPE_MAX_LENGTH) return true;
        issues.push(`response ${status} declares an oversized media type`);
        return false;
      })
      .filter((mediaType) => {
        if (asRecord(content?.[mediaType])) return true;
        issues.push(`response ${status} media ${mediaType} must be an object`);
        return false;
      });
    mediaTypesByStatus[status] = statusMediaTypes;
    for (const mediaType of statusMediaTypes) mediaTypes.add(mediaType);
  }
  return {
    statuses: Object.keys(mediaTypesByStatus),
    mediaTypes: [...mediaTypes].sort(),
    mediaTypesByStatus,
    private: privateResponse,
  };
}

function normalizeSecurity(
  raw: unknown,
  issues: string[],
): PlaygroundSecurityRequirement[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push("security requirements must be an array");
    return [];
  }
  if (raw.length > PLAYGROUND_OPERATION_MAX_SECURITY_REQUIREMENTS) {
    issues.push(
      `operation declares more than ${PLAYGROUND_OPERATION_MAX_SECURITY_REQUIREMENTS} security requirements`,
    );
  }
  const result: PlaygroundSecurityRequirement[] = [];
  for (const rawRequirement of raw.slice(
    0,
    PLAYGROUND_OPERATION_MAX_SECURITY_REQUIREMENTS,
  )) {
    const requirement = asRecord(rawRequirement);
    if (!requirement) {
      issues.push("security requirement must be an object");
      continue;
    }
    const entries = Object.entries(requirement);
    if (entries.length > PLAYGROUND_SECURITY_MAX_SCHEMES) {
      issues.push(
        `security requirement declares more than ${PLAYGROUND_SECURITY_MAX_SCHEMES} schemes`,
      );
    }
    const schemes: string[] = [];
    for (const [scheme, scopes] of entries.slice(
      0,
      PLAYGROUND_SECURITY_MAX_SCHEMES,
    )) {
      if (!scheme || scheme.length > PLAYGROUND_TAG_MAX_LENGTH) {
        issues.push("security requirement declares an oversized scheme name");
        continue;
      }
      if (
        !Array.isArray(scopes) ||
        scopes.length > PLAYGROUND_OPERATION_MAX_SCOPES ||
        scopes.some((scope) => typeof scope !== "string")
      ) {
        issues.push(`security scheme ${scheme} declares malformed scopes`);
      }
      schemes.push(scheme);
    }
    result.push({ schemes: schemes.sort() });
  }
  return result;
}

function boundedStringList(
  raw: unknown,
  maximumItems: number,
  maximumLength: number,
  label: string,
  issues: string[],
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${label} must be an array`);
    return [];
  }
  if (raw.length > maximumItems) {
    issues.push(`${label} declares more than ${maximumItems} values`);
  }
  const result: string[] = [];
  for (const value of raw.slice(0, maximumItems)) {
    if (typeof value !== "string" || !value.trim()) {
      issues.push(`${label} contains an invalid value`);
      continue;
    }
    if (value.length > maximumLength) {
      issues.push(`${label} contains an oversized value`);
      result.push(`${value.slice(0, maximumLength - 1)}…`);
    } else {
      result.push(value);
    }
  }
  return result;
}

function validatePathParameters(
  path: string,
  parameters: PlaygroundParameter[],
  issues: string[],
): void {
  const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map(
    (match) => match[1]!,
  );
  const pathNames = parameters
    .filter((parameter) => parameter.location === "path")
    .map((parameter) => parameter.name);
  for (const name of new Set(placeholders)) {
    if (placeholders.filter((candidate) => candidate === name).length !== 1) {
      issues.push(`path placeholder ${name} appears more than once`);
    }
    if (pathNames.filter((candidate) => candidate === name).length !== 1) {
      issues.push(
        `path placeholder ${name} does not have exactly one parameter`,
      );
    }
  }
  for (const name of pathNames) {
    if (!placeholders.includes(name)) {
      issues.push(`path parameter ${name} has no placeholder`);
    }
  }
}

function normalizeOperation(
  spec: UnknownRecord,
  rootSecurity: unknown,
  path: string,
  pathItem: UnknownRecord,
  method: PlaygroundMethod,
  rawOperation: UnknownRecord,
  catalog: CatalogSchemaResolutionContext,
): NormalizedPlaygroundOperation {
  const issues: string[] = [];
  if (!path.startsWith("/api/") || /[?#\\\u0000-\u001f]/.test(path)) {
    issues.push("path is outside the canonical /api/ boundary");
  }
  const parameters = mergeParameters(
    spec,
    pathItem.parameters,
    rawOperation.parameters,
    issues,
    catalog,
  );
  validatePathParameters(path, parameters, issues);
  const tags = boundedStringList(
    rawOperation.tags,
    PLAYGROUND_OPERATION_MAX_TAGS,
    PLAYGROUND_TAG_MAX_LENGTH,
    "operation tags",
    issues,
  );
  const explicitSecurity = rawOperation.security;
  const securitySource =
    explicitSecurity === undefined ? rootSecurity : explicitSecurity;
  const normalizedSecurity = normalizeSecurity(securitySource, issues);
  const explicitlyPublic =
    (Array.isArray(securitySource) && securitySource.length === 0) ||
    normalizedSecurity.some((requirement) => requirement.schemes.length === 0);
  const maxBodyBytes = rawOperation["x-postwave-max-body-bytes"];
  if (
    maxBodyBytes !== undefined &&
    (!Number.isSafeInteger(maxBodyBytes) || (maxBodyBytes as number) < 0)
  ) {
    issues.push(
      "x-postwave-max-body-bytes must be a non-negative safe integer",
    );
  }
  const operationId =
    boundedText(
      rawOperation.operationId,
      PLAYGROUND_OPERATION_ID_MAX_LENGTH,
      "operationId",
      issues,
    ) ?? `${method}-${path}`;
  if (
    rawOperation.deprecated !== undefined &&
    typeof rawOperation.deprecated !== "boolean"
  ) {
    issues.push("deprecated metadata must be boolean");
  }
  if (
    rawOperation["x-postwave-bodyless"] !== undefined &&
    typeof rawOperation["x-postwave-bodyless"] !== "boolean"
  ) {
    issues.push("x-postwave-bodyless must be boolean");
  }
  if (
    rawOperation["x-postwave-private-response"] !== undefined &&
    typeof rawOperation["x-postwave-private-response"] !== "boolean"
  ) {
    issues.push("x-postwave-private-response must be boolean");
  }
  return {
    method,
    path,
    operationId,
    summary:
      boundedText(
        rawOperation.summary,
        PLAYGROUND_SUMMARY_MAX_LENGTH,
        "operation summary",
        issues,
      ) ?? operationId,
    description:
      boundedText(
        rawOperation.description,
        PLAYGROUND_DESCRIPTION_MAX_LENGTH,
        "operation description",
        issues,
      ) ?? "",
    tags: tags.length > 0 ? tags : ["Other"],
    primaryTag: tags[0] ?? "Other",
    deprecated: rawOperation.deprecated === true,
    parameters,
    requestBody: normalizeRequestBody(
      spec,
      rawOperation.requestBody,
      issues,
      catalog,
    ),
    responses: normalizeResponses(
      spec,
      rawOperation.responses,
      rawOperation["x-postwave-private-response"] === true,
      issues,
    ),
    security: normalizedSecurity,
    explicitlyPublic,
    requiredRole: boundedOptionalMetadata(
      rawOperation["x-required-role"],
      PLAYGROUND_TAG_MAX_LENGTH,
      "required role",
      issues,
    ),
    requiredScopes: boundedStringList(
      rawOperation["x-required-scopes"],
      PLAYGROUND_OPERATION_MAX_SCOPES,
      PLAYGROUND_TAG_MAX_LENGTH,
      "required scopes",
      issues,
    ),
    requiredScopeMode: boundedOptionalMetadata(
      rawOperation["x-required-scope-mode"],
      PLAYGROUND_TAG_MAX_LENGTH,
      "required scope mode",
      issues,
    ),
    releaseHold: boundedOptionalMetadata(
      rawOperation["x-postwave-release-hold"],
      PLAYGROUND_PARAMETER_DESCRIPTION_MAX_LENGTH,
      "release hold",
      issues,
    ),
    maxBodyBytes:
      typeof maxBodyBytes === "number" &&
      Number.isSafeInteger(maxBodyBytes) &&
      maxBodyBytes >= 0
        ? maxBodyBytes
        : undefined,
    bodyless: rawOperation["x-postwave-bodyless"] === true,
    contractIssues: issues,
  };
}

export function normalizePlaygroundCatalog(
  input: unknown,
): NormalizedPlaygroundCatalog {
  const spec = asRecord(input);
  if (!spec)
    throw new PlaygroundCatalogError("OpenAPI document must be an object");
  const openapiVersion = stringValue(spec.openapi);
  if (!openapiVersion || !/^3\.1\.\d+(?:[-+].*)?$/.test(openapiVersion)) {
    throw new PlaygroundCatalogError(
      "API Playground requires an explicit OpenAPI 3.1 document",
    );
  }
  const paths = asRecord(spec.paths);
  if (!paths)
    throw new PlaygroundCatalogError("OpenAPI document has no paths map");
  const pathEntries = Object.entries(paths);
  if (pathEntries.length > PLAYGROUND_CATALOG_MAX_PATHS) {
    throw new PlaygroundCatalogError(
      `OpenAPI document exceeds the ${PLAYGROUND_CATALOG_MAX_PATHS}-path workbench limit`,
    );
  }
  const info = asRecord(spec.info);
  const operations: NormalizedPlaygroundOperation[] = [];
  const warnings: string[] = [];
  const schemaResolution: CatalogSchemaResolutionContext = {
    nodes: 0,
    refs: new Map(),
  };
  for (const [path, rawPathItem] of pathEntries) {
    if (path.length > PLAYGROUND_PATH_MAX_LENGTH) {
      throw new PlaygroundCatalogError(
        `OpenAPI document contains a path above the ${PLAYGROUND_PATH_MAX_LENGTH}-character workbench limit`,
      );
    }
    const pathItem = resolveLocalRef(spec, rawPathItem);
    if (!pathItem) {
      warnings.push(`Skipped unresolved path item ${path}`);
      continue;
    }
    for (const method of PLAYGROUND_METHODS) {
      const operationSource = pathItem[method];
      if (operationSource === undefined) continue;
      const rawOperation = resolveLocalRef(spec, operationSource);
      if (!rawOperation) {
        warnings.push(`Skipped unresolved ${method.toUpperCase()} ${path}`);
        continue;
      }
      if (operations.length >= PLAYGROUND_CATALOG_MAX_OPERATIONS) {
        throw new PlaygroundCatalogError(
          `OpenAPI document exceeds the ${PLAYGROUND_CATALOG_MAX_OPERATIONS}-operation workbench limit`,
        );
      }
      operations.push(
        normalizeOperation(
          spec,
          spec.security,
          path,
          pathItem,
          method,
          rawOperation,
          schemaResolution,
        ),
      );
    }
  }
  if (operations.length === 0) {
    throw new PlaygroundCatalogError(
      "OpenAPI document contains no supported operations",
    );
  }
  if (warnings.length > 0) {
    throw new PlaygroundCatalogError(
      `OpenAPI document is incomplete: ${warnings[0]}`,
    );
  }
  const distinctTags = new Set(
    operations.flatMap((operation) => operation.tags),
  );
  if (distinctTags.size > PLAYGROUND_CATALOG_MAX_DISTINCT_TAGS) {
    throw new PlaygroundCatalogError(
      `OpenAPI document exceeds the ${PLAYGROUND_CATALOG_MAX_DISTINCT_TAGS}-tag workbench limit`,
    );
  }
  operations.sort((a, b) =>
    a.primaryTag === b.primaryTag
      ? a.path === b.path
        ? PLAYGROUND_METHODS.indexOf(a.method) -
          PLAYGROUND_METHODS.indexOf(b.method)
        : a.path.localeCompare(b.path)
      : a.primaryTag.localeCompare(b.primaryTag),
  );
  const title = stringValue(info?.title) ?? "Moosewave API";
  const version = stringValue(info?.version) ?? "unknown";
  if (
    title.length > PLAYGROUND_SUMMARY_MAX_LENGTH ||
    version.length > PLAYGROUND_OPERATION_ID_MAX_LENGTH
  ) {
    throw new PlaygroundCatalogError(
      "OpenAPI document metadata exceeds the workbench display limits",
    );
  }
  return {
    title,
    version,
    operations,
    warnings,
  };
}
