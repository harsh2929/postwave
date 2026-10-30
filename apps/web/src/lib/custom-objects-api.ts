// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Exact web contract for the tenant custom-object control plane.
 *
 * Every mutation is online-only, caller-idempotent, tenant-bound, and uses the
 * loaded monotonic version. Unknown/malformed response fields fail closed so a
 * cache mix-up or partial backend rollout never becomes editable UI state.
 */
import { api, ApiError } from "@/lib/api";

export const CUSTOM_OBJECT_STATUSES = [
  "active",
  "deprecated",
  "disabled",
] as const;
export type CustomObjectStatus = (typeof CUSTOM_OBJECT_STATUSES)[number];

export interface CustomObjectType {
  id: string;
  tenantId: string;
  key: string;
  label: string;
  primaryKey: string;
  schema: Record<string, unknown>;
  status: CustomObjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomObjectRecord {
  id: string;
  tenantId: string;
  objectTypeId: string;
  externalId: string;
  properties: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomObjectRecordPage {
  items: CustomObjectRecord[];
  limit: number;
  hasMore: boolean;
}

export interface CustomObjectAdminAuthority {
  tenantId: string;
  userId: string;
  role: "owner" | "admin";
}

export interface CustomObjectViolation {
  field: string;
  code: string;
  message: string;
}

export class CustomObjectContractError extends Error {
  readonly code = "custom_object_contract_error";

  constructor(
    message = "The custom-object service returned an invalid response.",
  ) {
    super(message);
    this.name = "CustomObjectContractError";
  }
}

export class CustomObjectInputError extends Error {
  readonly code = "custom_object_input_error";

  constructor(message: string) {
    super(message);
    this.name = "CustomObjectInputError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPE_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PROPERTY_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,95}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SAFE_VIOLATION_FIELD_RE =
  /^(?:\$|\$schema|\$properties|[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?)*)$/;
const MAX_TYPES = 5_000;
const MAX_RECORDS = 500;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_PROPERTIES_BYTES = 768 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_ITEMS = 1_024;
const MAX_JSON_STRING_BYTES = 64 * 1024;

const SAFE_VIOLATION_MESSAGES: Record<string, string> = {
  schema_parse_error: "The saved validation schema could not be read.",
  properties_parse_error: "The submitted properties could not be validated.",
  type_mismatch: "Use the value type required by this field.",
  enum_violation: "Choose one of the values allowed by this field.",
  min_length: "Enter a longer value.",
  max_length: "Enter a shorter value.",
  minimum: "Enter a value at or above the allowed minimum.",
  maximum: "Enter a value at or below the allowed maximum.",
  required: "Add this required field.",
  additional_property: "Remove this field; the schema does not allow it.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new CustomObjectContractError(`${label} is not a canonical UUID.`);
  }
  return value;
}

function inputUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) {
    throw new CustomObjectInputError(`${label} must be a canonical UUID.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const match = typeof value === "string" ? RFC3339_RE.exec(value) : null;
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth =
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
  if (
    typeof value !== "string" ||
    !match ||
    value.length > 64 ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new CustomObjectContractError(`${label} is not a valid timestamp.`);
  }
  return value;
}

function positiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CustomObjectContractError(`${label} is not a positive version.`);
  }
  return value as number;
}

function safeText(
  value: unknown,
  label: string,
  maxCharacters: number,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Array.from(value).length > maxCharacters ||
    utf8Bytes(value) > maxBytes ||
    CONTROL_RE.test(value)
  ) {
    throw new CustomObjectContractError(`${label} is invalid.`);
  }
  return value;
}

function assertInputText(
  value: string,
  label: string,
  maxCharacters: number,
  maxBytes: number,
): string {
  try {
    return safeText(value, label, maxCharacters, maxBytes);
  } catch {
    throw new CustomObjectInputError(
      `${label} must be trimmed, control-free text of at most ${maxCharacters.toLocaleString()} characters.`,
    );
  }
}

function safeTypeKey(value: unknown, label = "Type key"): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > 64 ||
    !TYPE_KEY_RE.test(value)
  ) {
    throw new CustomObjectContractError(`${label} is invalid.`);
  }
  return value;
}

function inputTypeKey(value: string, label = "Type key"): string {
  try {
    return safeTypeKey(value, label);
  } catch {
    throw new CustomObjectInputError(
      `${label} must start with a lowercase letter and use only lowercase letters, digits, or underscores (64 bytes maximum).`,
    );
  }
}

function safePropertyKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    utf8Bytes(value) > 96 ||
    !PROPERTY_KEY_RE.test(value)
  ) {
    throw new CustomObjectContractError(`${label} is invalid.`);
  }
  return value;
}

function inputPropertyKey(value: string, label: string): string {
  try {
    return safePropertyKey(value, label);
  } catch {
    throw new CustomObjectInputError(
      `${label} must start with a letter or underscore and use only letters, digits, underscores, or dashes (96 bytes maximum).`,
    );
  }
}

function cloneBoundedObject(
  value: unknown,
  label: string,
  maxBytes: number,
  maxDepth = MAX_JSON_DEPTH,
  maxNodes = MAX_JSON_NODES,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CustomObjectContractError(`${label} must be a JSON object.`);
  }
  let encoded: string;
  let decoded: unknown;
  try {
    encoded = JSON.stringify(value);
    decoded = JSON.parse(encoded);
  } catch {
    throw new CustomObjectContractError(`${label} is not serializable JSON.`);
  }
  if (utf8Bytes(encoded) > maxBytes) {
    throw new CustomObjectContractError(`${label} exceeds the supported size.`);
  }
  if (!isRecord(decoded)) {
    throw new CustomObjectContractError(`${label} must be a JSON object.`);
  }
  let budget = maxNodes;
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > maxDepth || --budget < 0) {
      throw new CustomObjectContractError(
        `${label} exceeds the supported depth or node count.`,
      );
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_JSON_ITEMS) {
        throw new CustomObjectContractError(
          `${label} contains an oversized array.`,
        );
      }
      return node.map((entry) => visit(entry, depth + 1));
    }
    if (isRecord(node)) {
      const keys = Object.keys(node);
      if (keys.length > MAX_JSON_ITEMS) {
        throw new CustomObjectContractError(
          `${label} contains an oversized object.`,
        );
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (key.length === 0 || utf8Bytes(key) > 96 || CONTROL_RE.test(key)) {
          throw new CustomObjectContractError(
            `${label} contains an unsafe key.`,
          );
        }
        Object.defineProperty(out, key, {
          value: visit(node[key], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
    if (typeof node === "string") {
      if (utf8Bytes(node) > MAX_JSON_STRING_BYTES) {
        throw new CustomObjectContractError(
          `${label} contains an oversized string.`,
        );
      }
      return node;
    }
    if (
      node === null ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      return node;
    }
    throw new CustomObjectContractError(`${label} contains a non-JSON value.`);
  };
  return visit(decoded, 0) as Record<string, unknown>;
}

function cloneBoundedInputObject(
  value: Record<string, unknown>,
  label: string,
  maxBytes: number,
  maxDepth = MAX_JSON_DEPTH,
  maxNodes = MAX_JSON_NODES,
): Record<string, unknown> {
  try {
    return cloneBoundedObject(value, label, maxBytes, maxDepth, maxNodes);
  } catch (error) {
    if (error instanceof CustomObjectContractError) {
      throw new CustomObjectInputError(error.message);
    }
    throw error;
  }
}

function parseStatus(value: unknown): CustomObjectStatus {
  if (!CUSTOM_OBJECT_STATUSES.includes(value as CustomObjectStatus)) {
    throw new CustomObjectContractError("Custom-object status is invalid.");
  }
  return value as CustomObjectStatus;
}

function parseType(value: unknown, expectedTenantId: string): CustomObjectType {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "tenantId",
      "key",
      "label",
      "primaryKey",
      "schema",
      "status",
      "version",
      "createdAt",
      "updatedAt",
    ])
  ) {
    throw new CustomObjectContractError("Custom-object type shape is invalid.");
  }
  const tenantId = canonicalUuid(value.tenantId, "Type tenant ID");
  if (tenantId !== expectedTenantId) {
    throw new CustomObjectContractError(
      "Custom-object type belongs to another workspace.",
    );
  }
  const createdAt = timestamp(value.createdAt, "Type createdAt");
  const updatedAt = timestamp(value.updatedAt, "Type updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new CustomObjectContractError(
      "Custom-object type timestamps are inverted.",
    );
  }
  return {
    id: canonicalUuid(value.id, "Type ID"),
    tenantId,
    key: safeTypeKey(value.key),
    label: safeText(value.label, "Type label", 256, 1_024),
    primaryKey: safePropertyKey(value.primaryKey, "Primary key"),
    schema: cloneBoundedObject(
      value.schema,
      "Schema",
      MAX_SCHEMA_BYTES,
      20,
      4_096,
    ),
    status: parseStatus(value.status),
    version: positiveVersion(value.version, "Type version"),
    createdAt,
    updatedAt,
  };
}

function parseObjectRecord(
  value: unknown,
  expectedTenantId: string,
  expectedTypeId?: string,
): CustomObjectRecord {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "tenantId",
      "objectTypeId",
      "externalId",
      "properties",
      "version",
      "createdAt",
      "updatedAt",
    ])
  ) {
    throw new CustomObjectContractError(
      "Custom-object record shape is invalid.",
    );
  }
  const tenantId = canonicalUuid(value.tenantId, "Record tenant ID");
  const objectTypeId = canonicalUuid(value.objectTypeId, "Record type ID");
  if (
    tenantId !== expectedTenantId ||
    (expectedTypeId && objectTypeId !== expectedTypeId)
  ) {
    throw new CustomObjectContractError(
      "Custom-object record identity does not match the request.",
    );
  }
  const createdAt = timestamp(value.createdAt, "Record createdAt");
  const updatedAt = timestamp(value.updatedAt, "Record updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new CustomObjectContractError(
      "Custom-object record timestamps are inverted.",
    );
  }
  return {
    id: canonicalUuid(value.id, "Record ID"),
    tenantId,
    objectTypeId,
    externalId: safeText(value.externalId, "External ID", 512, 2_048),
    properties: cloneBoundedObject(
      value.properties,
      "Record properties",
      MAX_PROPERTIES_BYTES,
    ),
    version: positiveVersion(value.version, "Record version"),
    createdAt,
    updatedAt,
  };
}

function parseTypeList(value: unknown, tenantId: string): CustomObjectType[] {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["items"]) ||
    !Array.isArray(value.items)
  ) {
    throw new CustomObjectContractError(
      "Custom-object type list shape is invalid.",
    );
  }
  if (value.items.length > MAX_TYPES) {
    throw new CustomObjectContractError(
      "Custom-object type list exceeds the client safety limit.",
    );
  }
  const seen = new Set<string>();
  const keys = new Set<string>();
  return value.items.map((candidate) => {
    const item = parseType(candidate, tenantId);
    if (seen.has(item.id) || keys.has(item.key)) {
      throw new CustomObjectContractError(
        "Custom-object type list contains duplicate identities.",
      );
    }
    seen.add(item.id);
    keys.add(item.key);
    return item;
  });
}

function parseRecordPage(
  value: unknown,
  tenantId: string,
  typeId: string,
  expectedLimit: number,
): CustomObjectRecordPage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["items", "limit", "hasMore"]) ||
    !Array.isArray(value.items) ||
    value.limit !== expectedLimit ||
    typeof value.hasMore !== "boolean" ||
    value.items.length > expectedLimit ||
    value.items.length > MAX_RECORDS
  ) {
    throw new CustomObjectContractError(
      "Custom-object record page shape is invalid.",
    );
  }
  const seen = new Set<string>();
  const naturalKeys = new Set<string>();
  const items = value.items.map((candidate) => {
    const record = parseObjectRecord(candidate, tenantId, typeId);
    if (seen.has(record.id) || naturalKeys.has(record.externalId)) {
      throw new CustomObjectContractError(
        "Custom-object record page contains duplicate identities.",
      );
    }
    seen.add(record.id);
    naturalKeys.add(record.externalId);
    return record;
  });
  return { items, limit: expectedLimit, hasMore: value.hasMore };
}

function assertAuthority(authority: CustomObjectAdminAuthority) {
  inputUuid(authority.tenantId, "Workspace ID");
  inputUuid(authority.userId, "User ID");
  if (authority.role !== "owner" && authority.role !== "admin") {
    throw new CustomObjectInputError(
      "Owner or administrator authority is required.",
    );
  }
}

function assertIdempotencyKey(value: string) {
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    CONTROL_RE.test(value) ||
    utf8Bytes(value) > 255
  ) {
    throw new CustomObjectInputError(
      "A stable, trimmed 1–255 byte idempotency key is required.",
    );
  }
}

function assertLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    throw new CustomObjectInputError(
      "Record limit must be a whole number from 1 to 500.",
    );
  }
}

function assertExpectedVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CustomObjectInputError(`${label} must be a positive version.`);
  }
  return value;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameJSON(left: unknown, right: unknown): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}

export async function listCustomObjectTypes(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<CustomObjectType[]> {
  inputUuid(input.tenantId, "Workspace ID");
  const response = await api.get<unknown>("/api/v1/custom-objects/types", {
    signal: input.signal,
  });
  return parseTypeList(response, input.tenantId);
}

export async function getCustomObjectType(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<CustomObjectType> {
  inputUuid(input.tenantId, "Workspace ID");
  inputUuid(input.id, "Type ID");
  const response = await api.get<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.id)}`,
    { signal: input.signal },
  );
  const parsed = parseType(response, input.tenantId);
  if (parsed.id !== input.id) {
    throw new CustomObjectContractError(
      "Type response ID does not match the request.",
    );
  }
  return parsed;
}

export async function createCustomObjectType(input: {
  authority: CustomObjectAdminAuthority;
  key: string;
  label: string;
  primaryKey: string;
  schema: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<CustomObjectType> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  const key = inputTypeKey(input.key);
  const label = assertInputText(input.label, "Label", 256, 1_024);
  const primaryKey = inputPropertyKey(
    input.primaryKey || "external_id",
    "Primary key",
  );
  const schema = cloneBoundedInputObject(
    input.schema,
    "Schema",
    MAX_SCHEMA_BYTES,
    20,
    4_096,
  );
  const response = await api.post<unknown>(
    "/api/v1/custom-objects/types",
    { key, label, primaryKey, schema },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const parsed = parseType(response, input.authority.tenantId);
  if (
    parsed.key !== key ||
    parsed.label !== label ||
    parsed.primaryKey !== primaryKey ||
    parsed.status !== "active" ||
    parsed.version !== 1 ||
    !sameJSON(parsed.schema, schema)
  ) {
    throw new CustomObjectContractError(
      "Created type receipt does not match the submitted intent.",
    );
  }
  return parsed;
}

export async function updateCustomObjectType(input: {
  authority: CustomObjectAdminAuthority;
  current: CustomObjectType;
  label: string;
  schema: Record<string, unknown>;
  status: CustomObjectStatus;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<CustomObjectType> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  if (input.current.tenantId !== input.authority.tenantId) {
    throw new CustomObjectInputError(
      "Loaded type authority does not match the workspace.",
    );
  }
  inputUuid(input.current.id, "Type ID");
  assertExpectedVersion(input.current.version, "Loaded type version");
  const label = assertInputText(input.label, "Label", 256, 1_024);
  const schema = cloneBoundedInputObject(
    input.schema,
    "Schema",
    MAX_SCHEMA_BYTES,
    20,
    4_096,
  );
  if (!CUSTOM_OBJECT_STATUSES.includes(input.status)) {
    throw new CustomObjectInputError("Status is invalid.");
  }
  const response = await api.put<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.current.id)}`,
    {
      label,
      schema,
      status: input.status,
      expectedVersion: input.current.version,
    },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const parsed = parseType(response, input.authority.tenantId);
  if (
    parsed.id !== input.current.id ||
    parsed.key !== input.current.key ||
    parsed.primaryKey !== input.current.primaryKey ||
    parsed.createdAt !== input.current.createdAt ||
    parsed.version !== input.current.version + 1 ||
    parsed.label !== label ||
    parsed.status !== input.status ||
    !sameJSON(parsed.schema, schema)
  ) {
    throw new CustomObjectContractError(
      "Updated type receipt does not match the submitted intent.",
    );
  }
  return parsed;
}

export async function deleteCustomObjectType(input: {
  authority: CustomObjectAdminAuthority;
  current: CustomObjectType;
  confirmationKey: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<void> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  if (
    input.current.tenantId !== input.authority.tenantId ||
    input.confirmationKey !== input.current.key
  ) {
    throw new CustomObjectInputError(
      "Type deletion confirmation does not match the loaded type.",
    );
  }
  inputUuid(input.current.id, "Type ID");
  assertExpectedVersion(input.current.version, "Loaded type version");
  inputTypeKey(input.current.key);
  const response = await api.delete<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.current.id)}`,
    {
      body: {
        expectedVersion: input.current.version,
        confirmationKey: input.confirmationKey,
      },
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  if (
    !isRecord(response) ||
    !exactKeys(response, ["deleted", "id", "expectedVersion"]) ||
    response.deleted !== true ||
    response.id !== input.current.id ||
    response.expectedVersion !== input.current.version
  ) {
    throw new CustomObjectContractError("Type deletion receipt is invalid.");
  }
}

export async function listCustomObjectRecords(input: {
  tenantId: string;
  typeId: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CustomObjectRecordPage> {
  inputUuid(input.tenantId, "Workspace ID");
  inputUuid(input.typeId, "Type ID");
  const limit = input.limit ?? 100;
  assertLimit(limit);
  const response = await api.get<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.typeId)}/records?limit=${limit}`,
    { signal: input.signal },
  );
  return parseRecordPage(response, input.tenantId, input.typeId, limit);
}

export async function searchCustomObjectRecords(input: {
  tenantId: string;
  typeId: string;
  property: string;
  value: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CustomObjectRecordPage> {
  inputUuid(input.tenantId, "Workspace ID");
  inputUuid(input.typeId, "Type ID");
  const property = inputPropertyKey(input.property, "Property");
  const value = assertInputText(input.value, "Filter value", 1_024, 4_096);
  const limit = input.limit ?? 100;
  assertLimit(limit);
  const response = await api.post<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.typeId)}/records/search`,
    { property, value, limit },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: null,
    },
  );
  return parseRecordPage(response, input.tenantId, input.typeId, limit);
}

export async function getCustomObjectRecord(input: {
  tenantId: string;
  id: string;
  expectedTypeId?: string;
  signal?: AbortSignal;
}): Promise<CustomObjectRecord> {
  inputUuid(input.tenantId, "Workspace ID");
  inputUuid(input.id, "Record ID");
  if (input.expectedTypeId) inputUuid(input.expectedTypeId, "Type ID");
  const response = await api.get<unknown>(
    `/api/v1/custom-objects/records/${encodeURIComponent(input.id)}`,
    { signal: input.signal },
  );
  const parsed = parseObjectRecord(
    response,
    input.tenantId,
    input.expectedTypeId,
  );
  if (parsed.id !== input.id) {
    throw new CustomObjectContractError(
      "Record response ID does not match the request.",
    );
  }
  return parsed;
}

export async function upsertCustomObjectRecord(input: {
  authority: CustomObjectAdminAuthority;
  typeId: string;
  current?: CustomObjectRecord;
  externalId: string;
  properties: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<CustomObjectRecord> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  inputUuid(input.typeId, "Type ID");
  const externalId = assertInputText(
    input.externalId,
    "External ID",
    512,
    2_048,
  );
  const properties = cloneBoundedInputObject(
    input.properties,
    "Record properties",
    MAX_PROPERTIES_BYTES,
  );
  if (
    input.current &&
    (input.current.tenantId !== input.authority.tenantId ||
      input.current.objectTypeId !== input.typeId ||
      input.current.externalId !== externalId)
  ) {
    throw new CustomObjectInputError(
      "Loaded record identity does not match the write intent.",
    );
  }
  if (input.current) {
    inputUuid(input.current.id, "Record ID");
    assertExpectedVersion(input.current.version, "Loaded record version");
  }
  const expectedVersion = input.current?.version ?? 0;
  const response = await api.post<unknown>(
    `/api/v1/custom-objects/types/${encodeURIComponent(input.typeId)}/records`,
    { externalId, properties, expectedVersion },
    {
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  const parsed = parseObjectRecord(
    response,
    input.authority.tenantId,
    input.typeId,
  );
  if (
    parsed.externalId !== externalId ||
    parsed.version !== expectedVersion + 1 ||
    !sameJSON(parsed.properties, properties) ||
    (input.current &&
      (parsed.id !== input.current.id ||
        parsed.createdAt !== input.current.createdAt))
  ) {
    throw new CustomObjectContractError(
      "Record write receipt does not match the submitted intent.",
    );
  }
  return parsed;
}

export async function deleteCustomObjectRecord(input: {
  authority: CustomObjectAdminAuthority;
  current: CustomObjectRecord;
  confirmationExternalId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<void> {
  assertAuthority(input.authority);
  assertIdempotencyKey(input.idempotencyKey);
  if (
    input.current.tenantId !== input.authority.tenantId ||
    input.confirmationExternalId !== input.current.externalId
  ) {
    throw new CustomObjectInputError(
      "Record deletion confirmation does not match the loaded record.",
    );
  }
  inputUuid(input.current.id, "Record ID");
  assertExpectedVersion(input.current.version, "Loaded record version");
  const response = await api.delete<unknown>(
    `/api/v1/custom-objects/records/${encodeURIComponent(input.current.id)}`,
    {
      body: {
        expectedVersion: input.current.version,
        confirmationExternalId: input.confirmationExternalId,
      },
      signal: input.signal,
      requireOnline: true,
      idempotencyKey: input.idempotencyKey,
    },
  );
  if (
    !isRecord(response) ||
    !exactKeys(response, ["deleted", "id", "expectedVersion"]) ||
    response.deleted !== true ||
    response.id !== input.current.id ||
    response.expectedVersion !== input.current.version
  ) {
    throw new CustomObjectContractError("Record deletion receipt is invalid.");
  }
}

export function customObjectViolations(
  error: unknown,
): CustomObjectViolation[] {
  if (
    !(error instanceof ApiError) ||
    error.status !== 422 ||
    !isRecord(error.body)
  ) {
    return [];
  }
  const envelope = isRecord(error.body.error) ? error.body.error : null;
  if (
    !envelope ||
    envelope.code !== "validation_failed" ||
    !Array.isArray(envelope.fields)
  ) {
    return [];
  }
  const out: CustomObjectViolation[] = [];
  for (const candidate of envelope.fields) {
    if (out.length >= 100 || !isRecord(candidate)) continue;
    const code =
      typeof candidate.code === "string" &&
      Object.hasOwn(SAFE_VIOLATION_MESSAGES, candidate.code)
        ? candidate.code
        : "schema_violation";
    const field =
      typeof candidate.field === "string" &&
      candidate.field.length <= 256 &&
      SAFE_VIOLATION_FIELD_RE.test(candidate.field)
        ? candidate.field === "$" || candidate.field === "$properties"
          ? "Record"
          : candidate.field === "$schema"
            ? "Schema"
            : candidate.field
        : "Record";
    out.push({
      field,
      code,
      message:
        SAFE_VIOLATION_MESSAGES[code] ??
        "This field did not satisfy the saved schema.",
    });
  }
  return out;
}
