import {
  PLAYGROUND_CUSTOM_HEADER_MAX_ROWS,
  type CustomHeaderRow,
} from "../components/playground/PlaygroundHeaders";
import type { RequestPlan } from "../components/playground/PlaygroundCodeGen";
import type {
  NormalizedPlaygroundOperation,
  PlaygroundParameter,
} from "./api-playground-openapi";
import {
  type PlaygroundExecutionPolicy,
  isPortablePlaygroundHeader,
} from "./api-playground-policy";

export interface PlaygroundRequestValues {
  path: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  customHeaders: CustomHeaderRow[];
  body: string;
  idempotencyKey: string;
}

export interface PlaygroundValidationIssue {
  field: "catalog" | "path" | "query" | "header" | "body" | "url";
  name?: string;
  message: string;
}

export interface BuiltPlaygroundRequest {
  plan: RequestPlan;
  issues: PlaygroundValidationIssue[];
  resolvedPath: string;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
export const PLAYGROUND_REQUEST_BODY_MAX_BYTES = 256 * 1024;
export const PLAYGROUND_PATH_VALUE_MAX_BYTES = 2 * 1024;
export const PLAYGROUND_QUERY_MAX_BYTES = 32 * 1024;
export const PLAYGROUND_HEADER_VALUE_MAX_BYTES = 8 * 1024;
export const PLAYGROUND_REQUEST_MAX_HEADERS = 64;
export const PLAYGROUND_REQUEST_MAX_HEADER_BYTES = 32 * 1024;
const SCHEMA_VALIDATION_MAX_DEPTH = 12;
const SCHEMA_VALIDATION_MAX_NODES = 2_048;
const SCHEMA_VALIDATION_MAX_COLLECTION_ITEMS = 512;
const SCHEMA_VALIDATION_MAX_BRANCHES = 8;
const SCHEMA_VALIDATION_MAX_ENUM_VALUES = 256;
const SCHEMA_VALIDATION_MAX_MESSAGES = 32;
const JSON_KEY_SCAN_MAX_DEPTH = 64;
const JSON_KEY_SCAN_MAX_KEYS = 4_096;
const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_VALUE = /^-?(?:0|[1-9][0-9]*)$/;
const NUMBER_VALUE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const UNSUPPORTED_SCHEMA_ASSERTIONS = [
  "$dynamicRef",
  "$recursiveRef",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "if",
  "maxContains",
  "minContains",
  "multipleOf",
  "not",
  "patternProperties",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const MANAGED_HEADERS = new Set([
  "authorization",
  "cookie",
  "content-length",
  "content-type",
  "host",
  "idempotency-key",
  "origin",
  "referer",
  "x-postwave-client",
  "x-postwave-event-seq",
  "x-postwave-version",
]);
const NATIVE_FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "fly-client-ip",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-envoy-external-address",
  "x-appengine-user-ip",
  "x-azure-clientip",
  "content-length",
  "transfer-encoding",
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "x-http-method-override",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
  "user-agent",
  "x-postwave-client",
  "x-postwave-version",
]);

function nativeForbidsHeader(name: string): boolean {
  return (
    NATIVE_FORBIDDEN_HEADERS.has(name) ||
    name.startsWith("sec-") ||
    name.startsWith("x-forwarded-") ||
    name.startsWith("x-original-forwarded-")
  );
}

function canonicalBase(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function repeatedlyDecoded(value: string): string[] {
  const values = [value];
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      values.push(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return values;
}

export function unsafePlaygroundPathValue(value: string): string | null {
  for (const candidate of repeatedlyDecoded(value)) {
    const lower = candidate.toLowerCase();
    if (CONTROL.test(candidate)) return "Control characters are not allowed.";
    if (candidate.includes("/") || candidate.includes("\\")) {
      return "Path values cannot contain slash or backslash characters.";
    }
    if (lower === "." || lower === "..") {
      return "Dot path segments are not allowed.";
    }
    if (/%(?:2e|2f|5c)/i.test(candidate)) {
      return "Encoded dot and slash path segments are not allowed.";
    }
  }
  return null;
}

function valueFor(
  values: Record<string, string>,
  parameter: PlaygroundParameter,
): string {
  return values[parameter.name] ?? "";
}

type SchemaRecord = Record<string, unknown>;
type SchemaValidationMode = "body" | "parameter";

interface SchemaValidationContext {
  nodes: number;
  stringLengths: Map<string, number>;
  failure?: string;
}

const PARAMETER_COERCION_FAILED = Symbol("parameter-coercion-failed");

function schemaRecord(value: unknown): SchemaRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SchemaRecord)
    : null;
}

function hasOwn(record: SchemaRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function failSchemaValidation(
  context: SchemaValidationContext,
  message: string,
): void {
  context.failure ??= message;
}

function addSchemaMessage(
  messages: string[],
  context: SchemaValidationContext,
  message: string,
): void {
  if (messages.length >= SCHEMA_VALIDATION_MAX_MESSAGES) {
    failSchemaValidation(
      context,
      "Schema validation found too many issues for a safe preview.",
    );
    return;
  }
  messages.push(message);
}

function spendSchemaNode(
  context: SchemaValidationContext,
  depth: number,
): boolean {
  context.nodes += 1;
  if (
    depth > SCHEMA_VALIDATION_MAX_DEPTH ||
    context.nodes > SCHEMA_VALIDATION_MAX_NODES
  ) {
    failSchemaValidation(
      context,
      "Schema validation exceeded the safe workbench depth or node budget.",
    );
    return false;
  }
  return !context.failure;
}

function schemaNumber(
  schema: SchemaRecord,
  key: string,
  context: SchemaValidationContext,
): number | undefined {
  if (!hasOwn(schema, key)) return undefined;
  const value = schema[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failSchemaValidation(
      context,
      "The contract contains a numeric constraint that cannot be safely validated.",
    );
    return undefined;
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    failSchemaValidation(
      context,
      "The contract contains a numeric constraint outside the safe integer range.",
    );
    return undefined;
  }
  return value;
}

function schemaCount(
  schema: SchemaRecord,
  key: string,
  context: SchemaValidationContext,
): number | undefined {
  const value = schemaNumber(schema, key, context);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    failSchemaValidation(
      context,
      "The contract contains a collection constraint that cannot be safely validated.",
    );
    return undefined;
  }
  return value;
}

function schemaTypes(
  schema: SchemaRecord,
  context: SchemaValidationContext,
): string[] {
  const raw = schema.type;
  let types: string[];
  if (raw === undefined) {
    types =
      hasOwn(schema, "properties") || hasOwn(schema, "required")
        ? ["object"]
        : hasOwn(schema, "items")
          ? ["array"]
          : [];
  } else if (typeof raw === "string") {
    types = [raw];
  } else if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.length <= SCHEMA_VALIDATION_MAX_BRANCHES &&
    raw.every((item): item is string => typeof item === "string")
  ) {
    types = [...new Set(raw)];
  } else {
    failSchemaValidation(
      context,
      "The contract contains a type constraint that cannot be safely validated.",
    );
    return [];
  }
  if (schema.nullable === true && !types.includes("null")) types.push("null");
  if (types.some((type) => !JSON_SCHEMA_TYPES.has(type))) {
    failSchemaValidation(
      context,
      "The contract contains an unsupported JSON Schema type.",
    );
  }
  return types;
}

function coerceParameterValue(
  value: string,
  types: string[],
  path: string,
  messages: string[],
  context: SchemaValidationContext,
): unknown | typeof PARAMETER_COERCION_FAILED {
  const nonNullTypes = types.filter((type) => type !== "null");
  if (nonNullTypes.length === 0) return value;
  if (nonNullTypes.length !== 1) {
    failSchemaValidation(
      context,
      "A parameter uses a union type that cannot be serialized safely.",
    );
    return PARAMETER_COERCION_FAILED;
  }
  const type = nonNullTypes[0];
  if (type === "string") return value;
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    addSchemaMessage(messages, context, `${path} must be true or false.`);
    return PARAMETER_COERCION_FAILED;
  }
  if (type === "integer") {
    if (!INTEGER_VALUE.test(value)) {
      addSchemaMessage(messages, context, `${path} must be an integer.`);
      return PARAMETER_COERCION_FAILED;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      addSchemaMessage(
        messages,
        context,
        `${path} must be a safely representable integer.`,
      );
      return PARAMETER_COERCION_FAILED;
    }
    return parsed;
  }
  if (type === "number") {
    if (!NUMBER_VALUE.test(value)) {
      addSchemaMessage(messages, context, `${path} must be a number.`);
      return PARAMETER_COERCION_FAILED;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      addSchemaMessage(messages, context, `${path} must be finite.`);
      return PARAMETER_COERCION_FAILED;
    }
    return parsed;
  }
  addSchemaMessage(
    messages,
    context,
    `${path} uses an unsupported structured parameter type.`,
  );
  return PARAMETER_COERCION_FAILED;
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateSchemaCapabilities(
  schema: SchemaRecord,
  path: string,
  messages: string[],
  context: SchemaValidationContext,
): void {
  if (hasOwn(schema, "$ref")) {
    failSchemaValidation(
      context,
      "The contract contains an unresolved or cyclic schema reference.",
    );
    return;
  }
  const unsupported = UNSUPPORTED_SCHEMA_ASSERTIONS.find((key) =>
    hasOwn(schema, key),
  );
  if (unsupported) {
    failSchemaValidation(
      context,
      `The contract uses the unsupported JSON Schema constraint “${unsupported}”.`,
    );
    return;
  }
  if (hasOwn(schema, "uniqueItems") && schema.uniqueItems !== false) {
    failSchemaValidation(
      context,
      "The contract uses the unsupported JSON Schema constraint “uniqueItems”.",
    );
    return;
  }
  if (hasOwn(schema, "readOnly") && typeof schema.readOnly !== "boolean") {
    failSchemaValidation(
      context,
      "The contract contains a read-only annotation that cannot be safely validated.",
    );
    return;
  }
  if (schema.readOnly === true) {
    addSchemaMessage(
      messages,
      context,
      `${path} is read-only and cannot be sent.`,
    );
  }
  if (hasOwn(schema, "format")) {
    if (typeof schema.format !== "string" || !schema.format) {
      failSchemaValidation(
        context,
        "The contract contains a malformed JSON Schema format.",
      );
    } else if (schema.format !== "uuid") {
      addSchemaMessage(
        messages,
        context,
        `${path} uses the unsupported JSON Schema format “${schema.format}”.`,
      );
    }
  }
}

function typeDescription(types: string[]): string {
  return types.length === 1 ? types[0]! : types.join(" or ");
}

function primitiveEqual(left: unknown, right: unknown): boolean {
  if (
    left === null ||
    typeof left === "string" ||
    typeof left === "number" ||
    typeof left === "boolean"
  ) {
    return Object.is(left, right);
  }
  return false;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function validateConstAndEnum(
  schema: SchemaRecord,
  value: unknown,
  path: string,
  messages: string[],
  context: SchemaValidationContext,
): void {
  if (hasOwn(schema, "const")) {
    const expected = schema.const;
    if (
      expected !== null &&
      typeof expected !== "string" &&
      typeof expected !== "number" &&
      typeof expected !== "boolean"
    ) {
      failSchemaValidation(
        context,
        "The contract contains a structured constant that cannot be safely validated.",
      );
    } else if (!primitiveEqual(value, expected)) {
      addSchemaMessage(
        messages,
        context,
        `${path} must equal the documented constant.`,
      );
    }
  }
  if (!hasOwn(schema, "enum")) return;
  const values = schema.enum;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > SCHEMA_VALIDATION_MAX_ENUM_VALUES ||
    values.some(
      (item) =>
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean",
    )
  ) {
    failSchemaValidation(
      context,
      "The contract contains an enum that cannot be safely validated.",
    );
    return;
  }
  if (!values.some((candidate) => primitiveEqual(value, candidate))) {
    addSchemaMessage(
      messages,
      context,
      `${path} must match one of the documented values.`,
    );
  }
}

function validateStringConstraints(
  schema: SchemaRecord,
  value: string,
  path: string,
  messages: string[],
  context: SchemaValidationContext,
): void {
  let length = context.stringLengths.get(value);
  if (length === undefined) {
    length = 0;
    for (const _character of value) length += 1;
    context.stringLengths.set(value, length);
  }
  const minimum = schemaCount(schema, "minLength", context);
  const maximum = schemaCount(schema, "maxLength", context);
  if (minimum !== undefined && length < minimum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at least ${countLabel(minimum, "character")}.`,
    );
  }
  if (maximum !== undefined && length > maximum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at most ${countLabel(maximum, "character")}.`,
    );
  }
  if (schema.format === "uuid" && !UUID_VALUE.test(value)) {
    addSchemaMessage(messages, context, `${path} must be a canonical UUID.`);
  }
  if (hasOwn(schema, "pattern")) {
    addSchemaMessage(
      messages,
      context,
      `${path} has a pattern constraint that the workbench will not execute.`,
    );
  }
}

function validateNumberConstraints(
  schema: SchemaRecord,
  value: number,
  path: string,
  messages: string[],
  context: SchemaValidationContext,
): void {
  const minimum = schemaNumber(schema, "minimum", context);
  const maximum = schemaNumber(schema, "maximum", context);
  const exclusiveMinimum = schemaNumber(schema, "exclusiveMinimum", context);
  const exclusiveMaximum = schemaNumber(schema, "exclusiveMaximum", context);
  if (minimum !== undefined && value < minimum) {
    addSchemaMessage(messages, context, `${path} must be at least ${minimum}.`);
  }
  if (maximum !== undefined && value > maximum) {
    addSchemaMessage(messages, context, `${path} must be at most ${maximum}.`);
  }
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must be greater than ${exclusiveMinimum}.`,
    );
  }
  if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must be less than ${exclusiveMaximum}.`,
    );
  }
}

function displayPropertyPath(path: string, property: string): string {
  const bounded = property.slice(0, 64);
  const suffix = property.length > 64 ? "…" : "";
  return `${path}[${JSON.stringify(`${bounded}${suffix}`)}]`;
}

function validateRawSchema(
  rawSchema: unknown,
  value: unknown,
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  if (rawSchema === true || rawSchema === undefined) return;
  if (rawSchema === false) {
    addSchemaMessage(messages, context, `${path} is not allowed.`);
    return;
  }
  const schema = schemaRecord(rawSchema);
  if (!schema) {
    failSchemaValidation(
      context,
      "The contract contains a schema that cannot be safely validated.",
    );
    return;
  }
  validateSchemaValue(schema, value, path, mode, messages, context, depth);
}

function schemaBranches(
  schema: SchemaRecord,
  key: "allOf" | "anyOf" | "oneOf",
  context: SchemaValidationContext,
): unknown[] | null {
  if (!hasOwn(schema, key)) return null;
  const branches = schema[key];
  if (
    !Array.isArray(branches) ||
    branches.length === 0 ||
    branches.length > SCHEMA_VALIDATION_MAX_BRANCHES
  ) {
    failSchemaValidation(
      context,
      "The contract contains too many or malformed schema alternatives.",
    );
    return [];
  }
  return branches;
}

function validateAlternatives(
  kind: "anyOf" | "oneOf",
  branches: unknown[],
  value: unknown,
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  let matches = 0;
  for (const branch of branches) {
    const branchMessages: string[] = [];
    validateRawSchema(
      branch,
      value,
      path,
      mode,
      branchMessages,
      context,
      depth + 1,
    );
    if (context.failure) return;
    if (branchMessages.length === 0) matches += 1;
  }
  const valid = kind === "oneOf" ? matches === 1 : matches >= 1;
  if (!valid) {
    addSchemaMessage(
      messages,
      context,
      kind === "oneOf"
        ? `${path} must match exactly one documented alternative.`
        : `${path} must match a documented alternative.`,
    );
  }
}

function validateCompositions(
  schema: SchemaRecord,
  value: unknown,
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  const allOf = schemaBranches(schema, "allOf", context);
  for (const branch of allOf ?? []) {
    validateRawSchema(branch, value, path, mode, messages, context, depth + 1);
    if (context.failure) return;
  }
  const anyOf = schemaBranches(schema, "anyOf", context);
  if (anyOf?.length) {
    validateAlternatives(
      "anyOf",
      anyOf,
      value,
      path,
      mode,
      messages,
      context,
      depth,
    );
  }
  const oneOf = schemaBranches(schema, "oneOf", context);
  if (oneOf?.length) {
    validateAlternatives(
      "oneOf",
      oneOf,
      value,
      path,
      mode,
      messages,
      context,
      depth,
    );
  }
}

function validateObjectValue(
  schema: SchemaRecord,
  value: SchemaRecord,
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  const keys = Object.keys(value);
  if (keys.length > SCHEMA_VALIDATION_MAX_COLLECTION_ITEMS) {
    failSchemaValidation(
      context,
      "Schema validation exceeded the safe object-property budget.",
    );
    return;
  }
  const minimum = schemaCount(schema, "minProperties", context);
  const maximum = schemaCount(schema, "maxProperties", context);
  if (minimum !== undefined && keys.length < minimum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at least ${countLabel(minimum, "property")}.`,
    );
  }
  if (maximum !== undefined && keys.length > maximum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at most ${countLabel(maximum, "property")}.`,
    );
  }
  const rawRequired = schema.required;
  const required = rawRequired === undefined ? [] : rawRequired;
  if (
    !Array.isArray(required) ||
    required.length > SCHEMA_VALIDATION_MAX_COLLECTION_ITEMS ||
    required.some((item) => typeof item !== "string")
  ) {
    failSchemaValidation(
      context,
      "The contract contains a required-property list that cannot be safely validated.",
    );
    return;
  }
  for (const name of required) {
    if (!hasOwn(value, name)) {
      addSchemaMessage(
        messages,
        context,
        `${displayPropertyPath(path, name)} is required.`,
      );
    }
  }
  const properties =
    schema.properties === undefined ? null : schemaRecord(schema.properties);
  if (schema.properties !== undefined && !properties) {
    failSchemaValidation(
      context,
      "The contract contains a property map that cannot be safely validated.",
    );
    return;
  }
  const additional = schema.additionalProperties;
  for (const key of keys) {
    const childPath = displayPropertyPath(path, key);
    if (properties && hasOwn(properties, key)) {
      validateRawSchema(
        properties[key],
        value[key],
        childPath,
        mode,
        messages,
        context,
        depth + 1,
      );
    } else if (additional === false) {
      addSchemaMessage(
        messages,
        context,
        `${childPath} is not allowed by this request contract.`,
      );
    } else if (additional !== undefined && additional !== true) {
      validateRawSchema(
        additional,
        value[key],
        childPath,
        mode,
        messages,
        context,
        depth + 1,
      );
    }
    if (context.failure) return;
  }
}

function validateArrayValue(
  schema: SchemaRecord,
  value: unknown[],
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  if (value.length > SCHEMA_VALIDATION_MAX_COLLECTION_ITEMS) {
    failSchemaValidation(
      context,
      "Schema validation exceeded the safe array-item budget.",
    );
    return;
  }
  const minimum = schemaCount(schema, "minItems", context);
  const maximum = schemaCount(schema, "maxItems", context);
  if (minimum !== undefined && value.length < minimum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at least ${countLabel(minimum, "item")}.`,
    );
  }
  if (maximum !== undefined && value.length > maximum) {
    addSchemaMessage(
      messages,
      context,
      `${path} must contain at most ${countLabel(maximum, "item")}.`,
    );
  }
  if (schema.items === undefined || schema.items === true) return;
  for (const [index, item] of value.entries()) {
    validateRawSchema(
      schema.items,
      item,
      `${path}[${index}]`,
      mode,
      messages,
      context,
      depth + 1,
    );
    if (context.failure) return;
  }
}

function validateSchemaValue(
  schema: SchemaRecord,
  originalValue: unknown,
  path: string,
  mode: SchemaValidationMode,
  messages: string[],
  context: SchemaValidationContext,
  depth: number,
): void {
  if (!spendSchemaNode(context, depth)) return;
  validateSchemaCapabilities(schema, path, messages, context);
  if (context.failure) return;
  validateCompositions(
    schema,
    originalValue,
    path,
    mode,
    messages,
    context,
    depth,
  );
  if (context.failure) return;
  const types = schemaTypes(schema, context);
  let value = originalValue;
  if (mode === "parameter") {
    value = coerceParameterValue(
      String(originalValue),
      types,
      path,
      messages,
      context,
    );
    if (value === PARAMETER_COERCION_FAILED || context.failure) return;
  }
  if (
    types.length > 0 &&
    !types.some((type) => valueMatchesType(value, type))
  ) {
    addSchemaMessage(
      messages,
      context,
      `${path} must be ${typeDescription(types)}.`,
    );
    return;
  }
  const nonNullTypes = types.filter((type) => type !== "null");
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    nonNullTypes.length === 1 &&
    nonNullTypes[0] === "integer"
  ) {
    addSchemaMessage(
      messages,
      context,
      `${path} must be within the safe integer range.`,
    );
    return;
  }
  validateConstAndEnum(schema, value, path, messages, context);
  if (context.failure || value === null) return;
  if (typeof value === "string") {
    validateStringConstraints(schema, value, path, messages, context);
  } else if (typeof value === "number") {
    validateNumberConstraints(schema, value, path, messages, context);
  } else if (Array.isArray(value)) {
    validateArrayValue(schema, value, path, mode, messages, context, depth);
  } else if (schemaRecord(value)) {
    validateObjectValue(
      schema,
      value as SchemaRecord,
      path,
      mode,
      messages,
      context,
      depth,
    );
  }
}

function schemaValidationMessages(
  schema: unknown,
  value: unknown,
  path: string,
  mode: SchemaValidationMode,
): string[] {
  const context: SchemaValidationContext = {
    nodes: 0,
    stringLengths: new Map(),
  };
  const messages: string[] = [];
  validateRawSchema(schema, value, path, mode, messages, context, 0);
  if (context.failure && !messages.includes(context.failure)) {
    messages.push(context.failure);
  }
  return messages;
}

function validateParameterValue(
  parameter: PlaygroundParameter,
  value: string,
  issues: PlaygroundValidationIssue[],
): void {
  if (!parameter.schema) return;
  for (const message of schemaValidationMessages(
    parameter.schema,
    value,
    parameter.name,
    "parameter",
  )) {
    issues.push({
      field: parameter.location,
      name: parameter.name,
      message,
    });
  }
}

function pathWithValues(
  operation: NormalizedPlaygroundOperation,
  values: Record<string, string>,
  issues: PlaygroundValidationIssue[],
): string {
  const parameters = new Map(
    operation.parameters
      .filter((parameter) => parameter.location === "path")
      .map((parameter) => [parameter.name, parameter]),
  );
  return operation.path.replace(
    /\{([^{}]+)\}/g,
    (placeholder, name: string) => {
      const parameter = parameters.get(name);
      const value = parameter ? valueFor(values, parameter) : "";
      if (!parameter) {
        issues.push({
          field: "catalog",
          name,
          message: `Path placeholder “${name}” has no normalized parameter.`,
        });
        return placeholder;
      }
      if (!value.trim()) {
        issues.push({ field: "path", name, message: `${name} is required.` });
        return placeholder;
      }
      if (
        new TextEncoder().encode(value).byteLength >
        PLAYGROUND_PATH_VALUE_MAX_BYTES
      ) {
        issues.push({
          field: "path",
          name,
          message: `${name} exceeds the ${PLAYGROUND_PATH_VALUE_MAX_BYTES}-byte preview limit.`,
        });
        return placeholder;
      }
      const unsafe = unsafePlaygroundPathValue(value);
      if (unsafe) {
        issues.push({ field: "path", name, message: `${name}: ${unsafe}` });
        return placeholder;
      }
      validateParameterValue(parameter, value, issues);
      return encodeURIComponent(value);
    },
  );
}

function appendQuery(
  operation: NormalizedPlaygroundOperation,
  values: Record<string, string>,
  issues: PlaygroundValidationIssue[],
): string {
  const search = new URLSearchParams();
  const supplied: Array<[PlaygroundParameter, string]> = [];
  for (const parameter of operation.parameters.filter(
    (item) => item.location === "query",
  )) {
    const value = valueFor(values, parameter);
    if (parameter.required && !value.trim()) {
      issues.push({
        field: "query",
        name: parameter.name,
        message: `${parameter.name} is required.`,
      });
    }
    if (value !== "") {
      search.set(parameter.name, value);
      supplied.push([parameter, value]);
    }
  }
  const serialized = search.toString();
  const exceedsQueryLimit =
    new TextEncoder().encode(serialized).byteLength >
    PLAYGROUND_QUERY_MAX_BYTES;
  if (exceedsQueryLimit) {
    issues.push({
      field: "query",
      message: `Encoded query exceeds the ${PLAYGROUND_QUERY_MAX_BYTES}-byte preview limit.`,
    });
  } else {
    for (const [parameter, value] of supplied) {
      validateParameterValue(parameter, value, issues);
    }
  }
  return serialized;
}

function setHeader(
  headers: Record<string, string>,
  seen: Set<string>,
  name: string,
  value: string,
  issues: PlaygroundValidationIssue[],
  options: { managed?: boolean; declared?: boolean } = {},
): void {
  const normalized = name.trim().toLowerCase();
  if (!HEADER_NAME.test(name.trim())) {
    issues.push({
      field: "header",
      name,
      message: `${name || "Header"} has an invalid field name.`,
    });
    return;
  }
  if (CONTROL.test(value)) {
    issues.push({
      field: "header",
      name,
      message: `${name} contains a control character.`,
    });
    return;
  }
  if (
    new TextEncoder().encode(value).byteLength >
    PLAYGROUND_HEADER_VALUE_MAX_BYTES
  ) {
    issues.push({
      field: "header",
      name,
      message: `${name} exceeds the ${PLAYGROUND_HEADER_VALUE_MAX_BYTES}-byte preview limit.`,
    });
    return;
  }
  if (!options.managed && nativeForbidsHeader(normalized)) {
    if (MANAGED_HEADERS.has(normalized)) {
      // Preserve the more specific protected-transport diagnostic below.
    } else {
      issues.push({
        field: "header",
        name,
        message: `${name} is rejected by the protected native transport.`,
      });
      return;
    }
  }
  if (!options.managed && MANAGED_HEADERS.has(normalized)) {
    issues.push({
      field: "header",
      name,
      message: `${name} is managed by the protected transport.`,
    });
    return;
  }
  if (
    !options.managed &&
    !options.declared &&
    !isPortablePlaygroundHeader(name)
  ) {
    issues.push({
      field: "header",
      name,
      message: `${name} is not portable across desktop transports.`,
    });
    return;
  }
  if (seen.has(normalized)) {
    issues.push({ field: "header", name, message: `${name} is duplicated.` });
    return;
  }
  seen.add(normalized);
  headers[name.trim()] = value;
}

function requestHeaders(
  operation: NormalizedPlaygroundOperation,
  policy: PlaygroundExecutionPolicy,
  values: PlaygroundRequestValues,
  issues: PlaygroundValidationIssue[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const parameter of operation.parameters.filter(
    (item) => item.location === "header",
  )) {
    if (parameter.name.toLowerCase() === "idempotency-key") continue;
    const value = valueFor(values.headers, parameter);
    if (parameter.required && !value.trim()) {
      issues.push({
        field: "header",
        name: parameter.name,
        message: `${parameter.name} is required.`,
      });
    }
    if (value !== "") {
      const issueCount = issues.length;
      setHeader(headers, seen, parameter.name, value, issues, {
        declared: true,
      });
      if (issues.length === issueCount) {
        validateParameterValue(parameter, value, issues);
      }
    }
  }
  if (values.customHeaders.length > PLAYGROUND_CUSTOM_HEADER_MAX_ROWS) {
    issues.push({
      field: "header",
      message: `At most ${PLAYGROUND_CUSTOM_HEADER_MAX_ROWS} custom headers may be previewed.`,
    });
  }
  for (const row of values.customHeaders.slice(
    0,
    PLAYGROUND_CUSTOM_HEADER_MAX_ROWS,
  )) {
    if (!row.key.trim() && !row.value) continue;
    setHeader(headers, seen, row.key, row.value, issues);
  }
  if (operation.requestBody?.selectedMediaType && values.body.trim()) {
    setHeader(
      headers,
      seen,
      "Content-Type",
      operation.requestBody.selectedMediaType,
      issues,
      { managed: true },
    );
  }
  if (policy.idempotency !== "none") {
    if (!values.idempotencyKey.trim() && policy.idempotency === "required") {
      issues.push({
        field: "header",
        name: "Idempotency-Key",
        message: "Idempotency-Key is required.",
      });
    } else if (values.idempotencyKey.trim()) {
      const parameter = operation.parameters.find(
        (item) =>
          item.location === "header" &&
          item.name.toLowerCase() === "idempotency-key",
      );
      const issueCount = issues.length;
      setHeader(
        headers,
        seen,
        "Idempotency-Key",
        values.idempotencyKey,
        issues,
        { managed: true },
      );
      if (parameter && issues.length === issueCount) {
        validateParameterValue(parameter, values.idempotencyKey, issues);
      }
    }
  }
  return headers;
}

function validateHeaderAggregate(
  headers: Record<string, string>,
  issues: PlaygroundValidationIssue[],
): void {
  const entries = Object.entries(headers);
  if (entries.length > PLAYGROUND_REQUEST_MAX_HEADERS) {
    issues.push({
      field: "header",
      message: `Request headers exceed the ${PLAYGROUND_REQUEST_MAX_HEADERS}-header native transport limit.`,
    });
  }
  let bytes = 0;
  for (const [name, value] of entries.slice(
    0,
    PLAYGROUND_REQUEST_MAX_HEADERS + 1,
  )) {
    bytes += new TextEncoder().encode(name).byteLength;
    bytes += new TextEncoder().encode(value).byteLength;
    if (bytes > PLAYGROUND_REQUEST_MAX_HEADER_BYTES) {
      issues.push({
        field: "header",
        message: `Request headers exceed the ${PLAYGROUND_REQUEST_MAX_HEADER_BYTES}-byte native transport limit.`,
      });
      break;
    }
  }
}

function validateBody(
  operation: NormalizedPlaygroundOperation,
  body: string,
  issues: PlaygroundValidationIssue[],
): void {
  if (operation.bodyless && body.trim()) {
    issues.push({
      field: "body",
      message: "This operation is explicitly bodyless.",
    });
    return;
  }
  if (operation.requestBody?.required && !body.trim()) {
    issues.push({ field: "body", message: "Request body is required." });
    return;
  }
  if (!body.trim()) return;
  const bytes = new TextEncoder().encode(body).byteLength;
  const exceedsWorkbenchLimit = bytes > PLAYGROUND_REQUEST_BODY_MAX_BYTES;
  if (exceedsWorkbenchLimit) {
    issues.push({
      field: "body",
      message: `Body exceeds the ${PLAYGROUND_REQUEST_BODY_MAX_BYTES}-byte workbench limit.`,
    });
  }
  if (operation.maxBodyBytes !== undefined && bytes > operation.maxBodyBytes) {
    issues.push({
      field: "body",
      message: `Body is ${bytes} bytes; this route allows ${operation.maxBodyBytes}.`,
    });
  }
  if (exceedsWorkbenchLimit) return;
  if (operation.requestBody?.selectedMediaType?.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(body);
      const keyScanIssue = jsonKeyScanIssue(body);
      if (keyScanIssue) {
        issues.push({ field: "body", message: keyScanIssue });
        return;
      }
      const numericIssue = jsonNumericPrecisionIssue(body);
      if (numericIssue) {
        issues.push({ field: "body", message: numericIssue });
        return;
      }
      const schema = operation.requestBody.schema;
      if (schema !== undefined) {
        for (const message of schemaValidationMessages(
          schema,
          parsed,
          "$",
          "body",
        )) {
          issues.push({ field: "body", name: "$", message });
        }
      }
    } catch (error) {
      issues.push({
        field: "body",
        message:
          error instanceof Error ? error.message : "Body is not valid JSON.",
      });
    }
  }
}

interface JSONContainerScan {
  kind: "array" | "object";
  expectingKey: boolean;
  keys?: Set<string>;
}

function jsonKeyScanIssue(body: string): string | null {
  const stack: JSONContainerScan[] = [];
  let keyCount = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '"') {
      const start = index;
      index += 1;
      for (; index < body.length; index += 1) {
        if (body[index] === "\\") {
          index += 1;
        } else if (body[index] === '"') {
          break;
        }
      }
      const container = stack.at(-1);
      if (container?.kind === "object" && container.expectingKey) {
        keyCount += 1;
        if (keyCount > JSON_KEY_SCAN_MAX_KEYS) {
          return "Request body exceeds the safe JSON object-key budget.";
        }
        let key: string;
        try {
          key = JSON.parse(body.slice(start, index + 1)) as string;
        } catch {
          return "Request body object keys could not be inspected safely.";
        }
        const keys = container.keys!;
        if (keys.has(key)) {
          return "Request body contains a duplicate JSON object key.";
        }
        keys.add(key);
        container.expectingKey = false;
      }
      continue;
    }
    if (character === "{" || character === "[") {
      if (stack.length >= JSON_KEY_SCAN_MAX_DEPTH) {
        return "Request body exceeds the safe JSON nesting budget.";
      }
      stack.push(
        character === "{"
          ? { kind: "object", expectingKey: true, keys: new Set() }
          : { kind: "array", expectingKey: false },
      );
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const container = stack.at(-1);
      if (container?.kind === "object") container.expectingKey = true;
    }
  }
  return null;
}

function jsonNumericPrecisionIssue(body: string): string | null {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character !== "-" && (character < "0" || character > "9")) {
      continue;
    }
    const match = body
      .slice(index)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    const token = match?.[0];
    if (!token) continue;
    if (jsonNumberExceedsSafePrecision(token)) {
      return "Request body contains a number outside the safe numeric precision boundary.";
    }
    index += token.length - 1;
  }
  return null;
}

function jsonNumberExceedsSafePrecision(token: string): boolean {
  if (!Number.isFinite(Number(token))) return true;
  const match = token.match(
    /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/,
  );
  if (!match) return true;
  const fraction = match[2] ?? "";
  const exponentText = match[3] ?? "0";
  if (exponentText.replace(/^[+-]?0*/, "").length > 6) {
    return !/^0+$/.test(`${match[1]}${fraction}`);
  }
  const exponent = Number(exponentText);
  const coefficient = `${match[1]}${fraction}`.replace(/^0+/, "") || "0";
  if (coefficient === "0") return false;
  const scale = exponent - fraction.length;
  let integerDigits: string | null = null;
  if (scale >= 0) {
    if (coefficient.length + scale > 16) return true;
    integerDigits = `${coefficient}${"0".repeat(scale)}`;
  } else {
    const divisorZeros = -scale;
    if (
      divisorZeros <= coefficient.length &&
      coefficient.endsWith("0".repeat(divisorZeros))
    ) {
      integerDigits = coefficient.slice(0, -divisorZeros) || "0";
    }
  }
  if (integerDigits !== null) {
    const normalized = integerDigits.replace(/^0+/, "") || "0";
    return (
      normalized.length > 16 ||
      (normalized.length === 16 && normalized > "9007199254740991")
    );
  }
  const significantDigits = coefficient
    .replace(/^0+/, "")
    .replace(/0+$/, "").length;
  return significantDigits > 15 || Math.abs(exponent) > 308;
}

function buildSafeURL(
  baseURL: string,
  resolvedPath: string,
  query: string,
  issues: PlaygroundValidationIssue[],
): string {
  const base = canonicalBase(baseURL);
  if (!base) {
    issues.push({
      field: "url",
      message: "Configured API authority is invalid.",
    });
    return "";
  }
  const basePath = base.pathname.replace(/\/$/, "");
  const expectedPath = `${basePath}${resolvedPath}`.replace(/\/{2,}/g, "/");
  const url = new URL(base.origin);
  url.pathname = expectedPath;
  url.search = query;
  if (url.origin !== base.origin || url.pathname !== expectedPath) {
    issues.push({
      field: "url",
      message: "Resolved request escaped the configured API authority.",
    });
    return "";
  }
  return url.toString();
}

export function buildPlaygroundRequest(
  baseURL: string,
  operation: NormalizedPlaygroundOperation,
  policy: PlaygroundExecutionPolicy,
  values: PlaygroundRequestValues,
): BuiltPlaygroundRequest {
  const issues: PlaygroundValidationIssue[] = [];
  if (!policy.executable) {
    issues.push({
      field: "catalog",
      message: policy.reason ?? "This operation is reference-only.",
    });
  }
  const resolvedPath = pathWithValues(operation, values.path, issues);
  const query = appendQuery(operation, values.query, issues);
  const headers = requestHeaders(operation, policy, values, issues);
  validateHeaderAggregate(headers, issues);
  validateBody(operation, values.body, issues);
  const url = buildSafeURL(baseURL, resolvedPath, query, issues);
  const body = values.body.trim() ? values.body : "";
  const snippetAllowed = policy.executable && issues.length === 0;
  return {
    issues,
    resolvedPath,
    plan: Object.freeze({
      method: operation.method,
      url,
      headers: Object.freeze({ ...headers }),
      body,
      bodyIsJSON: Boolean(
        body && operation.requestBody?.selectedMediaType?.includes("json"),
      ),
      authMode: policy.authMode,
      snippetAllowed,
      snippetUnavailableReason: !policy.executable
        ? policy.reason
        : snippetAllowed
          ? undefined
          : "Request validation must pass before code generation.",
    }),
  };
}

export function firstIssueMessage(
  issues: PlaygroundValidationIssue[],
): string | null {
  return issues[0]?.message ?? null;
}
