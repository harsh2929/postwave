/** Strict Route43 tenant-customer push-suppression projections. */
import { WireShapeError } from "./deliverabilityContracts";
import { isPushSuppressionFingerprint } from "./pushSuppressionPresentation";

export * from "./pushSuppressionPresentation";

export const PUSH_PLATFORMS = ["apns", "fcm", "web"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

export const PUSH_SUPPRESSION_REASONS = [
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
] as const;
export type PushSuppressionReason = (typeof PUSH_SUPPRESSION_REASONS)[number];

export const PUSH_LOCKED_REASONS = [
  "provider_authority",
  "user_opt_out_authority",
  "complaint_authority",
  "legacy_authority_requires_review",
] as const;
export type PushLockedReason = (typeof PUSH_LOCKED_REASONS)[number];

export const PUSH_SUPPRESSION_SOURCES = [
  "dashboard",
  "provider",
  "user",
  "complaint",
  "legacy",
] as const;
export type PushSuppressionSource = (typeof PUSH_SUPPRESSION_SOURCES)[number];

export interface PushSuppressionRow {
  id: string;
  tenantId: string;
  /** A non-replayable, lowercase 16-hex fingerprint; never the token or full hash. */
  deviceTokenHash: string;
  platform: PushPlatform;
  reason: PushSuppressionReason;
  source: PushSuppressionSource;
  createdAt: string;
  updatedAt: string;
  version: number;
  reversible: boolean;
  lockedReason?: PushLockedReason | undefined;
}

export interface PushSuppressionsPage {
  tenantId: string;
  items: PushSuppressionRow[];
  total: number;
  snapshotAt: string;
  nextCursor?: string | undefined;
}

export interface PushSuppressionRemovalReceipt {
  ok: true;
  tenantId: string;
  id: string;
  version: number;
  stillSuppressed: boolean;
}

const ROW_KEYS = [
  "id",
  "tenant_id",
  "device_token_hash",
  "platform",
  "reason",
  "source",
  "created_at",
  "updated_at",
  "version",
  "reversible",
  "locked_reason",
] as const;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,2048}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return "";
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  return value;
}

function timestamp(value: unknown): string {
  const raw = text(value, 64);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      raw,
    );
  const parsed = Date.parse(raw);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  )
    return "";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 14 ||
    (Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0) ||
    Number(parts[9] ?? 0) > 59
  )
    return "";
  return raw;
}

function validRowFields(input: {
  id: string;
  tenantId: string;
  expectedTenantId: string;
  fingerprint: string;
  platform: string;
  expectedPlatform?: PushPlatform;
  reason: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  version: unknown;
  reversible: unknown;
}): boolean {
  if (
    !UUID_V4.test(input.id) ||
    !CANONICAL_UUID.test(input.expectedTenantId) ||
    input.tenantId !== input.expectedTenantId
  )
    return false;
  if (!isPushSuppressionFingerprint(input.fingerprint)) return false;
  if (!PUSH_PLATFORMS.includes(input.platform as PushPlatform)) return false;
  if (
    input.expectedPlatform !== undefined &&
    input.platform !== input.expectedPlatform
  )
    return false;
  if (!PUSH_SUPPRESSION_REASONS.includes(input.reason as PushSuppressionReason))
    return false;
  if (!PUSH_SUPPRESSION_SOURCES.includes(input.source as PushSuppressionSource))
    return false;
  if (!input.createdAt || !input.updatedAt) return false;
  if (Date.parse(input.createdAt) > Date.parse(input.updatedAt)) return false;
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 1)
    return false;
  return typeof input.reversible === "boolean";
}

function validAuthorityProjection(
  source: string,
  reason: string,
  reversible: boolean,
  lockedReasonPresent: boolean,
  lockedReason: string,
): boolean {
  if (reversible) {
    return (
      source === "dashboard" && reason === "manual" && !lockedReasonPresent
    );
  }
  if (
    !lockedReasonPresent ||
    !PUSH_LOCKED_REASONS.includes(lockedReason as PushLockedReason)
  ) {
    return false;
  }
  switch (source) {
    case "provider":
      return (
        (reason === "unregistered" || reason === "expired") &&
        lockedReason === "provider_authority"
      );
    case "user":
      return (
        reason === "user_opt_out" && lockedReason === "user_opt_out_authority"
      );
    case "complaint":
      return reason === "complaint" && lockedReason === "complaint_authority";
    case "legacy":
      return lockedReason === "legacy_authority_requires_review";
    default:
      return false;
  }
}

export function decodePushRow(
  raw: unknown,
  expectedTenantId: string,
  expectedPlatform?: PushPlatform,
): PushSuppressionRow | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ROW_KEYS)) return null;
  const id = text(raw.id, 36);
  const tenantId = text(raw.tenant_id, 36);
  const fingerprint = text(raw.device_token_hash, 16);
  const platform = text(raw.platform, 16);
  const reason = text(raw.reason, 32);
  const source = text(raw.source, 64);
  const createdAt = timestamp(raw.created_at);
  const updatedAt = timestamp(raw.updated_at);
  const lockedReasonPresent = Object.prototype.hasOwnProperty.call(
    raw,
    "locked_reason",
  );
  const lockedReason = lockedReasonPresent ? text(raw.locked_reason, 64) : "";
  const reversible = raw.reversible;
  if (
    !validRowFields({
      id,
      tenantId,
      expectedTenantId,
      fingerprint,
      platform,
      ...(expectedPlatform === undefined ? {} : { expectedPlatform }),
      reason,
      source,
      createdAt,
      updatedAt,
      version: raw.version,
      reversible,
    })
  )
    return null;
  if (typeof reversible !== "boolean") return null;
  if (
    !validAuthorityProjection(
      source,
      reason,
      reversible,
      lockedReasonPresent,
      lockedReason,
    )
  ) {
    return null;
  }
  return {
    id,
    tenantId,
    deviceTokenHash: fingerprint,
    platform: platform as PushPlatform,
    reason: reason as PushSuppressionReason,
    source: source as PushSuppressionSource,
    createdAt,
    updatedAt,
    version: Number(raw.version),
    reversible,
    ...(lockedReason ? { lockedReason: lockedReason as PushLockedReason } : {}),
  };
}

function validPageEnvelope(
  value: unknown,
  expectedTenantId: string,
  expectedLimit: number,
): value is Record<string, unknown> & { items: unknown[]; total: number } {
  if (!CANONICAL_UUID.test(expectedTenantId)) return false;
  if (
    !Number.isSafeInteger(expectedLimit) ||
    expectedLimit < 1 ||
    expectedLimit > 100
  )
    return false;
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "tenantId",
      "items",
      "total",
      "nextCursor",
      "snapshotAt",
    ])
  )
    return false;
  if (value.tenantId !== expectedTenantId || !Array.isArray(value.items))
    return false;
  if (value.items.length > expectedLimit || !Number.isSafeInteger(value.total))
    return false;
  return Number(value.total) >= value.items.length;
}

/** Strict frozen row/envelope contract. A malformed row invalidates the page. */
export function parsePushSuppressions(
  value: unknown,
  expectedTenantId: string,
  expectedLimit = 100,
  expectedPlatform?: PushPlatform,
): PushSuppressionsPage {
  if (!validPageEnvelope(value, expectedTenantId, expectedLimit)) {
    throw new WireShapeError("push suppression registry");
  }
  const snapshotAt = timestamp(value.snapshotAt);
  const nextCursor =
    value.nextCursor === undefined ? "" : text(value.nextCursor, 2048);
  if (
    !snapshotAt ||
    (value.nextCursor !== undefined && !CURSOR.test(nextCursor))
  ) {
    throw new WireShapeError("push suppression registry");
  }
  const items: PushSuppressionRow[] = [];
  const ids = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const raw of value.items) {
    const row = decodePushRow(raw, expectedTenantId, expectedPlatform);
    const at = row ? Date.parse(row.createdAt) : Number.NaN;
    if (
      !row ||
      ids.has(row.id) ||
      at > previousAt ||
      (at === previousAt && previousId !== "" && row.id >= previousId)
    ) {
      throw new WireShapeError("push suppression registry");
    }
    ids.add(row.id);
    previousAt = at;
    previousId = row.id;
    items.push(row);
  }
  if (
    nextCursor &&
    (items.length !== expectedLimit || Number(value.total) <= items.length)
  ) {
    throw new WireShapeError("push suppression registry");
  }
  return {
    tenantId: expectedTenantId,
    items,
    total: Number(value.total),
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function mergePushSuppressionPages(
  pages: readonly PushSuppressionsPage[],
) {
  if (pages.length === 0)
    return { items: [], total: 0, snapshotAt: null, hasMore: false };
  const first = pages[0]!;
  const items: PushSuppressionRow[] = [];
  const ids = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const page of pages) {
    if (
      page.tenantId !== first.tenantId ||
      page.snapshotAt !== first.snapshotAt ||
      page.total !== first.total
    ) {
      throw new WireShapeError("push suppression registry");
    }
    for (const row of page.items) {
      const at = Date.parse(row.createdAt);
      if (
        ids.has(row.id) ||
        at > previousAt ||
        (at === previousAt && previousId !== "" && row.id >= previousId)
      ) {
        throw new WireShapeError("push suppression registry");
      }
      ids.add(row.id);
      previousAt = at;
      previousId = row.id;
      items.push(row);
    }
  }
  const hasMore = Boolean(pages.at(-1)?.nextCursor);
  if (
    items.length > first.total ||
    (!hasMore && items.length !== first.total)
  ) {
    throw new WireShapeError("push suppression registry");
  }
  return { items, total: first.total, snapshotAt: first.snapshotAt, hasMore };
}

export function parsePushSuppressionRemovalReceipt(
  value: unknown,
  expected: { tenantId: string; id: string; version: number },
): PushSuppressionRemovalReceipt {
  if (
    !CANONICAL_UUID.test(expected.tenantId) ||
    !UUID_V4.test(expected.id) ||
    !Number.isSafeInteger(expected.version) ||
    expected.version < 1 ||
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "ok",
      "tenantId",
      "id",
      "version",
      "stillSuppressed",
    ]) ||
    Object.keys(value).length !== 5 ||
    value.ok !== true ||
    value.tenantId !== expected.tenantId ||
    value.id !== expected.id ||
    value.version !== expected.version + 1 ||
    typeof value.stillSuppressed !== "boolean"
  )
    throw new WireShapeError("push suppression removal receipt");
  return value as unknown as PushSuppressionRemovalReceipt;
}

export function isReversibleManualPushSuppression(
  row: PushSuppressionRow,
): boolean {
  return (
    UUID_V4.test(row.id) &&
    CANONICAL_UUID.test(row.tenantId) &&
    isPushSuppressionFingerprint(row.deviceTokenHash) &&
    PUSH_PLATFORMS.includes(row.platform) &&
    Number.isSafeInteger(row.version) &&
    row.version >= 1 &&
    row.reversible &&
    row.reason === "manual" &&
    row.source === "dashboard" &&
    !Object.prototype.hasOwnProperty.call(row, "lockedReason")
  );
}
