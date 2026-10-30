import type {
  Collection,
  CollectionPage,
  CollectionRow,
  CollectionSourceType,
  CollectionType,
} from "../api-client";
import { collectionPersistenceJsonBytes } from "./collection-json-size";

const COLLECTION_TYPES = new Set<CollectionType>([
  "coupons",
  "content",
  "schedule",
]);
const SOURCE_TYPES = new Set<CollectionSourceType>([
  "uploaded",
  "api",
  "manual",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const UNSAFE_KEY_TEXT = /[\p{Cc}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const MAX_PAGE_ITEMS = 200;
const MAX_DETAIL_ROWS = 50_000;
const MAX_ROW_COLUMNS = 100;
const MAX_FIELD_NAME_CODE_POINTS = 128;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 8;
const MAX_NESTED_MEMBERS = 1000;
const MAX_TOTAL_VALUE_NODES = 250_000;
const MAX_ENCODED_ROW_BYTES = 256 * 1024;
const MAX_DATA_BYTES = 1024 * 1024;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeRows(value: unknown): CollectionRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_DETAIL_ROWS) return null;
  const rows: CollectionRow[] = [];
  const budget = { nodes: 0 };
  for (const row of value) {
    if (
      !isRecord(row) ||
      Object.keys(row).length > MAX_ROW_COLUMNS ||
      !validRow(row, budget) ||
      collectionPersistenceJsonBytes(row) > MAX_ENCODED_ROW_BYTES
    ) {
      return null;
    }
    rows.push(row);
  }
  if (collectionPersistenceJsonBytes(rows) > MAX_DATA_BYTES) return null;
  return rows;
}

function validObjectKey(key: string): boolean {
  return (
    key.trim().length > 0 &&
    isWellFormedUnicode(key) &&
    Array.from(key).length <= MAX_FIELD_NAME_CODE_POINTS &&
    !UNSAFE_KEY_TEXT.test(key) &&
    !RESERVED_KEYS.has(key)
  );
}

function validRow(
  row: Record<string, unknown>,
  budget: { nodes: number },
): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_TOTAL_VALUE_NODES) return false;
  return Object.entries(row).every(
    ([key, item]) => validObjectKey(key) && isSafeJsonValue(item, 1, budget),
  );
}

function isSafeJsonValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  budget.nodes += 1;
  if (budget.nodes > MAX_TOTAL_VALUE_NODES) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)))
  ) {
    return true;
  }
  if (typeof value === "string") {
    return (
      isWellFormedUnicode(value) &&
      !value.includes("\u0000") &&
      encoder.encode(value).byteLength <= MAX_STRING_BYTES
    );
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_NESTED_MEMBERS &&
      value.every((item) => isSafeJsonValue(item, depth + 1, budget))
    );
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_NESTED_MEMBERS &&
    entries.every(
      ([key, item]) =>
        validObjectKey(key) && isSafeJsonValue(item, depth + 1, budget),
    )
  );
}

function validTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    RFC3339_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function decodeBase(
  value: unknown,
  expectedTenantId?: string | null,
): Omit<Collection, "data"> | null {
  if (!isRecord(value)) return null;
  const normalizedExpectedTenantId = expectedTenantId?.toLowerCase();
  if (
    expectedTenantId !== undefined &&
    expectedTenantId !== null &&
    (!normalizedExpectedTenantId ||
      !UUID_PATTERN.test(normalizedExpectedTenantId))
  ) {
    return null;
  }
  const id = optionalString(value.id);
  const name = optionalString(value.name);
  if (
    !id ||
    !UUID_PATTERN.test(id) ||
    !name ||
    name !== name.trim() ||
    !isWellFormedUnicode(name) ||
    Array.from(name).length > 200 ||
    UNSAFE_KEY_TEXT.test(name)
  ) {
    return null;
  }
  if (
    typeof value.tenant_id !== "string" ||
    !UUID_PATTERN.test(value.tenant_id)
  ) {
    return null;
  }
  if (
    normalizedExpectedTenantId &&
    value.tenant_id !== normalizedExpectedTenantId
  ) {
    return null;
  }
  if (
    typeof value.collection_type !== "string" ||
    !COLLECTION_TYPES.has(value.collection_type as CollectionType) ||
    typeof value.source_type !== "string" ||
    !SOURCE_TYPES.has(value.source_type as CollectionSourceType)
  ) {
    return null;
  }
  if (!validTimestamp(value.created_at) || !validTimestamp(value.updated_at)) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.row_count) ||
    (value.row_count as number) < 0 ||
    (value.row_count as number) > MAX_DETAIL_ROWS
  ) {
    return null;
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    return null;
  }
  return {
    id,
    name,
    collection_type: value.collection_type as CollectionType,
    source_type: value.source_type as CollectionSourceType,
    row_count: value.row_count as number,
    version: value.version as number,
    ...(optionalString(value.tenant_id)
      ? { tenant_id: value.tenant_id as string }
      : {}),
    ...(optionalString(value.created_at)
      ? { created_at: value.created_at as string }
      : {}),
    ...(optionalString(value.updated_at)
      ? { updated_at: value.updated_at as string }
      : {}),
  };
}

/** Decode the metadata-only list response and intentionally discard row data. */
export function decodeCollectionPage(
  value: unknown,
  expectedTenantId?: string | null,
): CollectionPage | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_PAGE_ITEMS ||
    !Number.isSafeInteger(value.total) ||
    (value.total as number) < 0
  ) {
    return null;
  }
  const items: Collection[] = [];
  const ids = new Set<string>();
  for (const item of value.items) {
    const decoded = decodeBase(item, expectedTenantId);
    if (
      !decoded ||
      ids.has(decoded.id) ||
      !isRecord(item) ||
      !Array.isArray(item.data) ||
      item.data.length !== 0
    ) {
      return null;
    }
    ids.add(decoded.id);
    items.push({ ...decoded, data: [] });
  }
  if ((value.total as number) < items.length) return null;
  if (
    value.next_cursor !== undefined &&
    (typeof value.next_cursor !== "string" ||
      value.next_cursor.length === 0 ||
      value.next_cursor.length > 2048 ||
      !/^[A-Za-z0-9_-]+$/u.test(value.next_cursor))
  ) {
    return null;
  }
  if (typeof value.next_cursor === "string" && items.length === 0) return null;
  return {
    items,
    total: value.total as number,
    ...(typeof value.next_cursor === "string"
      ? { next_cursor: value.next_cursor }
      : {}),
  };
}

/** Decode one full collection before its arbitrary row values reach the DOM. */
export function decodeCollectionDetail(
  value: unknown,
  expectedTenantId?: string | null,
): Collection | null {
  const decoded = decodeBase(value, expectedTenantId);
  if (!decoded || !isRecord(value)) return null;
  const rows = decodeRows(value.data);
  if (!rows || decoded.row_count !== rows.length) return null;
  return { ...decoded, data: rows };
}

export function decodeDeleteAcknowledgement(
  value: unknown,
  expectedId: string,
  expectedVersion: number,
): boolean {
  return (
    Number.isSafeInteger(expectedVersion) &&
    expectedVersion > 0 &&
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.ok === true &&
    value.id === expectedId &&
    UUID_PATTERN.test(expectedId) &&
    Number.isSafeInteger(value.version) &&
    value.version === expectedVersion + 1
  );
}
