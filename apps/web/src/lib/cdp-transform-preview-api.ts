// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const MAX_PROPERTIES_BYTES = 256 * 1024;
const MAX_OPERATIONS_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 768 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_OPERATIONS = 100;
const MAX_FIELD_BYTES = 256;
const MAX_FIELD_DEPTH = 16;
const MAX_OPERATION_NAME_BYTES = 64;
const MAX_ERROR_BYTES = 4_096;
const DANGEROUS_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export interface CDPTransformOperation {
  type: string;
  field: string;
  args?: Record<string, unknown>;
}

export interface CDPTransformResult {
  op: CDPTransformOperation;
  changed: boolean;
  oldValue?: unknown;
  newValue?: unknown;
  error: string | null;
}

export interface CDPTransformPreview {
  properties: Record<string, unknown>;
  results: CDPTransformResult[];
  success: number;
  failed: number;
}

export interface ParsedTransformDraft {
  properties: Record<string, unknown> | null;
  operations: CDPTransformOperation[] | null;
  propertiesError: string | null;
  operationsError: string | null;
}

export const SAMPLE_CDP_PROPERTIES = `{
  "email": "  Ada.Lovelace+news@gmail.com ",
  "first_name": "ada",
  "address": { "country": "united kingdom" },
  "ltv_cents": "12900"
}`;

export const SAMPLE_CDP_OPERATIONS = `[
  { "type": "trim", "field": "email" },
  { "type": "email_normalize", "field": "email" },
  { "type": "title_case", "field": "first_name" },
  { "type": "country_iso2", "field": "address.country" },
  { "type": "coerce_number", "field": "ltv_cents" }
]`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > maxBytes ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`Invalid transform ${label}`);
  }
  return value;
}

function scanJSONDepth(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return false;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inString;
}

function validateJSONValue(
  value: unknown,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error("JSON exceeds the interactive preview complexity bound");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJSONValue(item, depth + 1, state);
    return;
  }
  if (!record(value)) throw new Error("JSON contains an unsupported value");
  for (const [key, child] of Object.entries(value)) {
    if (
      !key ||
      utf8Bytes(key) > MAX_FIELD_BYTES ||
      DANGEROUS_SEGMENTS.has(key)
    ) {
      throw new Error(`Unsafe or oversized JSON key: ${key || "(empty)"}`);
    }
    validateJSONValue(child, depth + 1, state);
  }
}

function parseObjectJSON(text: string): Record<string, unknown> {
  if (!text.trim()) throw new Error("Provide a properties JSON object.");
  if (utf8Bytes(text) > MAX_PROPERTIES_BYTES) {
    throw new Error("Properties JSON must be 256 KiB or smaller.");
  }
  if (!scanJSONDepth(text)) {
    throw new Error(`Properties JSON must be valid and at most ${MAX_JSON_DEPTH} levels deep.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Properties must be valid JSON.");
  }
  if (!record(parsed)) throw new Error("Properties must be a JSON object.");
  validateJSONValue(parsed);
  return parsed;
}

function sameOperation(
  left: CDPTransformOperation,
  right: CDPTransformOperation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseOperation(value: unknown, index: number): CDPTransformOperation {
  if (!record(value)) throw new Error(`Operation ${index + 1} must be an object.`);
  const allowedKeys = new Set(["type", "field", "args"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Operation ${index + 1} contains an unsupported field.`);
  }
  const type = boundedText(
    value.type,
    `operation ${index + 1} type`,
    MAX_OPERATION_NAME_BYTES,
  ).trim();
  if (!/^[a-z][a-z0-9_]*$/u.test(type)) {
    throw new Error(`Operation ${index + 1} has an invalid type.`);
  }
  const field = boundedText(
    value.field,
    `operation ${index + 1} field`,
    MAX_FIELD_BYTES,
  ).trim();
  const path = field.split(".");
  if (
    path.length > MAX_FIELD_DEPTH ||
    path.some(
      (segment) =>
        !segment ||
        DANGEROUS_SEGMENTS.has(segment) ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new Error(`Operation ${index + 1} has an unsafe field path.`);
  }
  let args: Record<string, unknown> | undefined;
  if (value.args !== undefined) {
    if (!record(value.args)) {
      throw new Error(`Operation ${index + 1} args must be an object.`);
    }
    validateJSONValue(value.args);
    args = value.args;
  }
  validateKnownArguments(type, args, index);
  return { type, field, ...(args ? { args } : {}) };
}

function validateKnownArguments(
  type: string,
  args: Record<string, unknown> | undefined,
  index: number,
): void {
  const keys = Object.keys(args ?? {});
  const requireOnly = (allowed: readonly string[]) => {
    if (keys.some((key) => !allowed.includes(key))) {
      throw new Error(`Operation ${index + 1} has unsupported arguments for ${type}.`);
    }
  };
  switch (type) {
    case "truncate": {
      requireOnly(["max"]);
      const max = args?.max;
      if (!Number.isSafeInteger(max) || Number(max) < 0 || Number(max) > 1_000_000) {
        throw new Error(`Operation ${index + 1} requires an integer max from 0 to 1,000,000.`);
      }
      return;
    }
    case "default_value":
      requireOnly(["value"]);
      if (!args || !("value" in args)) {
        throw new Error(`Operation ${index + 1} requires a value argument.`);
      }
      return;
    case "phone_e164": {
      requireOnly(["default_country_code"]);
      const code = args?.default_country_code;
      if (code !== undefined && (typeof code !== "string" || !/^\d{1,3}$/u.test(code))) {
        throw new Error(`Operation ${index + 1} default_country_code must be 1–3 digits.`);
      }
      return;
    }
    case "regex_replace": {
      requireOnly(["pattern", "replacement"]);
      if (
        typeof args?.pattern !== "string" ||
        utf8Bytes(args.pattern) > 4_096 ||
        (args.replacement !== undefined &&
          (typeof args.replacement !== "string" ||
            utf8Bytes(args.replacement) > 8_192))
      ) {
        throw new Error(`Operation ${index + 1} requires a bounded pattern and optional replacement.`);
      }
      return;
    }
    default:
      return;
  }
}

function parseOperationsJSON(
  text: string,
  catalog: readonly string[],
): CDPTransformOperation[] {
  if (!text.trim()) throw new Error("Provide an operations JSON array.");
  if (utf8Bytes(text) > MAX_OPERATIONS_BYTES) {
    throw new Error("Operations JSON must be 128 KiB or smaller.");
  }
  if (!scanJSONDepth(text)) {
    throw new Error(`Operations JSON must be valid and at most ${MAX_JSON_DEPTH} levels deep.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Operations must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Operations must be a JSON array.");
  if (parsed.length === 0) throw new Error("Add at least one operation.");
  if (parsed.length > MAX_OPERATIONS) {
    throw new Error(`Use ${MAX_OPERATIONS} operations or fewer in one preview.`);
  }
  if (catalog.length === 0) {
    throw new Error("A verified operation catalog is required before preview.");
  }
  const registered = new Set(catalog);
  const operations = parsed.map(parseOperation);
  const unsupported = operations.find((operation) => !registered.has(operation.type));
  if (unsupported) {
    throw new Error(`Operation “${unsupported.type}” is not registered on this server.`);
  }
  return operations;
}

export function parseTransformDraft(
  propertiesText: string,
  operationsText: string,
  catalog: readonly string[],
): ParsedTransformDraft {
  let properties: Record<string, unknown> | null = null;
  let operations: CDPTransformOperation[] | null = null;
  let propertiesError: string | null = null;
  let operationsError: string | null = null;
  try {
    properties = parseObjectJSON(propertiesText);
  } catch (caught) {
    propertiesError = caught instanceof Error ? caught.message : "Invalid properties JSON.";
  }
  try {
    operations = parseOperationsJSON(operationsText, catalog);
  } catch (caught) {
    operationsError = caught instanceof Error ? caught.message : "Invalid operations JSON.";
  }
  return { properties, operations, propertiesError, operationsError };
}

export function formatTransformJSON(text: string, kind: "properties" | "operations"): string {
  const byteLimit = kind === "properties" ? MAX_PROPERTIES_BYTES : MAX_OPERATIONS_BYTES;
  if (utf8Bytes(text) > byteLimit || !scanJSONDepth(text)) {
    throw new Error(`${kind === "properties" ? "Properties" : "Operations"} JSON is too large, deep, or malformed.`);
  }
  try {
    const formatted = JSON.stringify(JSON.parse(text), null, 2);
    if (utf8Bytes(formatted) > byteLimit) throw new Error("Formatted JSON is too large.");
    return formatted;
  } catch (caught) {
    if (caught instanceof Error && caught.message === "Formatted JSON is too large.") throw caught;
    throw new Error("Cannot format invalid JSON.");
  }
}

export async function getCDPTransformOperations(
  options: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<string[]> {
  const response = await api.get<unknown>("/api/v1/cdp/transforms/ops", {
    signal: options.signal,
    ...(options.fresh
      ? { requireOnline: true, maxAttempts: 1, cache: "no-store" as const }
      : {}),
  });
  if (!record(response) || !Array.isArray(response.ops) || response.ops.length > 256) {
    throw new Error("Invalid transform operation catalog");
  }
  const ops = response.ops.map((value) =>
    boundedText(value, "operation name", MAX_OPERATION_NAME_BYTES).trim(),
  );
  if (
    new Set(ops).size !== ops.length ||
    ops.some((name) => !/^[a-z][a-z0-9_]*$/u.test(name))
  ) {
    throw new Error("Invalid transform operation catalog");
  }
  return ops;
}

function parsePreviewResponse(
  value: unknown,
  requested: readonly CDPTransformOperation[],
): CDPTransformPreview {
  if (!record(value) || !record(value.properties) || !Array.isArray(value.results)) {
    throw new Error("Invalid transform preview response");
  }
  validateJSONValue(value.properties);
  const serialized = JSON.stringify(value);
  if (utf8Bytes(serialized) > MAX_RESPONSE_BYTES || value.results.length !== requested.length) {
    throw new Error("Invalid transform preview response");
  }
  const results = value.results.map((candidate, index) => {
    if (!record(candidate) || typeof candidate.changed !== "boolean") {
      throw new Error("Invalid transform preview result");
    }
    const op = parseOperation(candidate.op, index);
    if (!sameOperation(op, requested[index] as CDPTransformOperation)) {
      throw new Error("Transform preview result did not match the requested operation order");
    }
    if (candidate.old_value !== undefined) validateJSONValue(candidate.old_value);
    if (candidate.new_value !== undefined) validateJSONValue(candidate.new_value);
    const error =
      candidate.error === undefined || candidate.error === null || candidate.error === ""
        ? null
        : boundedText(candidate.error, "result error", MAX_ERROR_BYTES);
    if (error && candidate.changed) {
      throw new Error("Invalid transform preview failure result");
    }
    return {
      op,
      changed: candidate.changed,
      ...(candidate.old_value !== undefined ? { oldValue: candidate.old_value } : {}),
      ...(candidate.new_value !== undefined ? { newValue: candidate.new_value } : {}),
      error,
    };
  });
  if (
    !Number.isSafeInteger(value.success) ||
    !Number.isSafeInteger(value.failed) ||
    Number(value.success) < 0 ||
    Number(value.failed) < 0 ||
    Number(value.success) + Number(value.failed) !== results.length ||
    Number(value.failed) !== results.filter((result) => result.error !== null).length
  ) {
    throw new Error("Invalid transform preview counters");
  }
  return {
    properties: value.properties,
    results,
    success: Number(value.success),
    failed: Number(value.failed),
  };
}

export async function previewCDPTransforms(
  input: {
    properties: Record<string, unknown>;
    operations: CDPTransformOperation[];
  },
  signal?: AbortSignal,
): Promise<CDPTransformPreview> {
  validateJSONValue(input.properties);
  if (input.operations.length < 1 || input.operations.length > MAX_OPERATIONS) {
    throw new Error("Invalid transform preview operation count");
  }
  const operations = input.operations.map(parseOperation);
  const body = { properties: input.properties, ops: operations };
  if (utf8Bytes(JSON.stringify(body)) > MAX_REQUEST_BYTES) {
    throw new Error("Transform preview request is too large.");
  }
  return parsePreviewResponse(
    await api.post<unknown>("/api/v1/cdp/transforms/preview", body, {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: null,
      signal,
    }),
    operations,
  );
}

export function formatTransformValue(value: unknown): string {
  if (value === undefined) return "—";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "—" : encoded;
}
