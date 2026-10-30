// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export type SavedBlockKind = "block" | "snippet" | "section";
export type CollectionType = "coupons" | "content" | "schedule";
export type CollectionSource = "uploaded" | "api" | "manual";
export type CollectionRow = Record<string, unknown>;

export interface SavedBlock {
  id: string;
  tenantId: string;
  name: string;
  kind: SavedBlockKind;
  bodyHtml: string;
  bodyJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface SavedBlocksPage {
  items: SavedBlock[];
  total: number;
  nextCursor: string | null;
}

export interface Collection {
  id: string;
  tenantId: string;
  name: string;
  collectionType: CollectionType;
  sourceType: CollectionSource;
  data: CollectionRow[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CollectionsPage {
  items: Collection[];
  total: number;
  nextCursor: string | null;
}

export interface ContentDeleteReceipt {
  ok: true;
  id: string;
  version: number;
}

export class ContentLibraryContractError extends Error {
  constructor(
    message = "The content-library service returned an invalid response.",
  ) {
    super(message);
    this.name = "ContentLibraryContractError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Go/Postgres timestamps may retain the database timezone offset. Both that
// RFC3339 representation and UTC Z identify an absolute instant.
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BLOCK_KINDS = new Set<SavedBlockKind>(["block", "snippet", "section"]);
const COLLECTION_TYPES = new Set<CollectionType>([
  "coupons",
  "content",
  "schedule",
]);
const COLLECTION_SOURCES = new Set<CollectionSource>([
  "uploaded",
  "api",
  "manual",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentLibraryContractError(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new ContentLibraryContractError();
  }
}

function safeString(
  value: unknown,
  label: string,
  maxRunes: number,
  options: { allowEmpty?: boolean; multiline?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    [...value].length > maxRunes
  ) {
    throw new ContentLibraryContractError(`${label} is invalid.`);
  }
  const unsafe = options.multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u
    : UNSAFE_TEXT_RE;
  if (unsafe.test(value))
    throw new ContentLibraryContractError(`${label} is invalid.`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const result = safeString(value, label, 36);
  if (!UUID_RE.test(result))
    throw new ContentLibraryContractError(`${label} is invalid.`);
  return result;
}

function positiveInteger(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new ContentLibraryContractError(`${label} is invalid.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = safeString(value, label, 64);
  if (!RFC3339_RE.test(result) || Number.isNaN(Date.parse(result))) {
    throw new ContentLibraryContractError(`${label} is invalid.`);
  }
  return result;
}

function authorityTenant(tenantId: string): void {
  uuid(tenantId, "Workspace id");
}

function assertIdempotencyKey(value: string): void {
  if (
    !value ||
    value.trim() !== value ||
    value.length > 255 ||
    UNSAFE_TEXT_RE.test(value)
  ) {
    throw new Error("A stable 1–255 character idempotency key is required.");
  }
}

function mutationOptions(idempotencyKey: string, signal?: AbortSignal) {
  assertIdempotencyKey(idempotencyKey);
  return {
    idempotencyKey,
    requireOnline: true,
    maxAttempts: 1,
    signal,
  } as const;
}

function cloneJSON(
  value: unknown,
  state: { nodes: number },
  depth: number,
  limits: { maxDepth: number; maxNodes: number; maxStringBytes: number },
): unknown {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes || depth > limits.maxDepth) {
    throw new ContentLibraryContractError(
      "Structured content exceeds the supported shape.",
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new ContentLibraryContractError(
        "Structured content contains an unsafe number.",
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).length > limits.maxStringBytes) {
      throw new ContentLibraryContractError(
        "Structured content contains an oversized string.",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneJSON(item, state, depth + 1, limits));
  }
  const source = object(value, "Structured content");
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(source)) {
    if (
      !key ||
      [...key].length > 128 ||
      RESERVED_KEYS.has(key) ||
      UNSAFE_TEXT_RE.test(key)
    ) {
      throw new ContentLibraryContractError(
        "Structured content contains an unsafe key.",
      );
    }
    out[key] = cloneJSON(child, state, depth + 1, limits);
  }
  return out;
}

function savedBlockJSON(value: unknown): Record<string, unknown> {
  return cloneJSON(value, { nodes: 0 }, 1, {
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringBytes: 64 * 1024,
  }) as Record<string, unknown>;
}

function collectionRows(value: unknown): CollectionRow[] {
  if (!Array.isArray(value) || value.length > 50_000) {
    throw new ContentLibraryContractError("Collection rows are invalid.");
  }
  const state = { nodes: 0 };
  return value.map((row) => {
    const cloned = cloneJSON(row, state, 1, {
      maxDepth: 8,
      maxNodes: 250_000,
      maxStringBytes: 64 * 1024,
    });
    const item = object(cloned, "Collection row");
    if (Object.keys(item).length > 100) {
      throw new ContentLibraryContractError(
        "Collection row has too many fields.",
      );
    }
    return item;
  });
}

function decodeSavedBlock(value: unknown, tenantId: string): SavedBlock {
  const row = object(value, "Saved block");
  exactKeys(row, [
    "id",
    "tenant_id",
    "name",
    "kind",
    "body_html",
    "body_json",
    "created_at",
    "updated_at",
    "version",
  ]);
  const wireTenant = uuid(row.tenant_id, "Saved-block workspace");
  if (wireTenant !== tenantId)
    throw new ContentLibraryContractError("Saved-block workspace mismatch.");
  const kind = safeString(row.kind, "Saved-block kind", 16) as SavedBlockKind;
  if (!BLOCK_KINDS.has(kind)) throw new ContentLibraryContractError();
  const createdAt = timestamp(row.created_at, "Saved-block created time");
  const updatedAt = timestamp(row.updated_at, "Saved-block updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new ContentLibraryContractError();
  const bodyHtml = safeString(row.body_html, "Saved-block HTML", 200 * 1024, {
    allowEmpty: true,
    multiline: true,
  });
  if (new TextEncoder().encode(bodyHtml).length > 200 * 1024) {
    throw new ContentLibraryContractError("Saved-block HTML is too large.");
  }
  return {
    id: uuid(row.id, "Saved-block id"),
    tenantId: wireTenant,
    name: safeString(row.name, "Saved-block name", 120),
    kind,
    bodyHtml,
    bodyJson: savedBlockJSON(row.body_json),
    createdAt,
    updatedAt,
    version: positiveInteger(row.version, "Saved-block version", 1),
  };
}

function decodeSavedBlocksPage(
  value: unknown,
  tenantId: string,
): SavedBlocksPage {
  const page = object(value, "Saved-block page");
  exactKeys(page, ["items", "total"], ["next_cursor"]);
  if (!Array.isArray(page.items)) throw new ContentLibraryContractError();
  const items = page.items.map((row) => decodeSavedBlock(row, tenantId));
  if (new Set(items.map((row) => row.id)).size !== items.length)
    throw new ContentLibraryContractError();
  const total = positiveInteger(page.total, "Saved-block total");
  if (total < items.length) throw new ContentLibraryContractError();
  const nextCursor =
    page.next_cursor === undefined
      ? null
      : uuid(page.next_cursor, "Saved-block cursor");
  if (nextCursor && !items.some((row) => row.id === nextCursor))
    throw new ContentLibraryContractError();
  return { items, total, nextCursor };
}

function decodeCollection(value: unknown, tenantId: string): Collection {
  const row = object(value, "Collection");
  exactKeys(row, [
    "id",
    "tenant_id",
    "name",
    "collection_type",
    "source_type",
    "data",
    "row_count",
    "created_at",
    "updated_at",
    "version",
  ]);
  const wireTenant = uuid(row.tenant_id, "Collection workspace");
  if (wireTenant !== tenantId)
    throw new ContentLibraryContractError("Collection workspace mismatch.");
  const collectionType = safeString(
    row.collection_type,
    "Collection type",
    16,
  ) as CollectionType;
  const sourceType = safeString(
    row.source_type,
    "Collection source",
    16,
  ) as CollectionSource;
  if (
    !COLLECTION_TYPES.has(collectionType) ||
    !COLLECTION_SOURCES.has(sourceType)
  ) {
    throw new ContentLibraryContractError();
  }
  const data = collectionRows(row.data);
  const rowCount = positiveInteger(row.row_count, "Collection row count");
  if (data.length > 0 && rowCount !== data.length)
    throw new ContentLibraryContractError();
  const createdAt = timestamp(row.created_at, "Collection created time");
  const updatedAt = timestamp(row.updated_at, "Collection updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new ContentLibraryContractError();
  return {
    id: uuid(row.id, "Collection id"),
    tenantId: wireTenant,
    name: safeString(row.name, "Collection name", 200),
    collectionType,
    sourceType,
    data,
    rowCount,
    createdAt,
    updatedAt,
    version: positiveInteger(row.version, "Collection version", 1),
  };
}

function decodeCollectionsPage(
  value: unknown,
  tenantId: string,
): CollectionsPage {
  const page = object(value, "Collections page");
  exactKeys(page, ["items", "total"], ["next_cursor"]);
  if (!Array.isArray(page.items)) throw new ContentLibraryContractError();
  const items = page.items.map((row) => decodeCollection(row, tenantId));
  if (new Set(items.map((row) => row.id)).size !== items.length)
    throw new ContentLibraryContractError();
  const total = positiveInteger(page.total, "Collection total");
  if (total < items.length) throw new ContentLibraryContractError();
  const nextCursor =
    page.next_cursor === undefined
      ? null
      : safeString(page.next_cursor, "Collection cursor", 2048);
  return { items, total, nextCursor };
}

function decodeDeleteReceipt(value: unknown, id: string): ContentDeleteReceipt {
  const receipt = object(value, "Delete receipt");
  exactKeys(receipt, ["ok", "id", "version"]);
  if (receipt.ok !== true || uuid(receipt.id, "Delete receipt id") !== id) {
    throw new ContentLibraryContractError();
  }
  return {
    ok: true,
    id,
    version: positiveInteger(receipt.version, "Delete receipt version", 1),
  };
}

export async function listSavedBlocks(input: {
  tenantId: string;
  q?: string;
  kind?: SavedBlockKind;
  before?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SavedBlocksPage> {
  authorityTenant(input.tenantId);
  const q = input.q?.trim() ?? "";
  if ([...q].length > 200 || UNSAFE_TEXT_RE.test(q))
    throw new Error("Saved-block search must be 200 safe characters or fewer.");
  if (input.kind && !BLOCK_KINDS.has(input.kind))
    throw new Error("Saved-block kind is invalid.");
  if (input.before) uuid(input.before, "Saved-block cursor");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Saved-block page size must be from 1 to 200.");
  return decodeSavedBlocksPage(
    await api.get<unknown>("/api/v1/blocks/saved", {
      query: {
        q: q || undefined,
        kind: input.kind,
        before: input.before,
        limit,
      },
      signal: input.signal,
    }),
    input.tenantId,
  );
}

export async function getSavedBlock(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<SavedBlock> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Saved-block id");
  const row = decodeSavedBlock(
    await api.get<unknown>(`/api/v1/blocks/saved/${encodeURIComponent(id)}`, {
      signal: input.signal,
      requireOnline: true,
    }),
    input.tenantId,
  );
  if (row.id !== id) throw new ContentLibraryContractError();
  return row;
}

export async function createSavedBlock(input: {
  tenantId: string;
  name: string;
  kind: SavedBlockKind;
  bodyHtml: string;
  bodyJson: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SavedBlock> {
  authorityTenant(input.tenantId);
  const name = input.name.trim();
  safeString(name, "Saved-block name", 120);
  if (!BLOCK_KINDS.has(input.kind))
    throw new Error("Saved-block kind is invalid.");
  if (new TextEncoder().encode(input.bodyHtml).length > 200 * 1024) {
    throw new Error("Saved-block HTML must be at most 200 KiB.");
  }
  const bodyJson = savedBlockJSON(input.bodyJson);
  return decodeSavedBlock(
    await api.post<unknown>(
      "/api/v1/blocks/saved",
      {
        name,
        kind: input.kind,
        body_html: input.bodyHtml,
        body_json: bodyJson,
        expected_version: 0,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
}

export async function updateSavedBlock(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  name: string;
  kind: SavedBlockKind;
  bodyHtml: string;
  bodyJson: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SavedBlock> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Saved-block id");
  positiveInteger(input.expectedVersion, "Expected version", 1);
  const name = input.name.trim();
  safeString(name, "Saved-block name", 120);
  if (!BLOCK_KINDS.has(input.kind))
    throw new Error("Saved-block kind is invalid.");
  if (new TextEncoder().encode(input.bodyHtml).length > 200 * 1024) {
    throw new Error("Saved-block HTML must be at most 200 KiB.");
  }
  const bodyJson = savedBlockJSON(input.bodyJson);
  const row = decodeSavedBlock(
    await api.patch<unknown>(
      `/api/v1/blocks/saved/${encodeURIComponent(id)}`,
      {
        name,
        kind: input.kind,
        body_html: input.bodyHtml,
        body_json: bodyJson,
        expected_version: input.expectedVersion,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
  if (row.id !== id || row.version <= input.expectedVersion)
    throw new ContentLibraryContractError();
  return row;
}

export async function deleteSavedBlock(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ContentDeleteReceipt> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Saved-block id");
  positiveInteger(input.expectedVersion, "Expected version", 1);
  const receipt = decodeDeleteReceipt(
    await api.delete<unknown>(
      `/api/v1/blocks/saved/${encodeURIComponent(id)}`,
      {
        body: { expected_version: input.expectedVersion },
        ...mutationOptions(input.idempotencyKey, input.signal),
      },
    ),
    id,
  );
  if (receipt.version <= input.expectedVersion) {
    throw new ContentLibraryContractError();
  }
  return receipt;
}

export async function listCollections(input: {
  tenantId: string;
  q?: string;
  collectionType?: CollectionType;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CollectionsPage> {
  authorityTenant(input.tenantId);
  const q = input.q?.trim() ?? "";
  if ([...q].length > 200 || UNSAFE_TEXT_RE.test(q))
    throw new Error("Collection search must be 200 safe characters or fewer.");
  if (input.collectionType && !COLLECTION_TYPES.has(input.collectionType))
    throw new Error("Collection type is invalid.");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("Collection page size must be from 1 to 200.");
  return decodeCollectionsPage(
    await api.get<unknown>("/api/v1/collections", {
      query: {
        q: q || undefined,
        collection_type: input.collectionType,
        cursor: input.cursor,
        limit,
      },
      signal: input.signal,
    }),
    input.tenantId,
  );
}

export async function getCollection(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<Collection> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Collection id");
  const row = decodeCollection(
    await api.get<unknown>(`/api/v1/collections/${encodeURIComponent(id)}`, {
      signal: input.signal,
      requireOnline: true,
    }),
    input.tenantId,
  );
  if (row.id !== id || row.rowCount !== row.data.length)
    throw new ContentLibraryContractError();
  return row;
}

export async function createCollection(input: {
  tenantId: string;
  name: string;
  collectionType: CollectionType;
  sourceType: CollectionSource;
  data: CollectionRow[];
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<Collection> {
  authorityTenant(input.tenantId);
  const name = input.name.trim();
  safeString(name, "Collection name", 200);
  if (
    !COLLECTION_TYPES.has(input.collectionType) ||
    !COLLECTION_SOURCES.has(input.sourceType)
  ) {
    throw new Error("Collection type or source is invalid.");
  }
  const data = collectionRows(input.data);
  return decodeCollection(
    await api.post<unknown>(
      "/api/v1/collections",
      {
        name,
        collection_type: input.collectionType,
        source_type: input.sourceType,
        data,
        expected_version: 0,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
}

export async function updateCollection(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  name: string;
  collectionType: CollectionType;
  sourceType: CollectionSource;
  data: CollectionRow[];
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<Collection> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Collection id");
  positiveInteger(input.expectedVersion, "Expected version", 1);
  const name = input.name.trim();
  safeString(name, "Collection name", 200);
  if (
    !COLLECTION_TYPES.has(input.collectionType) ||
    !COLLECTION_SOURCES.has(input.sourceType)
  ) {
    throw new Error("Collection type or source is invalid.");
  }
  const data = collectionRows(input.data);
  const row = decodeCollection(
    await api.patch<unknown>(
      `/api/v1/collections/${encodeURIComponent(id)}`,
      {
        name,
        collection_type: input.collectionType,
        source_type: input.sourceType,
        data,
        expected_version: input.expectedVersion,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
  if (
    row.id !== id ||
    row.version <= input.expectedVersion ||
    row.rowCount !== row.data.length
  ) {
    throw new ContentLibraryContractError();
  }
  return row;
}

export async function deleteCollection(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<ContentDeleteReceipt> {
  authorityTenant(input.tenantId);
  const id = uuid(input.id, "Collection id");
  positiveInteger(input.expectedVersion, "Expected version", 1);
  const receipt = decodeDeleteReceipt(
    await api.delete<unknown>(`/api/v1/collections/${encodeURIComponent(id)}`, {
      body: { expected_version: input.expectedVersion },
      ...mutationOptions(input.idempotencyKey, input.signal),
    }),
    id,
  );
  if (receipt.version <= input.expectedVersion) {
    throw new ContentLibraryContractError();
  }
  return receipt;
}
