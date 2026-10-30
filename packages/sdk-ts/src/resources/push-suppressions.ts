// SPDX-License-Identifier: MIT

import { PostwaveError } from "../errors.js";
import { Resource } from "./_base.js";

export const PUSH_SUPPRESSION_PLATFORMS = ["apns", "fcm", "web"] as const;
export const PUSH_SUPPRESSION_REASONS = [
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
] as const;
export const PUSH_SUPPRESSION_SOURCES = [
  "dashboard",
  "provider",
  "user",
  "complaint",
  "legacy",
] as const;
export const PUSH_SUPPRESSION_LOCKED_REASONS = [
  "provider_authority",
  "user_opt_out_authority",
  "complaint_authority",
  "legacy_authority_requires_review",
] as const;

export type PushSuppressionPlatform =
  (typeof PUSH_SUPPRESSION_PLATFORMS)[number];
export type PushSuppressionReason = (typeof PUSH_SUPPRESSION_REASONS)[number];
export type PushSuppressionSource = (typeof PUSH_SUPPRESSION_SOURCES)[number];
export type PushSuppressionLockedReason =
  (typeof PUSH_SUPPRESSION_LOCKED_REASONS)[number];

export interface PushSuppressionRow {
  id: string;
  tenant_id: string;
  /** Minimized display fingerprint. The full digest and raw token stay private. */
  device_token_hash: string;
  platform: PushSuppressionPlatform;
  reason: PushSuppressionReason;
  source: PushSuppressionSource;
  created_at: string;
  updated_at: string;
  version: number;
  reversible: boolean;
  locked_reason?: PushSuppressionLockedReason;
}

export interface PushSuppressionsPage {
  tenantId: string;
  items: PushSuppressionRow[];
  total: number;
  nextCursor?: string;
  snapshotAt: string;
}

export interface PushSuppressionListOptions {
  /** Exact response binding. Tenant UUIDs are canonical, not v4-only. */
  tenantId?: string;
  platform?: PushSuppressionPlatform;
  reason?: PushSuppressionReason;
  /** 8–16 lowercase hexadecimal characters from the displayed fingerprint. */
  hashPrefix?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface PushSuppressionAddInput {
  device_token: string;
  platform: PushSuppressionPlatform;
  reason: "manual";
}

export interface PushSuppressionMutationOptions {
  /** Exact response binding. Defaults to the client's local-dev tenant UUID. */
  tenantId?: string;
  signal?: AbortSignal;
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
  items: PushSuppressionRow[];
}

export interface PushSuppressionBulkRemoveItem {
  id: string;
  expected_version: number;
}

export interface PushSuppressionBulkRemoveReceipt {
  ok: true;
  tenantId: string;
  removed: number;
  stillSuppressed: number;
  items: PushSuppressionDeleteReceipt[];
}

type UnknownRecord = Record<string, unknown>;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FINGERPRINT = /^[0-9a-f]{16}$/u;
const HASH_PREFIX = /^[0-9a-f]{8,16}$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const RFC3339_UTC =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const WHITESPACE = /\s/u;
const CONTROL = /\p{Cc}/u;
const SURROGATE = /[\ud800-\udfff]/u;

const PLATFORM_VALUES = new Set<string>(PUSH_SUPPRESSION_PLATFORMS);
const REASON_VALUES = new Set<string>(PUSH_SUPPRESSION_REASONS);
const SOURCE_VALUES = new Set<string>(PUSH_SUPPRESSION_SOURCES);
const ROW_KEYS = new Set([
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
]);

function contractError(
  message = "Invalid push suppression response.",
): PostwaveError {
  return new PostwaveError(message, {
    status: 502,
    code: "invalid_push_suppression_response",
  });
}

function object(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError();
  }
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw contractError();
  }
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const parts = RFC3339_UTC.exec(value);
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
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59
  );
}

function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 2048 &&
    CURSOR.test(value)
  );
}

function validToken(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    WHITESPACE.test(value) ||
    CONTROL.test(value) ||
    SURROGATE.test(value)
  ) {
    return false;
  }
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= 20 && bytes <= 4096;
}

function expectedTenant(
  explicit: string | undefined,
  fallback: string | undefined,
): string {
  const tenantId = explicit ?? fallback;
  if (!tenantId || !TENANT_UUID.test(tenantId)) {
    throw new Error(
      "Push suppression operations require an expected canonical tenant UUID",
    );
  }
  return tenantId;
}

function decodeRow(value: unknown, tenantId: string): PushSuppressionRow {
  const row = object(value);
  exactKeys(row, ROW_KEYS);
  if (
    typeof row.id !== "string" ||
    !UUID_V4.test(row.id) ||
    row.tenant_id !== tenantId ||
    typeof row.device_token_hash !== "string" ||
    !FINGERPRINT.test(row.device_token_hash) ||
    typeof row.platform !== "string" ||
    !PLATFORM_VALUES.has(row.platform) ||
    typeof row.reason !== "string" ||
    !REASON_VALUES.has(row.reason) ||
    typeof row.source !== "string" ||
    !SOURCE_VALUES.has(row.source) ||
    !validTimestamp(row.created_at) ||
    !validTimestamp(row.updated_at) ||
    Date.parse(row.updated_at) < Date.parse(row.created_at) ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 1 ||
    typeof row.reversible !== "boolean"
  ) {
    throw contractError();
  }
  const validAuthority =
    (row.reason === "manual" &&
      row.source === "dashboard" &&
      row.reversible === true &&
      row.locked_reason === undefined) ||
    ((row.reason === "unregistered" || row.reason === "expired") &&
      row.source === "provider" &&
      row.reversible === false &&
      row.locked_reason === "provider_authority") ||
    (row.reason === "user_opt_out" &&
      row.source === "user" &&
      row.reversible === false &&
      row.locked_reason === "user_opt_out_authority") ||
    (row.reason === "complaint" &&
      row.source === "complaint" &&
      row.reversible === false &&
      row.locked_reason === "complaint_authority") ||
    (row.source === "legacy" &&
      row.reversible === false &&
      row.locked_reason === "legacy_authority_requires_review");
  if (!validAuthority) {
    throw contractError();
  }
  return row as unknown as PushSuppressionRow;
}

export function decodePushSuppressionsPage(
  value: unknown,
  expectedTenantId: string,
  options: Omit<PushSuppressionListOptions, "tenantId" | "signal"> = {},
): PushSuppressionsPage {
  if (!TENANT_UUID.test(expectedTenantId)) throw contractError();
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw contractError();
  }
  const page = object(value);
  exactKeys(
    page,
    new Set(["tenantId", "items", "total", "nextCursor", "snapshotAt"]),
  );
  if (
    page.tenantId !== expectedTenantId ||
    !Array.isArray(page.items) ||
    page.items.length > limit ||
    !Number.isSafeInteger(page.total) ||
    (page.total as number) < page.items.length ||
    !validTimestamp(page.snapshotAt) ||
    (page.nextCursor !== undefined && !validCursor(page.nextCursor))
  ) {
    throw contractError();
  }
  const items = page.items.map((item) => decodeRow(item, expectedTenantId));
  const ids = new Set<string>();
  let previous: PushSuppressionRow | undefined;
  for (const item of items) {
    if (
      ids.has(item.id) ||
      (options.platform !== undefined && item.platform !== options.platform) ||
      (options.reason !== undefined && item.reason !== options.reason) ||
      (options.hashPrefix !== undefined &&
        !item.device_token_hash.startsWith(options.hashPrefix)) ||
      (previous !== undefined &&
        (Date.parse(item.created_at) > Date.parse(previous.created_at) ||
          (item.created_at === previous.created_at && item.id >= previous.id)))
    ) {
      throw contractError();
    }
    ids.add(item.id);
    previous = item;
  }
  if (
    page.nextCursor !== undefined &&
    (items.length !== limit || (page.total as number) <= items.length)
  ) {
    throw contractError();
  }
  if (
    options.cursor === undefined &&
    page.nextCursor === undefined &&
    page.total !== items.length
  ) {
    throw contractError();
  }
  return {
    tenantId: expectedTenantId,
    items,
    total: page.total as number,
    snapshotAt: page.snapshotAt as string,
    ...(page.nextCursor === undefined
      ? {}
      : { nextCursor: page.nextCursor as string }),
  };
}

function validatedListQuery(
  options: PushSuppressionListOptions,
): Record<string, string | number> {
  if (
    options.platform !== undefined &&
    !PLATFORM_VALUES.has(options.platform)
  ) {
    throw new Error("Push suppression platform is unsupported");
  }
  if (options.reason !== undefined && !REASON_VALUES.has(options.reason)) {
    throw new Error("Push suppression reason is unsupported");
  }
  if (
    options.hashPrefix !== undefined &&
    !HASH_PREFIX.test(options.hashPrefix)
  ) {
    throw new Error(
      "Push suppression hashPrefix must be 8–16 lowercase hexadecimal characters",
    );
  }
  if (options.cursor !== undefined && !validCursor(options.cursor)) {
    throw new Error("Push suppression cursor is invalid");
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100)
  ) {
    throw new Error("Push suppression limit must be an integer from 1 to 100");
  }
  return {
    limit: options.limit ?? 50,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.hashPrefix === undefined
      ? {}
      : { hash_prefix: options.hashPrefix }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
}

function validatedAdd(input: PushSuppressionAddInput): PushSuppressionAddInput {
  const raw = input as unknown as UnknownRecord;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(raw).some(
      (key) => key !== "device_token" && key !== "platform" && key !== "reason",
    ) ||
    !validToken(raw.device_token) ||
    typeof raw.platform !== "string" ||
    !PLATFORM_VALUES.has(raw.platform) ||
    raw.reason !== "manual"
  ) {
    throw new Error(
      "Push suppression add requires a supported platform, a 20–4096-byte token without whitespace or controls, and reason=manual",
    );
  }
  return input;
}

function decodeDeleteReceipt(
  value: unknown,
  tenantId: string,
  expected: PushSuppressionBulkRemoveItem,
): PushSuppressionDeleteReceipt {
  const receipt = object(value);
  exactKeys(
    receipt,
    new Set(["ok", "tenantId", "id", "version", "stillSuppressed"]),
  );
  if (
    receipt.ok !== true ||
    receipt.tenantId !== tenantId ||
    receipt.id !== expected.id ||
    receipt.version !== expected.expected_version + 1 ||
    typeof receipt.stillSuppressed !== "boolean"
  ) {
    throw contractError();
  }
  return receipt as unknown as PushSuppressionDeleteReceipt;
}

export class PushSuppressionsResource extends Resource {
  async list(
    options: PushSuppressionListOptions = {},
  ): Promise<PushSuppressionsPage> {
    const tenantId = expectedTenant(options.tenantId, this.client.tenantId);
    const query = validatedListQuery(options);
    const raw = await this.client.request<unknown>(
      "GET",
      "/api/v1/push/suppressions",
      { query, signal: options.signal },
    );
    return decodePushSuppressionsPage(raw, tenantId, options);
  }

  async add(
    input: PushSuppressionAddInput,
    options: PushSuppressionMutationOptions = {},
  ): Promise<PushSuppressionRow> {
    const tenantId = expectedTenant(options.tenantId, this.client.tenantId);
    const validated = validatedAdd(input);
    const row = decodeRow(
      await this.client.request<unknown>("POST", "/api/v1/push/suppressions", {
        body: validated,
        signal: options.signal,
      }),
      tenantId,
    );
    if (
      row.platform !== validated.platform ||
      row.reason !== "manual" ||
      row.source !== "dashboard" ||
      !row.reversible
    ) {
      throw contractError(
        "Push suppression creation receipt did not match the requested manual authority.",
      );
    }
    return row;
  }

  async remove(
    id: string,
    expectedVersion: number,
    options: PushSuppressionMutationOptions = {},
  ): Promise<PushSuppressionDeleteReceipt> {
    if (!UUID_V4.test(id)) {
      throw new Error(
        "Push suppression id must be a canonical lowercase UUIDv4",
      );
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("Push suppression expectedVersion must be positive");
    }
    const tenantId = expectedTenant(options.tenantId, this.client.tenantId);
    const expected = { id, expected_version: expectedVersion };
    return decodeDeleteReceipt(
      await this.client.request<unknown>(
        "DELETE",
        `/api/v1/push/suppressions/${id}`,
        { body: { expected_version: expectedVersion }, signal: options.signal },
      ),
      tenantId,
      expected,
    );
  }

  async bulkImport(
    inputs: PushSuppressionAddInput[],
    options: PushSuppressionMutationOptions = {},
  ): Promise<PushSuppressionBulkImportReceipt> {
    const tenantId = expectedTenant(options.tenantId, this.client.tenantId);
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
      throw new Error("Push suppression bulk import requires 1–100 entries");
    }
    const items = inputs.map(validatedAdd);
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.platform}\u0000${item.device_token}`;
      if (seen.has(key)) {
        throw new Error(
          "Push suppression bulk import cannot repeat a platform and token",
        );
      }
      seen.add(key);
    }
    const receipt = object(
      await this.client.request<unknown>(
        "POST",
        "/api/v1/push/suppressions/bulk-import",
        { body: { items }, signal: options.signal },
      ),
    );
    exactKeys(
      receipt,
      new Set(["ok", "tenantId", "created", "existing", "items"]),
    );
    if (
      receipt.ok !== true ||
      receipt.tenantId !== tenantId ||
      !Number.isSafeInteger(receipt.created) ||
      (receipt.created as number) < 0 ||
      !Number.isSafeInteger(receipt.existing) ||
      (receipt.existing as number) < 0 ||
      (receipt.created as number) + (receipt.existing as number) !==
        items.length ||
      !Array.isArray(receipt.items) ||
      receipt.items.length !== items.length
    ) {
      throw contractError();
    }
    const ids = new Set<string>();
    const rows = receipt.items.map((value, index) => {
      const row = decodeRow(value, tenantId);
      if (
        ids.has(row.id) ||
        row.platform !== items[index]?.platform ||
        row.reason !== "manual" ||
        row.source !== "dashboard" ||
        !row.reversible
      ) {
        throw contractError();
      }
      ids.add(row.id);
      return row;
    });
    return {
      ok: true,
      tenantId,
      created: receipt.created as number,
      existing: receipt.existing as number,
      items: rows,
    };
  }

  async bulkRemove(
    inputs: PushSuppressionBulkRemoveItem[],
    options: PushSuppressionMutationOptions = {},
  ): Promise<PushSuppressionBulkRemoveReceipt> {
    const tenantId = expectedTenant(options.tenantId, this.client.tenantId);
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
      throw new Error("Push suppression bulk removal requires 1–100 entries");
    }
    const ids = new Set<string>();
    for (const input of inputs) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (key) => key !== "id" && key !== "expected_version",
        ) ||
        !UUID_V4.test(input.id) ||
        !Number.isSafeInteger(input.expected_version) ||
        input.expected_version < 1 ||
        ids.has(input.id)
      ) {
        throw new Error(
          "Every bulk removal requires a unique canonical row id and positive expected_version",
        );
      }
      ids.add(input.id);
    }
    const receipt = object(
      await this.client.request<unknown>(
        "POST",
        "/api/v1/push/suppressions/bulk-remove",
        { body: { items: inputs }, signal: options.signal },
      ),
    );
    exactKeys(
      receipt,
      new Set(["ok", "tenantId", "removed", "stillSuppressed", "items"]),
    );
    if (
      receipt.ok !== true ||
      receipt.tenantId !== tenantId ||
      receipt.removed !== inputs.length ||
      !Number.isSafeInteger(receipt.stillSuppressed) ||
      (receipt.stillSuppressed as number) < 0 ||
      (receipt.stillSuppressed as number) > inputs.length ||
      !Array.isArray(receipt.items) ||
      receipt.items.length !== inputs.length
    ) {
      throw contractError();
    }
    const receipts = receipt.items.map((value, index) =>
      decodeDeleteReceipt(value, tenantId, inputs[index]!),
    );
    if (
      receipts.filter((item) => item.stillSuppressed).length !==
      receipt.stillSuppressed
    ) {
      throw contractError();
    }
    return {
      ok: true,
      tenantId,
      removed: inputs.length,
      stillSuppressed: receipt.stillSuppressed as number,
      items: receipts,
    };
  }
}
