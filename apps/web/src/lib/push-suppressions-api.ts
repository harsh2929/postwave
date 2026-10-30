// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Strict web boundary for the private customer push-suppression registry.
 *
 * Raw device tokens exist only in the caller's short-lived form state and the
 * request body. They are never returned from this module, placed in a query
 * key, or accepted as proof that a response belongs to the current tenant.
 */
import { api } from "@/lib/api";
import {
  effectiveAuthRole,
  type MeResponse,
} from "@/lib/auth-api";
import {
  decodePushSuppressionRegistryRow,
  PushSuppressionRegistryContractError,
  type PushSuppressionRegistryPage,
  type PushSuppressionRegistryRow,
} from "@/lib/consent-evidence-api";

export const PUSH_SUPPRESSION_PLATFORMS = ["apns", "fcm", "web"] as const;
export const PUSH_SUPPRESSION_REASONS = [
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
] as const;

export type PushSuppressionPlatform =
  (typeof PUSH_SUPPRESSION_PLATFORMS)[number];
export type PushSuppressionReason =
  (typeof PUSH_SUPPRESSION_REASONS)[number];

export interface PushSuppressionPage extends PushSuppressionRegistryPage {
  /** Cursor used to request this page; absent only on the first page. */
  requestCursor?: string;
}

export interface PushSuppressionDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
  version: number;
  stillSuppressed: boolean;
}

export interface PushSuppressionBulkImportReceipt {
  ok: true;
  tenantId: string;
  created: number;
  existing: number;
  items: PushSuppressionRegistryRow[];
}

export interface PushSuppressionBulkRemoveItem {
  id: string;
  expectedVersion: number;
}

export interface PushSuppressionBulkRemoveReceipt {
  ok: true;
  tenantId: string;
  removed: number;
  stillSuppressed: number;
  items: PushSuppressionDeleteReceipt[];
}

export class PushSuppressionManagementContractError extends Error {
  constructor(
    message = "The customer push registry returned an unverifiable write receipt.",
  ) {
    super(message);
    this.name = "PushSuppressionManagementContractError";
  }
}

export class PushSuppressionManagementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushSuppressionManagementInputError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PREFIX = /^[0-9a-f]{8,16}$/u;
const CURSOR = /^[A-Za-z0-9_-]{4,2048}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const TOKEN_WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const authorityBrand = Symbol("push-suppression-admin-authority");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function canonicalTenant(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function safeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !CONTROLS.test(value)
  );
}

function strictTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 64 ||
    value.trim() !== value ||
    CONTROLS.test(value)
  ) {
    return false;
  }
  const parts = RFC3339.exec(value);
  const parsed = Date.parse(value);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  ) {
    return false;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const offsetHour = Number(parts[8] ?? 0);
  const offsetMinute = Number(parts[9] ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    !(offsetHour === 14 && offsetMinute !== 0)
  );
}

export interface PushSuppressionAdminAuthority {
  readonly tenantId: string;
  readonly userId: string;
  readonly [authorityBrand]: true;
}

/** Mint write authority only from a freshly fetched, exact identity. */
export function authorizePushSuppressionAdmin(
  me: MeResponse,
  expectedTenantId: string,
  expectedUserId: string,
): PushSuppressionAdminAuthority {
  const role = effectiveAuthRole(me);
  if (
    !canonicalTenant(expectedTenantId) ||
    !safeIdentity(expectedUserId) ||
    me.tenant_id !== expectedTenantId ||
    me.user_id !== expectedUserId ||
    me.viewer_mode === true ||
    (role !== "owner" && role !== "admin")
  ) {
    throw new PushSuppressionManagementInputError(
      "Your workspace identity or effective admin role changed.",
    );
  }
  return Object.freeze({
    tenantId: expectedTenantId,
    userId: expectedUserId,
    [authorityBrand]: true as const,
  });
}

function assertAuthority(
  value: PushSuppressionAdminAuthority,
): asserts value is PushSuppressionAdminAuthority {
  if (
    !isRecord(value) ||
    value[authorityBrand] !== true ||
    !canonicalTenant(value.tenantId) ||
    !safeIdentity(value.userId)
  ) {
    throw new PushSuppressionManagementInputError(
      "Fresh tenant-bound admin authorization is required.",
    );
  }
}

function assertPlatform(value: unknown): asserts value is PushSuppressionPlatform {
  if (
    typeof value !== "string" ||
    !PUSH_SUPPRESSION_PLATFORMS.includes(value as PushSuppressionPlatform)
  ) {
    throw new PushSuppressionManagementInputError(
      "Choose APNs, FCM, or Web push.",
    );
  }
}

function assertReason(value: unknown): asserts value is PushSuppressionReason {
  if (
    typeof value !== "string" ||
    !PUSH_SUPPRESSION_REASONS.includes(value as PushSuppressionReason)
  ) {
    throw new PushSuppressionManagementInputError(
      "Choose a supported suppression reason.",
    );
  }
}

export function validateRawPushToken(
  token: string,
  platform: PushSuppressionPlatform,
): string | null {
  try {
    assertPlatform(platform);
  } catch {
    return "Choose a supported push platform.";
  }
  if (typeof token !== "string") return "Enter a device token.";
  const bytes = new TextEncoder().encode(token).byteLength;
  if (bytes < 20 || bytes > 4096) {
    return "The token must be 20–4,096 UTF-8 bytes.";
  }
  if (
    TOKEN_WHITESPACE_OR_CONTROL.test(token) ||
    hasLoneSurrogate(token)
  ) {
    return "Use the exact token without whitespace or control characters.";
  }
  return null;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validatePushHashPrefix(value: string): string | null {
  if (value === "" || HASH_PREFIX.test(value)) return null;
  return "Use 8–16 lowercase hexadecimal fingerprint characters.";
}

function assertRawToken(token: string, platform: PushSuppressionPlatform) {
  const message = validateRawPushToken(token, platform);
  if (message) throw new PushSuppressionManagementInputError(message);
}

async function tokenFingerprint(token: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new PushSuppressionManagementContractError(
      "This browser cannot verify the registry write receipt.",
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeRow(
  value: unknown,
  tenantId: string,
): PushSuppressionRegistryRow {
  try {
    return decodePushSuppressionRegistryRow(value, tenantId);
  } catch (cause) {
    if (cause instanceof PushSuppressionRegistryContractError) {
      throw new PushSuppressionManagementContractError();
    }
    throw cause;
  }
}

export function rowCanBeRemoved(row: PushSuppressionRegistryRow): boolean {
  return (
    row.reversible &&
    row.reason === "manual" &&
    row.source === "dashboard" &&
    row.lockedReason === undefined
  );
}

export interface ListPushSuppressionsInput {
  tenantId: string;
  platform?: PushSuppressionPlatform;
  reason?: PushSuppressionReason;
  hashPrefix?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export function decodePushSuppressionPage(
  value: unknown,
  input: Omit<ListPushSuppressionsInput, "signal">,
): PushSuppressionPage {
  const limit = input.limit ?? 100;
  if (
    !canonicalTenant(input.tenantId) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.platform !== undefined &&
      !PUSH_SUPPRESSION_PLATFORMS.includes(input.platform)) ||
    (input.reason !== undefined &&
      !PUSH_SUPPRESSION_REASONS.includes(input.reason)) ||
    (input.hashPrefix !== undefined && !HASH_PREFIX.test(input.hashPrefix)) ||
    (input.cursor !== undefined && !CURSOR.test(input.cursor)) ||
    !isRecord(value) ||
    !hasExactlyKeys(
      value,
      ["tenantId", "items", "total", "snapshotAt"],
      ["nextCursor"],
    ) ||
    value.tenantId !== input.tenantId ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < value.items.length ||
    !strictTimestamp(value.snapshotAt) ||
    (value.nextCursor !== undefined &&
      (typeof value.nextCursor !== "string" || !CURSOR.test(value.nextCursor)))
  ) {
    throw new PushSuppressionManagementContractError(
      "The customer push registry returned an unverifiable page.",
    );
  }
  const rows: PushSuppressionRegistryRow[] = [];
  const ids = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const candidate of value.items) {
    const row = decodeRow(candidate, input.tenantId);
    const at = Date.parse(row.createdAt);
    if (
      ids.has(row.id) ||
      (input.platform !== undefined && row.platform !== input.platform) ||
      (input.reason !== undefined && row.reason !== input.reason) ||
      (input.hashPrefix !== undefined &&
        !row.fingerprint.startsWith(input.hashPrefix)) ||
      at > previousAt ||
      (at === previousAt && previousId !== "" && row.id >= previousId)
    ) {
      throw new PushSuppressionManagementContractError(
        "The customer push registry returned an unverifiable page.",
      );
    }
    ids.add(row.id);
    rows.push(row);
    previousAt = at;
    previousId = row.id;
  }
  const nextCursor = value.nextCursor as string | undefined;
  if (
    (nextCursor !== undefined &&
      (rows.length !== limit || Number(value.total) <= rows.length)) ||
    (input.cursor === undefined &&
      nextCursor === undefined &&
      Number(value.total) !== rows.length)
  ) {
    throw new PushSuppressionManagementContractError(
      "The customer push registry returned impossible pagination geometry.",
    );
  }
  return {
    tenantId: input.tenantId,
    items: rows,
    total: Number(value.total),
    snapshotAt: value.snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
    ...(input.cursor ? { requestCursor: input.cursor } : {}),
  };
}

export async function listPushSuppressions(
  input: ListPushSuppressionsInput,
): Promise<PushSuppressionPage> {
  const limit = input.limit ?? 100;
  if (!canonicalTenant(input.tenantId)) {
    throw new PushSuppressionManagementInputError(
      "A canonical workspace identity is required.",
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PushSuppressionManagementInputError("Page size must be 1–100.");
  }
  if (input.platform !== undefined) assertPlatform(input.platform);
  if (input.reason !== undefined) assertReason(input.reason);
  if (
    input.hashPrefix !== undefined &&
    validatePushHashPrefix(input.hashPrefix) !== null
  ) {
    throw new PushSuppressionManagementInputError(
      "Fingerprint search requires 8–16 lowercase hexadecimal characters.",
    );
  }
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" || !CURSOR.test(input.cursor))
  ) {
    throw new PushSuppressionManagementInputError("Pagination cursor is malformed.");
  }
  const params = new URLSearchParams();
  if (input.platform) params.set("platform", input.platform);
  if (input.reason) params.set("reason", input.reason);
  if (input.hashPrefix) params.set("hash_prefix", input.hashPrefix);
  if (input.cursor) params.set("cursor", input.cursor);
  params.set("limit", String(limit));
  const response = await api.get<unknown>(
    `/api/v1/push/suppressions?${params.toString()}`,
    { signal: input.signal },
  );
  return decodePushSuppressionPage(response, {
    tenantId: input.tenantId,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.hashPrefix ? { hashPrefix: input.hashPrefix } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit,
  });
}

export function mergePushSuppressionPages(
  pages: readonly PushSuppressionPage[],
): PushSuppressionRegistryPage & { hasMore: boolean } {
  if (pages.length === 0) {
    throw new PushSuppressionManagementContractError(
      "No verified push registry page is available.",
    );
  }
  const first = pages[0]!;
  if (first.requestCursor !== undefined) {
    throw new PushSuppressionManagementContractError();
  }
  const items: PushSuppressionRegistryRow[] = [];
  const ids = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const prior = index > 0 ? pages[index - 1] : undefined;
    if (
      page.tenantId !== first.tenantId ||
      page.snapshotAt !== first.snapshotAt ||
      page.total !== first.total ||
      (prior && page.requestCursor !== prior.nextCursor) ||
      (!prior && page.requestCursor !== undefined)
    ) {
      throw new PushSuppressionManagementContractError();
    }
    for (const row of page.items) {
      const at = Date.parse(row.createdAt);
      if (
        ids.has(row.id) ||
        at > previousAt ||
        (at === previousAt && previousId !== "" && row.id >= previousId)
      ) {
        throw new PushSuppressionManagementContractError();
      }
      ids.add(row.id);
      items.push(row);
      previousAt = at;
      previousId = row.id;
    }
  }
  const last = pages.at(-1)!;
  if (
    items.length > first.total ||
    (!last.nextCursor && items.length !== first.total) ||
    (last.nextCursor && items.length >= first.total)
  ) {
    throw new PushSuppressionManagementContractError();
  }
  return {
    tenantId: first.tenantId,
    items,
    total: first.total,
    snapshotAt: first.snapshotAt,
    ...(last.nextCursor ? { nextCursor: last.nextCursor } : {}),
    hasMore: Boolean(last.nextCursor),
  };
}

export async function addPushSuppression(
  authority: PushSuppressionAdminAuthority,
  input: { deviceToken: string; platform: PushSuppressionPlatform },
  options: { signal?: AbortSignal } = {},
): Promise<PushSuppressionRegistryRow> {
  assertAuthority(authority);
  assertPlatform(input.platform);
  assertRawToken(input.deviceToken, input.platform);
  const expectedFingerprint = await tokenFingerprint(input.deviceToken);
  const response = await api.post<unknown>(
    "/api/v1/push/suppressions",
    {
      device_token: input.deviceToken,
      platform: input.platform,
      reason: "manual",
    },
    { signal: options.signal, requireOnline: true, maxAttempts: 1 },
  );
  const row = decodeRow(response, authority.tenantId);
  if (
    row.platform !== input.platform ||
    row.fingerprint !== expectedFingerprint ||
    !rowCanBeRemoved(row)
  ) {
    throw new PushSuppressionManagementContractError();
  }
  return row;
}

function decodeDeleteReceipt(
  value: unknown,
  authority: PushSuppressionAdminAuthority,
  expected: PushSuppressionBulkRemoveItem,
): PushSuppressionDeleteReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "ok",
      "tenantId",
      "id",
      "version",
      "stillSuppressed",
    ]) ||
    value.ok !== true ||
    value.tenantId !== authority.tenantId ||
    value.id !== expected.id ||
    value.version !== expected.expectedVersion + 1 ||
    typeof value.stillSuppressed !== "boolean"
  ) {
    throw new PushSuppressionManagementContractError();
  }
  return {
    ok: true,
    tenantId: authority.tenantId,
    id: expected.id,
    version: expected.expectedVersion + 1,
    stillSuppressed: value.stillSuppressed,
  };
}

function assertRemovalItem(item: PushSuppressionBulkRemoveItem) {
  if (
    !isRecord(item) ||
    !hasExactlyKeys(item, ["id", "expectedVersion"]) ||
    typeof item.id !== "string" ||
    !UUID_V4.test(item.id) ||
    !Number.isSafeInteger(item.expectedVersion) ||
    item.expectedVersion < 1 ||
    item.expectedVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw new PushSuppressionManagementInputError(
      "Removal requires a canonical row id and its reviewed positive version.",
    );
  }
}

export async function removePushSuppression(
  authority: PushSuppressionAdminAuthority,
  item: PushSuppressionBulkRemoveItem,
  options: { signal?: AbortSignal } = {},
): Promise<PushSuppressionDeleteReceipt> {
  assertAuthority(authority);
  assertRemovalItem(item);
  const response = await api.delete<unknown>(
    `/api/v1/push/suppressions/${encodeURIComponent(item.id)}`,
    {
      body: { expected_version: item.expectedVersion },
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  return decodeDeleteReceipt(response, authority, item);
}

export interface PushSuppressionImportItem {
  deviceToken: string;
  platform: PushSuppressionPlatform;
}

function assertImportItems(items: readonly PushSuppressionImportItem[]) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new PushSuppressionManagementInputError(
      "Bulk import requires 1–100 reviewed entries.",
    );
  }
  const seen = new Set<string>();
  for (const item of items) {
    if (
      !isRecord(item) ||
      !hasExactlyKeys(item, ["deviceToken", "platform"]) ||
      typeof item.deviceToken !== "string"
    ) {
      throw new PushSuppressionManagementInputError(
        "Each import entry requires exactly one platform and token.",
      );
    }
    assertPlatform(item.platform);
    assertRawToken(item.deviceToken, item.platform);
    const key = `${item.platform}\u0000${item.deviceToken}`;
    if (seen.has(key)) {
      throw new PushSuppressionManagementInputError(
        "Bulk import cannot repeat a platform and token.",
      );
    }
    seen.add(key);
  }
}

export async function bulkImportPushSuppressions(
  authority: PushSuppressionAdminAuthority,
  items: readonly PushSuppressionImportItem[],
  options: { signal?: AbortSignal } = {},
): Promise<PushSuppressionBulkImportReceipt> {
  assertAuthority(authority);
  assertImportItems(items);
  const fingerprints = await Promise.all(
    items.map((item) => tokenFingerprint(item.deviceToken)),
  );
  const response = await api.post<unknown>(
    "/api/v1/push/suppressions/bulk-import",
    {
      items: items.map((item) => ({
        device_token: item.deviceToken,
        platform: item.platform,
        reason: "manual",
      })),
    },
    { signal: options.signal, requireOnline: true, maxAttempts: 1 },
  );
  if (
    !isRecord(response) ||
    !hasExactlyKeys(response, [
      "ok",
      "tenantId",
      "created",
      "existing",
      "items",
    ]) ||
    response.ok !== true ||
    response.tenantId !== authority.tenantId ||
    !Number.isSafeInteger(response.created) ||
    Number(response.created) < 0 ||
    !Number.isSafeInteger(response.existing) ||
    Number(response.existing) < 0 ||
    Number(response.created) + Number(response.existing) !== items.length ||
    !Array.isArray(response.items) ||
    response.items.length !== items.length
  ) {
    throw new PushSuppressionManagementContractError();
  }
  const ids = new Set<string>();
  const decoded = response.items.map((candidate, index) => {
    const row = decodeRow(candidate, authority.tenantId);
    if (
      ids.has(row.id) ||
      row.platform !== items[index]?.platform ||
      row.fingerprint !== fingerprints[index] ||
      !rowCanBeRemoved(row)
    ) {
      throw new PushSuppressionManagementContractError();
    }
    ids.add(row.id);
    return row;
  });
  return {
    ok: true,
    tenantId: authority.tenantId,
    created: Number(response.created),
    existing: Number(response.existing),
    items: decoded,
  };
}

export async function bulkRemovePushSuppressions(
  authority: PushSuppressionAdminAuthority,
  items: readonly PushSuppressionBulkRemoveItem[],
  options: { signal?: AbortSignal } = {},
): Promise<PushSuppressionBulkRemoveReceipt> {
  assertAuthority(authority);
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new PushSuppressionManagementInputError(
      "Bulk removal requires 1–100 reviewed rows.",
    );
  }
  const ids = new Set<string>();
  for (const item of items) {
    assertRemovalItem(item);
    if (ids.has(item.id)) {
      throw new PushSuppressionManagementInputError(
        "Bulk removal cannot repeat a row id.",
      );
    }
    ids.add(item.id);
  }
  const response = await api.post<unknown>(
    "/api/v1/push/suppressions/bulk-remove",
    {
      items: items.map((item) => ({
        id: item.id,
        expected_version: item.expectedVersion,
      })),
    },
    { signal: options.signal, requireOnline: true, maxAttempts: 1 },
  );
  if (
    !isRecord(response) ||
    !hasExactlyKeys(response, [
      "ok",
      "tenantId",
      "removed",
      "stillSuppressed",
      "items",
    ]) ||
    response.ok !== true ||
    response.tenantId !== authority.tenantId ||
    response.removed !== items.length ||
    !Number.isSafeInteger(response.stillSuppressed) ||
    Number(response.stillSuppressed) < 0 ||
    Number(response.stillSuppressed) > items.length ||
    !Array.isArray(response.items) ||
    response.items.length !== items.length
  ) {
    throw new PushSuppressionManagementContractError();
  }
  let stillSuppressed = 0;
  const receipts = response.items.map((candidate, index) => {
    const receipt = decodeDeleteReceipt(
      candidate,
      authority,
      items[index]!,
    );
    if (receipt.stillSuppressed) stillSuppressed += 1;
    return receipt;
  });
  if (stillSuppressed !== response.stillSuppressed) {
    throw new PushSuppressionManagementContractError();
  }
  return {
    ok: true,
    tenantId: authority.tenantId,
    removed: items.length,
    stillSuppressed,
    items: receipts,
  };
}

export type PushSuppressionImportParseResult =
  | {
      ok: true;
      items: PushSuppressionImportItem[];
      platformCounts: Record<PushSuppressionPlatform, number>;
    }
  | { ok: false; message: string };

function parseCsvFields(line: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (closedQuote) {
      if (character !== ",") return null;
      fields.push(field);
      field = "";
      closedQuote = false;
    } else if (character === ",") {
      fields.push(field);
      field = "";
    } else if (character === '"' && field.length === 0) quoted = true;
    else if (character === '"') return null;
    else field += character;
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

export function parsePushSuppressionImportCsv(
  raw: string,
): PushSuppressionImportParseResult {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    new TextEncoder().encode(raw).byteLength > 512 * 1024
  ) {
    return { ok: false, message: "Choose a non-empty CSV no larger than 512 KB." };
  }
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  if (CONTROLS.test(source.replace(/[\r\n]/gu, "")) || BIDI_CONTROLS.test(source)) {
    return { ok: false, message: "The CSV contains unsupported control characters." };
  }
  const lines = source.split(/\r?\n/u);
  while (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "platform,device_token") {
    return { ok: false, message: "The CSV header must be exactly platform,device_token." };
  }
  if (lines.length < 1 || lines.length > 100) {
    return { ok: false, message: "Include 1–100 reviewed token rows." };
  }
  const platformCounts: Record<PushSuppressionPlatform, number> = {
    apns: 0,
    fcm: 0,
    web: 0,
  };
  const items: PushSuppressionImportItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const fields = parseCsvFields(lines[index]!);
    const platform = fields?.[0];
    const token = fields?.[1];
    if (
      fields?.length !== 2 ||
      !PUSH_SUPPRESSION_PLATFORMS.includes(platform as PushSuppressionPlatform) ||
      token === undefined
    ) {
      return {
        ok: false,
        message: `Row ${index + 2} must contain a supported platform and one token.`,
      };
    }
    const typedPlatform = platform as PushSuppressionPlatform;
    const validation = validateRawPushToken(token, typedPlatform);
    if (validation) return { ok: false, message: `Row ${index + 2}: ${validation}` };
    const key = `${typedPlatform}\u0000${token}`;
    if (seen.has(key)) {
      return {
        ok: false,
        message: `Row ${index + 2} repeats an earlier platform and token.`,
      };
    }
    seen.add(key);
    platformCounts[typedPlatform] += 1;
    items.push({ deviceToken: token, platform: typedPlatform });
  }
  return { ok: true, items, platformCounts };
}

// ---------------------------------------------------------------------------
// Client-side CSV export of the verified registry page (fingerprints only)
// ---------------------------------------------------------------------------

function pushCsvCell(value: string | number | boolean): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Builds the CSV for the loaded, verified registry rows. Only the privacy-safe
 * fingerprint is written — the raw device token never reaches the client, so
 * it cannot leak here. Column order matches the desktop export so a file from
 * either surface round-trips through the same tooling. BOM + CRLF for Excel.
 */
export function buildPushSuppressionCsv(
  rows: readonly PushSuppressionRegistryRow[],
): string {
  const header = [
    "fingerprint",
    "platform",
    "reason",
    "source",
    "created_at",
    "updated_at",
    "version",
    "reversible",
    "locked_reason",
  ];
  const records = rows.map((row) =>
    [
      row.fingerprint,
      row.platform,
      row.reason,
      row.source,
      row.createdAt,
      row.updatedAt,
      row.version,
      row.reversible,
      row.lockedReason ?? "",
    ]
      .map(pushCsvCell)
      .join(","),
  );
  return `\uFEFF${[header.join(","), ...records].join("\r\n")}\r\n`;
}

/** Stable filename for the fingerprint export. */
export function pushSuppressionExportFilename(now: Date = new Date()): string {
  return `push-suppressions-fingerprints-${now.toISOString().slice(0, 10)}.csv`;
}
