import type {
  Asset,
  AssetCounts,
  AssetFolder,
  AssetReferrer,
  AssetTagCount,
} from "./api-client";

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export const ASSET_PAGE_LIMIT = 200;
export const ASSET_PICKER_LIMIT = 100;
export const ASSET_UPLOAD_MAX_FILES = 20;
export const ASSET_UPLOAD_CONCURRENCY = 3;
export const ASSET_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const ASSET_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
] as const;

const fail = <T>(error: string): DecodeResult<T> => ({ ok: false, error });
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown): value is string => typeof value === "string";
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const nonNegativeInteger = (value: unknown): value is number =>
  finiteNumber(value) && Number.isInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number =>
  nonNegativeInteger(value) && value > 0;

export function decodeAsset(value: unknown): DecodeResult<Asset> {
  const item = record(value);
  if (!item) return fail("asset must be an object");
  if (!string(item.id) || !item.id.trim())
    return fail("asset.id must be a non-empty string");
  if (!string(item.filename) || !item.filename.trim())
    return fail("asset.filename must be a non-empty string");
  if (!string(item.mime) || !item.mime.trim())
    return fail("asset.mime must be a non-empty string");
  if (!nonNegativeInteger(item.bytes))
    return fail("asset.bytes must be a non-negative integer");
  if (!string(item.url)) return fail("asset.url must be a string");
  if (!string(item.createdAt) || !item.createdAt.trim())
    return fail("asset.createdAt must be a non-empty string");
  if (!string(item.updatedAt) || !item.updatedAt.trim())
    return fail("asset.updatedAt must be a non-empty string");
  if (!positiveInteger(item.version))
    return fail("asset.version must be a positive integer");
  if (!string(item.tenantId) || !canonicalAssetUuid.test(item.tenantId))
    return fail("asset.tenantId must be a canonical UUID");
  if (item.width !== undefined && !nonNegativeInteger(item.width))
    return fail("asset.width must be a non-negative integer");
  if (item.height !== undefined && !nonNegativeInteger(item.height))
    return fail("asset.height must be a non-negative integer");
  if (item.altText !== undefined && !string(item.altText))
    return fail("asset.altText must be a string");
  if (
    item.referencesCount !== undefined &&
    !nonNegativeInteger(item.referencesCount)
  )
    return fail("asset.referencesCount must be a non-negative integer");
  if (
    item.lastUsedAt !== undefined &&
    item.lastUsedAt !== null &&
    !string(item.lastUsedAt)
  )
    return fail("asset.lastUsedAt must be a string or null");
  if (
    item.folderId !== undefined &&
    item.folderId !== null &&
    !string(item.folderId)
  )
    return fail("asset.folderId must be a string or null");
  if (
    item.tags !== undefined &&
    (!Array.isArray(item.tags) || !item.tags.every(string))
  )
    return fail("asset.tags must be an array of strings");
  return { ok: true, value: item as Asset };
}

function decodeArray<T>(
  value: unknown,
  label: string,
  decoder: (item: unknown) => DecodeResult<T>,
): DecodeResult<T[]> {
  if (!Array.isArray(value)) return fail(`${label} must be an array`);
  const decoded: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const result = decoder(value[index]);
    if (!result.ok) return fail(`${label}[${index}]: ${result.error}`);
    decoded.push(result.value);
  }
  return { ok: true, value: decoded };
}

export function decodeAssetCounts(value: unknown): DecodeResult<AssetCounts> {
  const counts = record(value);
  if (!counts) return fail("counts must be an object");
  for (const key of ["all", "recent", "inUse", "unused", "large"] as const) {
    if (!nonNegativeInteger(counts[key]))
      return fail(`counts.${key} must be a non-negative integer`);
  }
  return { ok: true, value: counts as unknown as AssetCounts };
}

export interface DecodedAssetList {
  items: Asset[];
  counts?: AssetCounts;
  nextCursor?: string | null;
}

const canonicalAssetUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function decodeAssetList(
  value: unknown,
  options: { requireCounts?: boolean; requireCursor?: boolean } = {},
): DecodeResult<DecodedAssetList> {
  if (Array.isArray(value)) {
    if (options.requireCounts) return fail("asset list is missing counts");
    if (options.requireCursor) return fail("asset list is missing nextCursor");
    const items = decodeArray(value, "items", decodeAsset);
    return items.ok ? { ok: true, value: { items: items.value } } : items;
  }
  const envelope = record(value);
  if (!envelope) return fail("asset list must be an object");
  const candidate = envelope.items ?? envelope.data ?? envelope.results;
  if (candidate === undefined) return fail("asset list is missing items");
  const items = decodeArray(candidate, "items", decodeAsset);
  if (!items.ok) return items;
  const rawCursor = envelope.nextCursor;
  if (
    rawCursor !== undefined &&
    rawCursor !== null &&
    (!string(rawCursor) || !canonicalAssetUuid.test(rawCursor))
  ) {
    return fail("nextCursor must be a canonical lowercase UUID or null");
  }
  if (rawCursor === undefined && options.requireCursor) {
    return fail("asset list is missing nextCursor");
  }
  const cursor =
    rawCursor === null || typeof rawCursor === "string"
      ? { nextCursor: rawCursor }
      : {};
  if (envelope.counts === undefined) {
    return options.requireCounts
      ? fail("asset list is missing counts")
      : { ok: true, value: { items: items.value, ...cursor } };
  }
  const counts = decodeAssetCounts(envelope.counts);
  if (!counts.ok) return counts;
  return {
    ok: true,
    value: { items: items.value, counts: counts.value, ...cursor },
  };
}

const decodeReferrer = (value: unknown): DecodeResult<AssetReferrer> => {
  const item = record(value);
  if (!item) return fail("referrer must be an object");
  if (!(["campaign", "template", "form"] as unknown[]).includes(item.kind))
    return fail("referrer.kind is invalid");
  if (!string(item.id) || !item.id.trim())
    return fail("referrer.id must be a non-empty string");
  if (!string(item.name)) return fail("referrer.name must be a string");
  return { ok: true, value: item as unknown as AssetReferrer };
};

export function decodeAssetUsage(
  value: unknown,
): DecodeResult<AssetReferrer[]> {
  const envelope = record(value);
  if (!envelope || envelope.usage === undefined)
    return fail("usage response is missing usage");
  return decodeArray(envelope.usage, "usage", decodeReferrer);
}

export function decodeAssetReferenceConflict(
  value: unknown,
): DecodeResult<{ count: number; usage: AssetReferrer[] }> {
  const conflict = record(value);
  if (!conflict || !nonNegativeInteger(conflict.count)) {
    return fail("reference conflict is missing a non-negative count");
  }
  const usage = decodeAssetUsage(conflict);
  if (!usage.ok) return usage;
  if (usage.value.length !== conflict.count) {
    return fail("reference conflict count does not match usage");
  }
  return { ok: true, value: { count: conflict.count, usage: usage.value } };
}

export function decodeAssetDetail(
  value: unknown,
): DecodeResult<{ asset: Asset; usage: AssetReferrer[] }> {
  const envelope = record(value);
  if (!envelope) return fail("asset detail must be an object");
  const asset = decodeAsset(envelope.asset);
  if (!asset.ok) return asset;
  const usage = decodeAssetUsage(envelope);
  if (!usage.ok) return usage;
  return { ok: true, value: { asset: asset.value, usage: usage.value } };
}

export function decodeAssetFolders(
  value: unknown,
): DecodeResult<AssetFolder[]> {
  const envelope = record(value);
  if (!envelope || envelope.folders === undefined)
    return fail("folder response is missing folders");
  return decodeArray(envelope.folders, "folders", (candidate) => {
    const folder = record(candidate);
    if (!folder) return fail("folder must be an object");
    if (!string(folder.id) || !folder.id.trim())
      return fail("folder.id must be a non-empty string");
    if (!string(folder.name) || !folder.name.trim())
      return fail("folder.name must be a non-empty string");
    if (!string(folder.createdAt) || !folder.createdAt.trim())
      return fail("folder.createdAt must be a non-empty string");
    if (!string(folder.updatedAt) || !folder.updatedAt.trim())
      return fail("folder.updatedAt must be a non-empty string");
    if (!positiveInteger(folder.version))
      return fail("folder.version must be a positive integer");
    if (!string(folder.tenantId) || !canonicalAssetUuid.test(folder.tenantId))
      return fail("folder.tenantId must be a canonical UUID");
    if (!nonNegativeInteger(folder.assetCount))
      return fail("folder.assetCount must be a non-negative integer");
    return { ok: true, value: folder as unknown as AssetFolder };
  });
}

export function decodeAssetTagCounts(
  value: unknown,
): DecodeResult<AssetTagCount[]> {
  const envelope = record(value);
  if (!envelope || envelope.tags === undefined)
    return fail("tag response is missing tags");
  return decodeArray(envelope.tags, "tags", (candidate) => {
    const tag = record(candidate);
    if (!tag) return fail("tag count must be an object");
    if (!string(tag.tag) || !tag.tag.trim())
      return fail("tag must be a non-empty string");
    if (!nonNegativeInteger(tag.count))
      return fail("tag count must be a non-negative integer");
    return { ok: true, value: tag as unknown as AssetTagCount };
  });
}

export function decodeTags(value: unknown): DecodeResult<string[]> {
  const decoded = decodeVersionedTags(value);
  return decoded.ok ? { ok: true, value: decoded.value.tags } : decoded;
}

export function decodeVersionedTags(
  value: unknown,
): DecodeResult<{ tags: string[]; version: number }> {
  const envelope = record(value);
  if (!envelope || envelope.tags === undefined)
    return fail("tag response is missing tags");
  if (
    !Array.isArray(envelope.tags) ||
    !envelope.tags.every((tag) => string(tag) && Boolean(tag.trim()))
  ) {
    return fail("tags must be non-empty strings");
  }
  if (!positiveInteger(envelope.version))
    return fail("tag response version must be a positive integer");
  return {
    ok: true,
    value: { tags: [...envelope.tags] as string[], version: envelope.version },
  };
}

export interface AssetMutationReceipt {
  id: string;
  version: number;
  folderId?: string | null;
}

export function decodeMutationReceipt(
  value: unknown,
): DecodeResult<AssetMutationReceipt> {
  const envelope = record(value);
  if (
    envelope?.ok !== true ||
    !string(envelope.id) ||
    !canonicalAssetUuid.test(envelope.id) ||
    !positiveInteger(envelope.version) ||
    (envelope.folderId !== undefined &&
      envelope.folderId !== null &&
      (!string(envelope.folderId) ||
        !canonicalAssetUuid.test(envelope.folderId)))
  ) {
    return fail(
      "mutation acknowledgement must contain a canonical id and positive version",
    );
  }
  return {
    ok: true,
    value: {
      id: envelope.id,
      version: envelope.version,
      ...(Object.prototype.hasOwnProperty.call(envelope, "folderId")
        ? { folderId: envelope.folderId as string | null }
        : {}),
    },
  };
}

export function decodeMutationAck(value: unknown): DecodeResult<true> {
  const decoded = decodeMutationReceipt(value);
  return decoded.ok ? { ok: true, value: true } : decoded;
}

export function isSupportedAssetFile(
  file: Pick<File, "name" | "type">,
): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = file.type.toLowerCase();
  const acceptedMime = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  return (
    (ASSET_IMAGE_EXTENSIONS as readonly string[]).includes(extension) &&
    (mime === "" || acceptedMime.includes(mime))
  );
}

export function publicAssetDeliveryUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^https:\/\//i.test(raw.trim())) return null;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !isPublicAssetHostname(url.hostname)
    )
      return null;
    if (/^\/api\/v1\/assets\/[^/]+\/blob$/u.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isPublicAssetHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  )
    return false;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }
  const [a, b] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}
