// SPDX-License-Identifier: AGPL-3.0-only

import { ApiError, api } from "@/lib/api";

export type AssetSort = "newest" | "oldest" | "largest" | "name" | "most-used";
export type AssetFilter = "all" | "recent" | "in-use" | "unused" | "large";
export type AssetMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface AssetCounts {
  all: number;
  recent: number;
  inUse: number;
  unused: number;
  large: number;
}

export interface Asset {
  id: string;
  tenantId: string;
  filename: string;
  mime: AssetMime;
  bytes: number;
  width: number;
  height: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  altText: string;
  referencesCount: number;
  lastUsedAt: string | null;
  folderId: string | null;
}

export interface AssetReferrer {
  kind: "campaign" | "template" | "form";
  id: string;
  name: string;
}

export interface AssetDetail {
  asset: Asset;
  usage: AssetReferrer[];
}

export interface AssetFolder {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  assetCount: number;
}

export interface AssetTagCount {
  tag: string;
  count: number;
}

export interface AssetListing {
  counts: AssetCounts;
  items: Asset[];
  nextCursor: string | null;
}

export interface AssetTags {
  tags: string[];
  version: number;
}

export interface AssetMutationReceipt {
  ok: true;
  id: string;
  version: number;
  folderId?: string | null;
}

export interface AssetBulkDeleteResponse {
  deleted: number;
  skipped: number;
  receipts: AssetMutationReceipt[];
  failed: Array<{
    id: string;
    reason: "has_references" | "not_found" | "stale_version" | "internal_error";
  }>;
}

export class AssetContractError extends Error {
  constructor(message = "The asset service returned an invalid response.") {
    super(message);
    this.name = "AssetContractError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Go/Postgres timestamps may retain the database timezone offset. Both that
// RFC3339 representation and UTC Z identify an absolute instant.
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const SAFE_TEXT_RE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const MIMES = new Set<AssetMime>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssetContractError(`${label} response is invalid.`);
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
    throw new AssetContractError();
  }
}

function stringValue(value: unknown, label: string, maxBytes = 1024): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > maxBytes ||
    SAFE_TEXT_RE.test(value)
  ) {
    throw new AssetContractError(`${label} is invalid.`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const result = stringValue(value, label, 36);
  if (!UUID_RE.test(result))
    throw new AssetContractError(`${label} is invalid.`);
  return result;
}

function safeInteger(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new AssetContractError(`${label} is invalid.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = stringValue(value, label, 64);
  if (!RFC3339_RE.test(result) || Number.isNaN(Date.parse(result))) {
    throw new AssetContractError(`${label} is invalid.`);
  }
  return result;
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value, label);
}

function safeAssetURL(value: unknown, id: string): string {
  const result = stringValue(value, "Asset URL", 4096);
  if (result === `/api/v1/assets/${encodeURIComponent(id)}/blob`) return result;
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new AssetContractError("Asset URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new AssetContractError("Asset URL is invalid.");
  }
  return parsed.toString();
}

function decodeAsset(value: unknown, tenantId: string): Asset {
  const item = record(value, "Asset");
  exactKeys(
    item,
    [
      "id",
      "tenantId",
      "filename",
      "mime",
      "bytes",
      "width",
      "height",
      "url",
      "createdAt",
      "updatedAt",
      "version",
      "altText",
      "referencesCount",
      "folderId",
    ],
    ["lastUsedAt"],
  );
  const id = uuid(item.id, "Asset id");
  const wireTenant = uuid(item.tenantId, "Asset workspace");
  if (wireTenant !== tenantId)
    throw new AssetContractError("Asset workspace mismatch.");
  const mime = stringValue(item.mime, "Asset MIME", 32) as AssetMime;
  if (!MIMES.has(mime)) throw new AssetContractError("Asset MIME is invalid.");
  const altText = typeof item.altText === "string" ? item.altText : "";
  if (
    new TextEncoder().encode(altText).length > 4096 ||
    [...altText].length > 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(altText)
  ) {
    throw new AssetContractError("Asset alt text is invalid.");
  }
  const createdAt = timestamp(item.createdAt, "Asset created time");
  const updatedAt = timestamp(item.updatedAt, "Asset updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new AssetContractError("Asset timestamps are invalid.");
  }
  return {
    id,
    tenantId: wireTenant,
    filename: stringValue(item.filename, "Asset filename", 128),
    mime,
    bytes: safeInteger(item.bytes, "Asset size"),
    width: safeInteger(item.width, "Asset width"),
    height: safeInteger(item.height, "Asset height"),
    url: safeAssetURL(item.url, id),
    createdAt,
    updatedAt,
    version: safeInteger(item.version, "Asset version", 1),
    altText,
    referencesCount: safeInteger(item.referencesCount, "Asset reference count"),
    lastUsedAt: optionalTimestamp(item.lastUsedAt, "Asset last-used time"),
    folderId:
      item.folderId === null ? null : uuid(item.folderId, "Asset folder"),
  };
}

function decodeCounts(value: unknown): AssetCounts {
  const counts = record(value, "Asset counts");
  exactKeys(counts, ["all", "recent", "inUse", "unused", "large"]);
  return {
    all: safeInteger(counts.all, "All count"),
    recent: safeInteger(counts.recent, "Recent count"),
    inUse: safeInteger(counts.inUse, "In-use count"),
    unused: safeInteger(counts.unused, "Unused count"),
    large: safeInteger(counts.large, "Large count"),
  };
}

function decodeListing(value: unknown, tenantId: string): AssetListing {
  const page = record(value, "Asset list");
  exactKeys(page, ["items", "counts", "nextCursor"]);
  if (!Array.isArray(page.items)) throw new AssetContractError();
  const items = page.items.map((item) => decodeAsset(item, tenantId));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new AssetContractError("Asset list contains duplicate ids.");
  }
  const nextCursor =
    page.nextCursor === null ? null : uuid(page.nextCursor, "Asset cursor");
  if (nextCursor && !items.some((item) => item.id === nextCursor)) {
    throw new AssetContractError("Asset cursor is not part of the page.");
  }
  const counts = decodeCounts(page.counts);
  if (counts.all < items.length)
    throw new AssetContractError("Asset totals are invalid.");
  return { items, counts, nextCursor };
}

function decodeFolder(value: unknown, tenantId: string): AssetFolder {
  const folder = record(value, "Asset folder");
  exactKeys(folder, [
    "id",
    "tenantId",
    "name",
    "createdAt",
    "updatedAt",
    "version",
    "assetCount",
  ]);
  const wireTenant = uuid(folder.tenantId, "Folder workspace");
  if (wireTenant !== tenantId)
    throw new AssetContractError("Folder workspace mismatch.");
  const createdAt = timestamp(folder.createdAt, "Folder created time");
  const updatedAt = timestamp(folder.updatedAt, "Folder updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new AssetContractError();
  return {
    id: uuid(folder.id, "Folder id"),
    tenantId: wireTenant,
    name: stringValue(folder.name, "Folder name", 512),
    createdAt,
    updatedAt,
    version: safeInteger(folder.version, "Folder version", 1),
    assetCount: safeInteger(folder.assetCount, "Folder asset count"),
  };
}

function decodeTag(value: unknown): string {
  const tag = stringValue(value, "Asset tag", 256).trim();
  if ([...tag].length > 64)
    throw new AssetContractError("Asset tag is invalid.");
  return tag;
}

function decodeTagCounts(value: unknown): AssetTagCount[] {
  const envelope = record(value, "Asset tags");
  exactKeys(envelope, ["tags"]);
  if (!Array.isArray(envelope.tags)) throw new AssetContractError();
  const rows = envelope.tags.map((raw) => {
    const row = record(raw, "Asset tag");
    exactKeys(row, ["tag", "count"]);
    return {
      tag: decodeTag(row.tag),
      count: safeInteger(row.count, "Tag count"),
    };
  });
  if (new Set(rows.map((row) => row.tag)).size !== rows.length)
    throw new AssetContractError();
  return rows;
}

function decodeTags(value: unknown): AssetTags {
  const envelope = record(value, "Asset tags");
  exactKeys(envelope, ["tags", "version"]);
  if (!Array.isArray(envelope.tags)) throw new AssetContractError();
  const tags = envelope.tags.map(decodeTag);
  if (new Set(tags).size !== tags.length) throw new AssetContractError();
  return { tags, version: safeInteger(envelope.version, "Asset version", 1) };
}

function decodeReceipt(value: unknown, id: string): AssetMutationReceipt {
  const receipt = record(value, "Asset mutation receipt");
  exactKeys(receipt, ["ok", "id", "version"], ["folderId"]);
  if (receipt.ok !== true || uuid(receipt.id, "Receipt id") !== id)
    throw new AssetContractError();
  return {
    ok: true,
    id,
    version: safeInteger(receipt.version, "Receipt version", 1),
    ...(Object.prototype.hasOwnProperty.call(receipt, "folderId")
      ? {
          folderId:
            receipt.folderId === null
              ? null
              : uuid(receipt.folderId, "Receipt folder"),
        }
      : {}),
  };
}

function assertTenantId(tenantId: string): void {
  uuid(tenantId, "Workspace id");
}

function assertIdempotencyKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255 ||
    SAFE_TEXT_RE.test(value)
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

export async function listAssets(input: {
  tenantId: string;
  limit?: number;
  before?: string;
  q?: string;
  sort?: AssetSort;
  filter?: AssetFilter;
  tag?: string;
  folderId?: string | "root";
  signal?: AbortSignal;
}): Promise<AssetListing> {
  assertTenantId(input.tenantId);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Asset page size must be from 1 to 500.");
  if (input.before) uuid(input.before, "Asset cursor");
  const q = input.q?.trim() ?? "";
  if ([...q].length > 200 || SAFE_TEXT_RE.test(q))
    throw new Error("Asset search must be 200 safe characters or fewer.");
  if (input.tag) decodeTag(input.tag);
  if (input.folderId && input.folderId !== "root")
    uuid(input.folderId, "Folder id");
  const response = await api.get<unknown>("/api/v1/assets", {
    query: {
      limit,
      before: input.before,
      q: q || undefined,
      sort: input.sort,
      filter: input.filter && input.filter !== "all" ? input.filter : undefined,
      tag: input.tag,
      folder_id: input.folderId,
    },
    signal: input.signal,
  });
  return decodeListing(response, input.tenantId);
}

export async function getAsset(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<AssetDetail> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  const envelope = record(
    await api.get<unknown>(`/api/v1/assets/${encodeURIComponent(id)}`, {
      signal: input.signal,
      requireOnline: true,
    }),
    "Asset detail",
  );
  exactKeys(envelope, ["asset", "usage"]);
  if (!Array.isArray(envelope.usage)) throw new AssetContractError();
  const asset = decodeAsset(envelope.asset, input.tenantId);
  if (asset.id !== id) throw new AssetContractError("Asset identity mismatch.");
  const usage = envelope.usage.map((raw): AssetReferrer => {
    const row = record(raw, "Asset usage");
    exactKeys(row, ["kind", "id", "name"]);
    if (
      row.kind !== "campaign" &&
      row.kind !== "template" &&
      row.kind !== "form"
    )
      throw new AssetContractError();
    return {
      kind: row.kind,
      id: uuid(row.id, "Usage id"),
      name: stringValue(row.name, "Usage name", 1024),
    };
  });
  return { asset, usage };
}

export async function listAssetFolders(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<AssetFolder[]> {
  assertTenantId(input.tenantId);
  const envelope = record(
    await api.get<unknown>("/api/v1/assets/folders", { signal: input.signal }),
    "Asset folders",
  );
  exactKeys(envelope, ["folders"]);
  if (!Array.isArray(envelope.folders)) throw new AssetContractError();
  const rows = envelope.folders.map((row) => decodeFolder(row, input.tenantId));
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new AssetContractError();
  return rows;
}

export async function listAssetTags(input: {
  tenantId: string;
  signal?: AbortSignal;
}): Promise<AssetTagCount[]> {
  assertTenantId(input.tenantId);
  return decodeTagCounts(
    await api.get<unknown>("/api/v1/assets/tags", { signal: input.signal }),
  );
}

export async function getAssetTags(input: {
  tenantId: string;
  id: string;
  signal?: AbortSignal;
}): Promise<AssetTags> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  return decodeTags(
    await api.get<unknown>(`/api/v1/assets/${encodeURIComponent(id)}/tags`, {
      signal: input.signal,
      requireOnline: true,
    }),
  );
}

export async function uploadAsset(input: {
  tenantId: string;
  filename: string;
  mime: AssetMime;
  contentBase64: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<Asset> {
  assertTenantId(input.tenantId);
  stringValue(input.filename, "Asset filename", 512);
  if (
    !MIMES.has(input.mime) ||
    input.contentBase64.length < 4 ||
    input.contentBase64.length > 14_000_000 ||
    !/^[A-Za-z0-9+/_=-]+$/.test(input.contentBase64)
  ) {
    throw new Error("The asset upload payload is invalid.");
  }
  return decodeAsset(
    await api.post<unknown>(
      "/api/v1/assets",
      {
        filename: input.filename,
        mime: input.mime,
        content_base64: input.contentBase64,
        expected_version: 0,
      },
      {
        ...mutationOptions(input.idempotencyKey, input.signal),
        timeoutMs: 60_000,
      },
    ),
    input.tenantId,
  );
}

export async function updateAssetAltText(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  altText: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<Asset> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  if (typeof input.altText !== "string" || [...input.altText].length > 1024)
    throw new Error("Alt text must be at most 1,024 characters.");
  const row = decodeAsset(
    await api.patch<unknown>(
      `/api/v1/assets/${encodeURIComponent(id)}`,
      {
        alt_text: input.altText,
        expected_version: input.expectedVersion,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
  if (row.id !== id || row.version <= input.expectedVersion)
    throw new AssetContractError();
  return row;
}

export async function deleteAsset(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  force?: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetMutationReceipt> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  const receipt = decodeReceipt(
    await api.delete<unknown>(`/api/v1/assets/${encodeURIComponent(id)}`, {
      body: {
        expected_version: input.expectedVersion,
        force: input.force === true,
      },
      ...mutationOptions(input.idempotencyKey, input.signal),
    }),
    id,
  );
  if (receipt.version <= input.expectedVersion) throw new AssetContractError();
  return receipt;
}

export async function bulkDeleteAssets(input: {
  tenantId: string;
  items: Array<{ id: string; expectedVersion: number }>;
  force?: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetBulkDeleteResponse> {
  assertTenantId(input.tenantId);
  if (input.items.length < 1 || input.items.length > 1000)
    throw new Error("Select from 1 to 1,000 assets.");
  const seen = new Set<string>();
  const items = input.items.map((item) => {
    const id = uuid(item.id, "Asset id");
    if (seen.has(id)) throw new Error("Bulk asset ids must be unique.");
    seen.add(id);
    safeInteger(item.expectedVersion, "Expected version", 1);
    return { id, expected_version: item.expectedVersion };
  });
  const envelope = record(
    await api.post<unknown>(
      "/api/v1/assets/bulk-delete",
      {
        items,
        force: input.force === true,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    "Bulk asset delete",
  );
  exactKeys(envelope, ["deleted", "skipped", "receipts", "failed"]);
  if (!Array.isArray(envelope.receipts) || !Array.isArray(envelope.failed))
    throw new AssetContractError();
  const receipts = envelope.receipts.map((raw) => {
    const rawReceipt = record(raw, "Delete receipt");
    const id = uuid(rawReceipt.id, "Delete receipt id");
    return decodeReceipt(raw, id);
  });
  const allowedReasons = new Set([
    "has_references",
    "not_found",
    "stale_version",
    "internal_error",
  ]);
  const failed = envelope.failed.map((raw) => {
    const failure = record(raw, "Delete failure");
    exactKeys(failure, ["id", "reason"]);
    const reason = stringValue(failure.reason, "Delete failure reason", 64);
    if (!allowedReasons.has(reason)) throw new AssetContractError();
    return {
      id: uuid(failure.id, "Delete failure id"),
      reason: reason as AssetBulkDeleteResponse["failed"][number]["reason"],
    };
  });
  const deleted = safeInteger(envelope.deleted, "Deleted count");
  const skipped = safeInteger(envelope.skipped, "Skipped count");
  if (deleted !== receipts.length || deleted + skipped > items.length)
    throw new AssetContractError();
  return { deleted, skipped, receipts, failed };
}

export async function createAssetFolder(input: {
  tenantId: string;
  name: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetFolder> {
  assertTenantId(input.tenantId);
  const name = input.name.trim();
  if (!name || [...name].length > 128 || SAFE_TEXT_RE.test(name))
    throw new Error("Folder name must be 1–128 safe characters.");
  return decodeFolder(
    await api.post<unknown>(
      "/api/v1/assets/folders",
      { name, expected_version: 0 },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
}

export async function renameAssetFolder(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  name: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetFolder> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Folder id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  const name = input.name.trim();
  if (!name || [...name].length > 128 || SAFE_TEXT_RE.test(name))
    throw new Error("Folder name must be 1–128 safe characters.");
  const row = decodeFolder(
    await api.patch<unknown>(
      `/api/v1/assets/folders/${encodeURIComponent(id)}`,
      { name, expected_version: input.expectedVersion },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    input.tenantId,
  );
  if (row.id !== id || row.version <= input.expectedVersion)
    throw new AssetContractError();
  return row;
}

export async function deleteAssetFolder(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetMutationReceipt> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Folder id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  const receipt = decodeReceipt(
    await api.delete<unknown>(
      `/api/v1/assets/folders/${encodeURIComponent(id)}`,
      {
        body: { expected_version: input.expectedVersion },
        ...mutationOptions(input.idempotencyKey, input.signal),
      },
    ),
    id,
  );
  if (receipt.version <= input.expectedVersion) throw new AssetContractError();
  return receipt;
}

export async function moveAsset(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  folderId: string | null;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetMutationReceipt> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  if (input.folderId) uuid(input.folderId, "Folder id");
  const receipt = decodeReceipt(
    await api.patch<unknown>(
      `/api/v1/assets/${encodeURIComponent(id)}/folder`,
      {
        folder_id: input.folderId,
        expected_version: input.expectedVersion,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
    id,
  );
  if (receipt.version < input.expectedVersion) throw new AssetContractError();
  return receipt;
}

export async function addAssetTags(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  tags: string[];
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetTags> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  if (input.tags.length < 1 || input.tags.length > 32)
    throw new Error("Add from 1 to 32 tags.");
  const tags = input.tags.map(decodeTag);
  const result = decodeTags(
    await api.post<unknown>(
      `/api/v1/assets/${encodeURIComponent(id)}/tags`,
      {
        tags,
        expected_version: input.expectedVersion,
      },
      mutationOptions(input.idempotencyKey, input.signal),
    ),
  );
  if (result.version < input.expectedVersion) throw new AssetContractError();
  return result;
}

export async function removeAssetTag(input: {
  tenantId: string;
  id: string;
  expectedVersion: number;
  tag: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<AssetMutationReceipt> {
  assertTenantId(input.tenantId);
  const id = uuid(input.id, "Asset id");
  safeInteger(input.expectedVersion, "Expected version", 1);
  const tag = decodeTag(input.tag);
  const receipt = decodeReceipt(
    await api.delete<unknown>(
      `/api/v1/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
      {
        body: { expected_version: input.expectedVersion },
        ...mutationOptions(input.idempotencyKey, input.signal),
      },
    ),
    id,
  );
  if (receipt.version < input.expectedVersion) throw new AssetContractError();
  return receipt;
}

export function publicAssetURL(asset: Asset): string | null {
  try {
    const parsed = new URL(asset.url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export async function fetchAssetBlob(input: {
  asset: Asset;
  signal?: AbortSignal;
}): Promise<Blob> {
  const response = await fetch(
    `/api/v1/assets/${encodeURIComponent(input.asset.id)}/blob`,
    {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: input.asset.mime },
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new ApiError("Asset download failed.", response.status, undefined, {
      code: "asset_download_failed",
      method: "GET",
      path: `/api/v1/assets/${encodeURIComponent(input.asset.id)}/blob`,
    });
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 10 * 1024 * 1024)
    throw new AssetContractError("Asset download exceeds the supported size.");
  const blob = await response.blob();
  if (
    blob.size > 10 * 1024 * 1024 ||
    (blob.type && blob.type !== input.asset.mime)
  )
    throw new AssetContractError("Asset download is invalid.");
  return blob;
}
