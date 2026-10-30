import type { ApiResult } from "./result";
import { OUTBOUND_WEBHOOK_EVENTS } from "./webhook-event-operations";

export interface WebhookPlaygroundEventCatalogEntry {
  event_type: string;
  sample_payload: Record<string, unknown>;
}

export interface WebhookPlaygroundEventCatalogResponse {
  events: WebhookPlaygroundEventCatalogEntry[];
}

export interface WebhookPlaygroundFireResponse {
  fire_id: string;
  event_id: string;
  delivery_id: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: unknown;
  signature: string;
  requested_at: string;
  status_code: number;
  response_body: string;
  latency_ms: number;
  error?: string;
  filtered: boolean;
  outcome: "filtered" | "receiver_responded" | "transport_ambiguous";
  ambiguous: boolean;
  response_body_truncated: boolean;
  redacted_header_count?: number;
  redacted_response_count?: number;
  redacted_url_count?: number;
  redacted_body_count?: number;
}

export interface WebhookPlaygroundFireReceipt {
  fire_id: string;
  webhook_id: string;
  event_type: string;
  delivery_id: string;
  state: "pending" | "completed" | "ambiguous" | "receipt_expired";
  outcome: "" | "filtered" | "receiver_responded" | "transport_ambiguous";
  receiver_status_code: number;
  response_body_truncated: boolean;
  created_at: string;
  completed_at: string | null;
}

class WebhookPlaygroundContractError extends Error {}
const MAX_EVENT_SAMPLE_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 20_000;
const MAX_OBJECT_FIELDS = 2_000;
const MAX_KEY_BYTES = 256;
const MAX_STRING_BYTES = 128 * 1024;
const textEncoder = new TextEncoder();
const rawJSONNumberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredUUID(record: Record<string, unknown>, field: string): string {
  const value = requiredString(record, field);
  if (!canonicalUuidPattern.test(value)) {
    throw new WebhookPlaygroundContractError(
      `response.${field} must be a canonical lowercase UUID`,
    );
  }
  return value;
}

function requiredBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new WebhookPlaygroundContractError(
      `response.${field} must be a boolean`,
    );
  }
  return value;
}

function asRecord(value: unknown, field = "response"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebhookPlaygroundContractError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedJSONObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  const root = asRecord(value, field);
  let encoded: string;
  try {
    encoded = JSON.stringify(root);
  } catch {
    throw new WebhookPlaygroundContractError(`${field} must be JSON-safe`);
  }
  if (textEncoder.encode(encoded).byteLength > MAX_EVENT_SAMPLE_BYTES) {
    throw new WebhookPlaygroundContractError(
      `${field} exceeds the ${MAX_EVENT_SAMPLE_BYTES}-byte JSON limit`,
    );
  }
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 1 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new WebhookPlaygroundContractError(
        `${field} exceeds the JSON depth or node limit`,
      );
    }
    if (typeof current.value === "string") {
      if (textEncoder.encode(current.value).byteLength > MAX_STRING_BYTES) {
        throw new WebhookPlaygroundContractError(
          `${field} contains an oversized string`,
        );
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new WebhookPlaygroundContractError(`${field} must not be cyclic`);
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    const entries = Object.entries(current.value as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_FIELDS) {
      throw new WebhookPlaygroundContractError(
        `${field} contains too many object fields`,
      );
    }
    for (const [key, child] of entries) {
      if (
        key.length === 0 ||
        textEncoder.encode(key).byteLength > MAX_KEY_BYTES ||
        /[\u0000-\u001f\u007f]/u.test(key)
      ) {
        throw new WebhookPlaygroundContractError(
          `${field} contains an invalid object key`,
        );
      }
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return root;
}

/**
 * Applies the exact JSON bounds shared by catalog samples, custom fire input,
 * and inspectable response bodies. The editor uses this before confirmation so
 * an operator never reviews a request the API is guaranteed to reject.
 */
export function validateWebhookPlaygroundJSONObject(
  value: unknown,
  field = "payload",
): Record<string, unknown> {
  return boundedJSONObject(value, field);
}

export interface ValidatedWebhookPlaygroundRawJSONObject {
  /** Exact caller-provided JSON text, retained without normalization. */
  readonly rawJSON: string;
  /** Disposable parsed copy for editor/UI inspection only. */
  readonly parsed: Record<string, unknown>;
}

interface RawJSONScanState {
  readonly field: string;
  readonly raw: string;
  index: number;
  nodes: number;
}

function rawJSONError(state: RawJSONScanState, detail: string): never {
  throw new WebhookPlaygroundContractError(`${state.field} ${detail}`);
}

function rawJSONIsWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function skipRawJSONWhitespace(state: RawJSONScanState): void {
  while (
    state.index < state.raw.length &&
    (state.raw[state.index] === " " ||
      state.raw[state.index] === "\t" ||
      state.raw[state.index] === "\n" ||
      state.raw[state.index] === "\r")
  ) {
    state.index += 1;
  }
}

function scanRawJSONString(
  state: RawJSONScanState,
  kind: "key" | "value",
): string {
  if (state.raw[state.index] !== '"') {
    rawJSONError(state, "must contain valid JSON strings");
  }
  state.index += 1;
  let decoded = "";
  while (state.index < state.raw.length) {
    const character = state.raw[state.index];
    state.index += 1;
    if (character === '"') {
      const bytes = textEncoder.encode(decoded).byteLength;
      if (
        (kind === "key" &&
          (decoded.length === 0 ||
            bytes > MAX_KEY_BYTES ||
            /[\u0000-\u001f\u007f]/u.test(decoded))) ||
        (kind === "value" && bytes > MAX_STRING_BYTES)
      ) {
        rawJSONError(state, `contains an invalid or oversized ${kind}`);
      }
      return decoded;
    }
    if (character === undefined || character.charCodeAt(0) <= 0x1f) {
      rawJSONError(state, "contains an invalid JSON string");
    }
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = state.raw[state.index];
    state.index += 1;
    switch (escape) {
      case '"':
      case "\\":
      case "/":
        decoded += escape;
        break;
      case "b":
        decoded += "\b";
        break;
      case "f":
        decoded += "\f";
        break;
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "u": {
        const hex = state.raw.slice(state.index, state.index + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
          rawJSONError(state, "contains an invalid Unicode escape");
        }
        const codeUnit = Number.parseInt(hex, 16);
        state.index += 4;
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const lowEscape = state.raw.slice(state.index, state.index + 6);
          const lowHex = lowEscape.slice(2);
          if (lowEscape.startsWith("\\u") && /^[0-9a-fA-F]{4}$/u.test(lowHex)) {
            const lowCodeUnit = Number.parseInt(lowHex, 16);
            if (lowCodeUnit >= 0xdc00 && lowCodeUnit <= 0xdfff) {
              decoded += String.fromCharCode(codeUnit, lowCodeUnit);
              state.index += 6;
              break;
            }
          }
          // Go encoding/json replaces an escaped unpaired surrogate with
          // U+FFFD. Mirror that before duplicate-key comparison so equivalent
          // member names cannot disagree across client and server.
          decoded += "\ufffd";
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
          decoded += "\ufffd";
        } else {
          decoded += String.fromCharCode(codeUnit);
        }
        break;
      }
      default:
        rawJSONError(state, "contains an invalid JSON escape");
    }
  }
  return rawJSONError(state, "contains an unterminated JSON string");
}

function scanRawJSONNumber(state: RawJSONScanState): void {
  rawJSONNumberPattern.lastIndex = state.index;
  const match = rawJSONNumberPattern.exec(state.raw);
  if (!match) rawJSONError(state, "contains an invalid JSON number");
  state.index = rawJSONNumberPattern.lastIndex;
}

function scanRawJSONLiteral(
  state: RawJSONScanState,
  literal: "false" | "null" | "true",
): void {
  if (state.raw.slice(state.index, state.index + literal.length) !== literal) {
    rawJSONError(state, "contains an invalid JSON literal");
  }
  state.index += literal.length;
}

function scanRawJSONArray(state: RawJSONScanState, depth: number): void {
  state.index += 1;
  skipRawJSONWhitespace(state);
  if (state.raw[state.index] === "]") {
    state.index += 1;
    return;
  }
  while (state.index < state.raw.length) {
    scanRawJSONValue(state, depth + 1);
    skipRawJSONWhitespace(state);
    const separator = state.raw[state.index];
    state.index += 1;
    if (separator === "]") return;
    if (separator !== ",") {
      rawJSONError(state, "contains an invalid JSON array");
    }
    skipRawJSONWhitespace(state);
  }
  rawJSONError(state, "contains an unterminated JSON array");
}

function scanRawJSONObject(state: RawJSONScanState, depth: number): void {
  state.index += 1;
  skipRawJSONWhitespace(state);
  if (state.raw[state.index] === "}") {
    state.index += 1;
    return;
  }
  const names = new Set<string>();
  let fields = 0;
  while (state.index < state.raw.length) {
    const name = scanRawJSONString(state, "key");
    fields += 1;
    if (fields > MAX_OBJECT_FIELDS) {
      rawJSONError(state, "contains too many object fields");
    }
    if (names.has(name)) {
      rawJSONError(state, "contains duplicate object member names");
    }
    names.add(name);
    skipRawJSONWhitespace(state);
    if (state.raw[state.index] !== ":") {
      rawJSONError(state, "contains an object member without a value");
    }
    state.index += 1;
    skipRawJSONWhitespace(state);
    scanRawJSONValue(state, depth + 1);
    skipRawJSONWhitespace(state);
    const separator = state.raw[state.index];
    state.index += 1;
    if (separator === "}") return;
    if (separator !== ",") {
      rawJSONError(state, "contains an invalid JSON object");
    }
    skipRawJSONWhitespace(state);
  }
  rawJSONError(state, "contains an unterminated JSON object");
}

function scanRawJSONValue(state: RawJSONScanState, depth: number): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    rawJSONError(state, "exceeds the JSON depth or node limit");
  }
  const token = state.raw[state.index];
  if (token === "{") {
    scanRawJSONObject(state, depth);
  } else if (token === "[") {
    scanRawJSONArray(state, depth);
  } else if (token === '"') {
    scanRawJSONString(state, "value");
  } else if (token === "t") {
    scanRawJSONLiteral(state, "true");
  } else if (token === "f") {
    scanRawJSONLiteral(state, "false");
  } else if (token === "n") {
    scanRawJSONLiteral(state, "null");
  } else if (token === "-" || (token !== undefined && /[0-9]/u.test(token))) {
    scanRawJSONNumber(state);
  } else {
    rawJSONError(state, "contains an invalid JSON value");
  }
}

function rejectDuplicateRawJSONMembers(rawJSON: string, field: string): void {
  const state: RawJSONScanState = { field, raw: rawJSON, index: 0, nodes: 0 };
  skipRawJSONWhitespace(state);
  if (state.raw[state.index] !== "{") {
    rawJSONError(state, "must have a JSON object root");
  }
  scanRawJSONValue(state, 1);
  skipRawJSONWhitespace(state);
  if (state.index !== state.raw.length) {
    rawJSONError(state, "contains trailing non-JSON content");
  }
}

/**
 * Validates exact custom-fire JSON without normalizing it. In addition to the
 * shared payload bounds, this rejects duplicate member names at every object
 * depth after JSON escape decoding (for example, `"a"` and `"\\u0061"`).
 */
export function validateWebhookPlaygroundRawJSONObject(
  rawJSON: unknown,
  field = "payload",
): ValidatedWebhookPlaygroundRawJSONObject {
  if (
    typeof rawJSON !== "string" ||
    rawJSON.trim().length === 0 ||
    !rawJSONIsWellFormedUnicode(rawJSON) ||
    textEncoder.encode(rawJSON).byteLength > MAX_EVENT_SAMPLE_BYTES
  ) {
    throw new WebhookPlaygroundContractError(
      `${field} must be nonempty JSON within ${MAX_EVENT_SAMPLE_BYTES} UTF-8 bytes`,
    );
  }
  rejectDuplicateRawJSONMembers(rawJSON, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJSON) as unknown;
  } catch {
    throw new WebhookPlaygroundContractError(`${field} must be valid JSON`);
  }
  return {
    rawJSON,
    parsed: boundedJSONObject(parsed, field),
  };
}

function exactRecord(
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  const record = asRecord(value, field);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new WebhookPlaygroundContractError(
      `${field}.${unexpected} is not part of the published contract`,
    );
  }
  return record;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new WebhookPlaygroundContractError(
      `response.${field} must be a string`,
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WebhookPlaygroundContractError(
      `response.${field} must be a string when present`,
    );
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  field: string,
  minimum: number,
): number {
  const value = record[field];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new WebhookPlaygroundContractError(
      `response.${field} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function optionalCount(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  if (record[field] === undefined) return undefined;
  return requiredInteger(record, field, 0);
}

function stringHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value, "response.headers");
  if (Object.keys(record).length > 128) {
    throw new WebhookPlaygroundContractError(
      "response.headers must contain at most 128 fields",
    );
  }
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, headerValue] of Object.entries(record)) {
    if (
      name.length === 0 ||
      name.length > 256 ||
      typeof headerValue !== "string" ||
      headerValue.length > 8192
    ) {
      throw new WebhookPlaygroundContractError(
        `response.headers.${name || "<empty>"} must be a bounded string field`,
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function decodeFiltered(record: Record<string, unknown>): boolean {
  const value = record.filtered;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new WebhookPlaygroundContractError(
      "response.filtered must be a boolean when present",
    );
  }
  return value;
}

function assertInspectableURL(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return;
  } catch {
    // The shared contract error below is more useful than URL's exception.
  }
  throw new WebhookPlaygroundContractError(
    "response.url must be an HTTP or HTTPS URL",
  );
}

function assertSemanticConsistency(
  response: WebhookPlaygroundFireResponse,
): void {
  if (response.filtered) {
    if (
      response.status_code !== 204 ||
      response.signature !== "" ||
      response.response_body !== "" ||
      response.error !== undefined ||
      Object.keys(response.headers).length > 0 ||
      response.outcome !== "filtered" ||
      response.ambiguous ||
      response.response_body_truncated
    ) {
      throw new WebhookPlaygroundContractError(
        "a filtered response must be an unsigned HTTP 204 outcome with no receiver request or output",
      );
    }
    return;
  }
  if (
    response.ambiguous !== (response.outcome === "transport_ambiguous") ||
    (response.outcome === "transport_ambiguous" &&
      response.status_code !== 0) ||
    (response.outcome === "receiver_responded" && response.status_code === 0)
  ) {
    throw new WebhookPlaygroundContractError(
      "response outcome, ambiguity, and receiver status are inconsistent",
    );
  }
  if (response.response_body_truncated && response.response_body !== "") {
    throw new WebhookPlaygroundContractError(
      "a truncated receiver response must withhold its partial body",
    );
  }
  if (!response.signature.trim()) {
    throw new WebhookPlaygroundContractError(
      "response.signature is required when a receiver request was made",
    );
  }
  if (response.status_code === 0 && !response.error?.trim()) {
    throw new WebhookPlaygroundContractError(
      "response.error is required when no receiver status was returned",
    );
  }
}

export function decodeWebhookPlaygroundFireResponse(
  value: unknown,
): WebhookPlaygroundFireResponse {
  const record = exactRecord(value, "response", [
    "fire_id",
    "event_id",
    "delivery_id",
    "url",
    "method",
    "headers",
    "body",
    "signature",
    "requested_at",
    "status_code",
    "response_body",
    "latency_ms",
    "error",
    "filtered",
    "outcome",
    "ambiguous",
    "response_body_truncated",
    "redacted_header_count",
    "redacted_response_count",
    "redacted_url_count",
    "redacted_body_count",
  ]);
  if (!Object.hasOwn(record, "body")) {
    throw new WebhookPlaygroundContractError("response.body is required");
  }
  const fireId = requiredUUID(record, "fire_id");
  const eventId = requiredUUID(record, "event_id");
  const deliveryId = requiredString(record, "delivery_id");
  if (deliveryId !== `playground-${fireId}`) {
    throw new WebhookPlaygroundContractError(
      "response.delivery_id must be bound to response.fire_id",
    );
  }
  const url = requiredString(record, "url");
  assertInspectableURL(url);
  const method = requiredString(record, "method");
  if (method !== "POST") {
    throw new WebhookPlaygroundContractError(
      "response.method must be exactly POST",
    );
  }
  const requestedAt = requiredString(record, "requested_at");
  if (!Number.isFinite(Date.parse(requestedAt))) {
    throw new WebhookPlaygroundContractError(
      "response.requested_at must be a valid timestamp",
    );
  }
  const statusCode = requiredInteger(record, "status_code", 0);
  if (statusCode > 599) {
    throw new WebhookPlaygroundContractError(
      "response.status_code must be less than or equal to 599",
    );
  }
  const response: WebhookPlaygroundFireResponse = {
    fire_id: fireId,
    event_id: eventId,
    delivery_id: deliveryId,
    url,
    method,
    headers: stringHeaders(record.headers),
    body: boundedJSONObject(record.body, "response.body"),
    signature: requiredString(record, "signature"),
    requested_at: requestedAt,
    status_code: statusCode,
    response_body: requiredString(record, "response_body"),
    latency_ms: requiredInteger(record, "latency_ms", 0),
    filtered: decodeFiltered(record),
    outcome: (() => {
      const outcome = requiredString(record, "outcome");
      if (
        outcome !== "filtered" &&
        outcome !== "receiver_responded" &&
        outcome !== "transport_ambiguous"
      ) {
        throw new WebhookPlaygroundContractError(
          "response.outcome is outside the published fire lifecycle",
        );
      }
      return outcome;
    })(),
    ambiguous: requiredBoolean(record, "ambiguous"),
    response_body_truncated: requiredBoolean(record, "response_body_truncated"),
  };
  const error = optionalString(record, "error");
  if (error !== undefined) response.error = error;
  for (const field of [
    "redacted_header_count",
    "redacted_response_count",
    "redacted_url_count",
    "redacted_body_count",
  ] as const) {
    const count = optionalCount(record, field);
    if (count !== undefined) response[field] = count;
  }
  assertSemanticConsistency(response);
  return response;
}

export function decodeWebhookPlaygroundFireResult(
  result: ApiResult<unknown>,
  expectedFireId?: string,
): ApiResult<WebhookPlaygroundFireResponse> {
  if (result.error) {
    if (
      result.error.status === 410 &&
      result.error.code === "playground_fire_receipt_expired"
    ) {
      const details = result.error.details;
      if (
        expectedFireId &&
        details?.fire_id === expectedFireId &&
        details.state === "receipt_expired"
      ) {
        return result;
      }
      return {
        error: {
          kind: "parse",
          code: "webhook_playground_contract",
          message:
            "Moosewave returned an expiry tombstone that was not bound to the requested logical fire. The live-delivery outcome is ambiguous; reconcile the retained fire ID before creating another attempt.",
        },
        retryability: "not-retryable",
      };
    }
    return result;
  }
  try {
    const data = decodeWebhookPlaygroundFireResponse(result.data);
    if (expectedFireId && data.fire_id !== expectedFireId) {
      throw new WebhookPlaygroundContractError(
        "response.fire_id does not match the requested logical fire",
      );
    }
    return {
      data,
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof WebhookPlaygroundContractError
        ? error.message
        : "response did not match the webhook playground contract";
    return {
      error: {
        kind: "parse",
        code: "webhook_playground_contract",
        message: `Moosewave returned malformed webhook playground data (${detail}). The live-delivery outcome is ambiguous; reconcile the retained fire ID before creating another attempt.`,
      },
      retryability: "not-retryable",
    };
  }
}

const historicalEventTypePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

/**
 * Validates a frozen event token without consulting the current outbound
 * catalog. Receipts and recovery checkpoints must remain readable after a
 * formerly valid event is removed from that catalog.
 */
export function validateWebhookPlaygroundHistoricalEventType(
  value: unknown,
  field = "event_type",
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    textEncoder.encode(value).byteLength > 200 ||
    !historicalEventTypePattern.test(value)
  ) {
    throw new WebhookPlaygroundContractError(
      `${field} must be a bounded canonical event token`,
    );
  }
  return value;
}

function boundedEventType(value: unknown, index: number): string {
  const eventType = validateWebhookPlaygroundHistoricalEventType(
    value,
    `response.events[${index}].event_type`,
  );
  if (!(OUTBOUND_WEBHOOK_EVENTS as readonly string[]).includes(eventType)) {
    throw new WebhookPlaygroundContractError(
      `response.events[${index}].event_type is not in the canonical outbound webhook catalog`,
    );
  }
  return eventType;
}

export function decodeWebhookPlaygroundEventCatalog(
  value: unknown,
): WebhookPlaygroundEventCatalogResponse {
  const record = exactRecord(value, "response", ["events"]);
  if (!Array.isArray(record.events) || record.events.length > 500) {
    throw new WebhookPlaygroundContractError(
      "response.events must be an array of at most 500 entries",
    );
  }
  const seen = new Set<string>();
  const events = record.events.map((item, index) => {
    const entry = exactRecord(item, `response.events[${index}]`, [
      "event_type",
      "sample_payload",
    ]);
    const eventType = boundedEventType(entry.event_type, index);
    if (seen.has(eventType)) {
      throw new WebhookPlaygroundContractError(
        `response.events contains duplicate event_type ${eventType}`,
      );
    }
    seen.add(eventType);
    const samplePayload = boundedJSONObject(
      entry.sample_payload,
      `response.events[${index}].sample_payload`,
    );
    return {
      event_type: eventType,
      sample_payload: samplePayload,
    };
  });
  return { events };
}

export function decodeWebhookPlaygroundFireReceipt(
  value: unknown,
): WebhookPlaygroundFireReceipt {
  const record = exactRecord(value, "response", [
    "fire_id",
    "webhook_id",
    "event_type",
    "delivery_id",
    "state",
    "outcome",
    "receiver_status_code",
    "response_body_truncated",
    "created_at",
    "completed_at",
  ]);
  const fireId = requiredUUID(record, "fire_id");
  const webhookId = requiredUUID(record, "webhook_id");
  const deliveryId = requiredString(record, "delivery_id");
  if (deliveryId !== `playground-${fireId}`) {
    throw new WebhookPlaygroundContractError(
      "response.delivery_id must be bound to response.fire_id",
    );
  }
  const eventType = validateWebhookPlaygroundHistoricalEventType(
    record.event_type,
    "response.event_type",
  );
  const state = requiredString(record, "state");
  if (
    state !== "pending" &&
    state !== "completed" &&
    state !== "ambiguous" &&
    state !== "receipt_expired"
  ) {
    throw new WebhookPlaygroundContractError(
      "response.state is outside the published fire lifecycle",
    );
  }
  const outcome = requiredString(record, "outcome");
  if (
    outcome !== "" &&
    outcome !== "filtered" &&
    outcome !== "receiver_responded" &&
    outcome !== "transport_ambiguous"
  ) {
    throw new WebhookPlaygroundContractError(
      "response.outcome is outside the published fire lifecycle",
    );
  }
  const statusCode = requiredInteger(record, "receiver_status_code", 0);
  if (statusCode > 599) {
    throw new WebhookPlaygroundContractError(
      "response.receiver_status_code must not exceed 599",
    );
  }
  const createdAt = requiredString(record, "created_at");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new WebhookPlaygroundContractError(
      "response.created_at must be a valid timestamp",
    );
  }
  const completedRaw = record.completed_at;
  if (
    completedRaw !== null &&
    (typeof completedRaw !== "string" ||
      !Number.isFinite(Date.parse(completedRaw)))
  ) {
    throw new WebhookPlaygroundContractError(
      "response.completed_at must be a timestamp or null",
    );
  }
  if (
    (state === "pending" && (outcome !== "" || completedRaw !== null)) ||
    (state !== "pending" && (outcome === "" || completedRaw === null)) ||
    (state === "completed" &&
      outcome !== "filtered" &&
      outcome !== "receiver_responded") ||
    (state === "ambiguous" && outcome !== "transport_ambiguous") ||
    (outcome === "filtered" && statusCode !== 204) ||
    (outcome === "receiver_responded" &&
      (statusCode < 100 || statusCode > 599)) ||
    (outcome === "transport_ambiguous" && statusCode !== 0) ||
    (state === "pending" &&
      (statusCode !== 0 || record.response_body_truncated !== false))
  ) {
    throw new WebhookPlaygroundContractError(
      "response fire receipt state is internally inconsistent",
    );
  }
  if (
    typeof completedRaw === "string" &&
    Date.parse(completedRaw) < Date.parse(createdAt)
  ) {
    throw new WebhookPlaygroundContractError(
      "response.completed_at must not precede response.created_at",
    );
  }
  return {
    fire_id: fireId,
    webhook_id: webhookId,
    event_type: eventType,
    delivery_id: deliveryId,
    state,
    outcome,
    receiver_status_code: statusCode,
    response_body_truncated: requiredBoolean(record, "response_body_truncated"),
    created_at: createdAt,
    completed_at: completedRaw,
  };
}

export function decodeWebhookPlaygroundFireReceiptResult(
  result: ApiResult<unknown>,
  expectedFireId?: string,
): ApiResult<WebhookPlaygroundFireReceipt> {
  if (result.error) return result;
  try {
    const data = decodeWebhookPlaygroundFireReceipt(result.data);
    if (expectedFireId && data.fire_id !== expectedFireId) {
      throw new WebhookPlaygroundContractError(
        "response.fire_id does not match the requested reconciliation identity",
      );
    }
    return {
      data,
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof WebhookPlaygroundContractError
        ? error.message
        : "response did not match the webhook fire receipt contract";
    return {
      error: {
        kind: "parse",
        code: "webhook_playground_receipt_contract",
        message: `Moosewave returned malformed webhook fire-reconciliation data (${detail}). Keep this fire blocked and inspect server evidence.`,
      },
      retryability: "not-retryable",
    };
  }
}

export function decodeWebhookPlaygroundEventCatalogResult(
  result: ApiResult<unknown>,
): ApiResult<WebhookPlaygroundEventCatalogResponse> {
  if (result.error) return result;
  try {
    return {
      data: decodeWebhookPlaygroundEventCatalog(result.data),
      ...(result.serverVersion ? { serverVersion: result.serverVersion } : {}),
    };
  } catch (error) {
    const detail =
      error instanceof WebhookPlaygroundContractError
        ? error.message
        : "response did not match the webhook event catalog contract";
    return {
      error: {
        kind: "parse",
        code: "webhook_playground_catalog_contract",
        message: `Moosewave returned malformed webhook event-catalog data (${detail}). Firing is disabled until a valid catalog is loaded.`,
      },
      retryability: "not-retryable",
    };
  }
}
