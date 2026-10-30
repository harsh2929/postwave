import type { ApiRequester, ApiResult } from "./result";

/**
 * Private Route 43 contract for tenant-customer push suppression authority.
 *
 * This registry is intentionally separate from Moosewave operator-device
 * notifications (`mobile_push_devices`) and browser notification subscriptions.
 * The wire never returns a replayable device token or its full global digest;
 * `device_token_hash` is a bounded display fingerprint only.
 */

export const PUSH_PLATFORMS = [
  { value: "apns", label: "APNs (iOS)" },
  { value: "fcm", label: "FCM (Android)" },
  { value: "web", label: "Web push" },
] as const;

export type PushSuppressionPlatform = (typeof PUSH_PLATFORMS)[number]["value"];

export const PUSH_SUPPRESSION_REASONS = [
  { value: "manual", label: "Manual" },
  { value: "unregistered", label: "Unregistered" },
  { value: "expired", label: "Expired" },
  { value: "complaint", label: "Complaint" },
  { value: "user_opt_out", label: "User opt-out" },
] as const;

export type PushSuppressionReason =
  (typeof PUSH_SUPPRESSION_REASONS)[number]["value"];

/** Bounded public provenance; internal provider identifiers never cross the API. */
export type PushSuppressionSource =
  | "dashboard"
  | "provider"
  | "user"
  | "complaint"
  | "legacy";

export type PushSuppressionLockedReason =
  | "provider_authority"
  | "user_opt_out_authority"
  | "complaint_authority"
  | "legacy_authority_requires_review";

export interface PushSuppressionRow {
  id: string;
  /** Canonical tenant binding; must equal the active workspace identity. */
  tenant_id: string;
  /** Minimized 16-character lowercase-hex display fingerprint, never the full digest. */
  device_token_hash: string;
  platform: PushSuppressionPlatform;
  reason: PushSuppressionReason;
  source: PushSuppressionSource;
  created_at: string;
  updated_at: string;
  version: number;
  /** Only an operator-authored manual authority can be reversed here. */
  reversible: boolean;
  locked_reason?: PushSuppressionLockedReason;
}

export interface PushSuppressionListResponse {
  tenantId: string;
  items: PushSuppressionRow[];
  total: number;
  nextCursor?: string;
  snapshotAt: string;
}

export interface PushSuppressionDeleteReceipt {
  ok: true;
  tenantId: string;
  id: string;
  version: number;
  /** Another independent provider/user authority may still hold the token. */
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

export interface PushSuppressionApiIdentityOptions {
  getApiIdentityGeneration?: () => number | null;
  getTenantId?: () => string | null;
}

type UnknownRecord = Record<string, unknown>;

interface IdentitySnapshot {
  generation: number;
  tenantId: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const FINGERPRINT = /^[0-9a-f]{16}$/u;
const HASH_PREFIX = /^[0-9a-f]{8,16}$/u;
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const WHITESPACE = /\s/u;
const LONE_SURROGATE = /[\ud800-\udfff]/u;

const PLATFORM_VALUES = new Set<string>(
  PUSH_PLATFORMS.map(({ value }) => value),
);
const REASON_VALUES = new Set<string>(
  PUSH_SUPPRESSION_REASONS.map(({ value }) => value),
);
const SOURCE_VALUES = new Set<string>([
  "dashboard",
  "provider",
  "user",
  "complaint",
  "legacy",
]);
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

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isTimestamp(value: unknown): value is string {
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
    day <= daysInMonth(year, month) &&
    Number(parts[4]) <= 23 &&
    Number(parts[5]) <= 59 &&
    Number(parts[6]) <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    !(offsetHour === 14 && offsetMinute !== 0)
  );
}

function isCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 4 &&
    value.length <= 2048 &&
    CURSOR.test(value)
  );
}

function validRawToken(
  token: string,
  _platform: PushSuppressionPlatform,
): boolean {
  const byteLength = new TextEncoder().encode(token).byteLength;
  if (
    byteLength < 20 ||
    byteLength > 4096 ||
    token.trim() !== token ||
    CONTROLS.test(token) ||
    WHITESPACE.test(token) ||
    LONE_SURROGATE.test(token)
  ) {
    return false;
  }
  return true;
}

export function createPushSuppressionsApi(
  request: ApiRequester,
  options: PushSuppressionApiIdentityOptions = {},
) {
  const getTenantId = options.getTenantId ?? (() => null);
  const getApiIdentityGeneration =
    options.getApiIdentityGeneration ?? (() => 0);

  function captureIdentity(): IdentitySnapshot | null {
    const tenantId = getTenantId();
    const generation = getApiIdentityGeneration();
    return typeof tenantId === "string" &&
      TENANT_UUID.test(tenantId) &&
      Number.isSafeInteger(generation) &&
      (generation as number) >= 0
      ? { generation: generation as number, tenantId }
      : null;
  }

  function identityIsCurrent(identity: IdentitySnapshot): boolean {
    return (
      getTenantId() === identity.tenantId &&
      getApiIdentityGeneration() === identity.generation
    );
  }

  function invalidRequest<T>(message: string): ApiResult<T> {
    return {
      error: {
        kind: "invalid_config",
        code: "invalid_push_suppression_request",
        message,
      },
      retryability: "not-retryable",
    };
  }

  function invalidResponse<T>(): ApiResult<T> {
    return {
      error: {
        kind: "parse",
        code: "invalid_push_suppression_response",
        message:
          "The push service returned a suppression response that did not match the verified private contract.",
      },
      retryability: "not-retryable",
    };
  }

  function identityChanged<T>(): ApiResult<T> {
    return {
      error: {
        kind: "network",
        code: "identity_changed",
        message:
          "This response belongs to a previous workspace identity and was discarded.",
      },
      retryability: "not-retryable",
    };
  }

  function isRow(
    value: unknown,
    identity: IdentitySnapshot,
  ): value is PushSuppressionRow {
    if (!isRecord(value) || !hasOnlyKeys(value, ROW_KEYS)) return false;
    if (
      typeof value.id !== "string" ||
      !UUID.test(value.id) ||
      value.tenant_id !== identity.tenantId ||
      typeof value.device_token_hash !== "string" ||
      !FINGERPRINT.test(value.device_token_hash) ||
      typeof value.platform !== "string" ||
      !PLATFORM_VALUES.has(value.platform) ||
      typeof value.reason !== "string" ||
      !REASON_VALUES.has(value.reason) ||
      typeof value.source !== "string" ||
      !SOURCE_VALUES.has(value.source) ||
      !isTimestamp(value.created_at) ||
      !isTimestamp(value.updated_at) ||
      Date.parse(value.updated_at) < Date.parse(value.created_at) ||
      !Number.isSafeInteger(value.version) ||
      (value.version as number) < 1 ||
      typeof value.reversible !== "boolean"
    ) {
      return false;
    }
    return (
      (value.reason === "manual" &&
        value.source === "dashboard" &&
        value.reversible === true &&
        value.locked_reason === undefined) ||
      ((value.reason === "unregistered" || value.reason === "expired") &&
        value.source === "provider" &&
        value.reversible === false &&
        value.locked_reason === "provider_authority") ||
      (value.reason === "user_opt_out" &&
        value.source === "user" &&
        value.reversible === false &&
        value.locked_reason === "user_opt_out_authority") ||
      (value.reason === "complaint" &&
        value.source === "complaint" &&
        value.reversible === false &&
        value.locked_reason === "complaint_authority") ||
      (value.source === "legacy" &&
        value.reversible === false &&
        value.locked_reason === "legacy_authority_requires_review")
    );
  }

  function isPage(
    value: unknown,
    identity: IdentitySnapshot,
    opts: {
      platform?: PushSuppressionPlatform;
      reason?: PushSuppressionReason;
      query?: string;
      cursor?: string;
      limit: number;
    },
  ): value is PushSuppressionListResponse {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(
        value,
        new Set(["tenantId", "items", "total", "nextCursor", "snapshotAt"]),
      ) ||
      value.tenantId !== identity.tenantId ||
      !Array.isArray(value.items) ||
      value.items.length > opts.limit ||
      !value.items.every((item) => isRow(item, identity)) ||
      !Number.isSafeInteger(value.total) ||
      (value.total as number) < value.items.length ||
      !isTimestamp(value.snapshotAt) ||
      (value.nextCursor !== undefined && !isCursor(value.nextCursor))
    ) {
      return false;
    }
    const ids = new Set<string>();
    let prior: PushSuppressionRow | undefined;
    for (const item of value.items as PushSuppressionRow[]) {
      const at = Date.parse(item.created_at);
      if (
        ids.has(item.id) ||
        (opts.platform !== undefined && item.platform !== opts.platform) ||
        (opts.reason !== undefined && item.reason !== opts.reason) ||
        (opts.query !== undefined &&
          !item.device_token_hash.startsWith(opts.query))
      ) {
        return false;
      }
      if (
        prior &&
        (at > Date.parse(prior.created_at) ||
          (at === Date.parse(prior.created_at) && item.id >= prior.id))
      ) {
        return false;
      }
      ids.add(item.id);
      prior = item;
    }
    if (
      value.nextCursor !== undefined &&
      (value.items.length !== opts.limit ||
        (value.total as number) <= value.items.length)
    ) {
      return false;
    }
    return !(
      opts.cursor === undefined &&
      value.nextCursor === undefined &&
      value.total !== value.items.length
    );
  }

  async function decode<T>(
    pending: Promise<ApiResult<unknown>>,
    identity: IdentitySnapshot,
    guard: (value: unknown) => value is T,
  ): Promise<ApiResult<T>> {
    const result = await pending;
    if (!identityIsCurrent(identity)) return identityChanged<T>();
    if ("error" in result && result.error) return result;
    if (!guard(result.data)) return invalidResponse<T>();
    return { ...result, data: result.data };
  }

  return {
    list(
      opts: {
        platform?: PushSuppressionPlatform;
        reason?: PushSuppressionReason;
        query?: string;
        cursor?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApiResult<PushSuppressionListResponse>> {
      const identity = captureIdentity();
      const limit = opts.limit ?? 50;
      if (!identity) {
        return Promise.resolve(
          invalidRequest(
            "A stable canonical workspace identity is required before loading push suppressions.",
          ),
        );
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return Promise.resolve(
          invalidRequest("Push suppression page size must be 1–100."),
        );
      }
      if (opts.platform !== undefined && !PLATFORM_VALUES.has(opts.platform)) {
        return Promise.resolve(
          invalidRequest("Push suppression platform is not supported."),
        );
      }
      if (opts.reason !== undefined && !REASON_VALUES.has(opts.reason)) {
        return Promise.resolve(
          invalidRequest("Push suppression reason is not supported."),
        );
      }
      if (opts.query !== undefined && !HASH_PREFIX.test(opts.query)) {
        return Promise.resolve(
          invalidRequest(
            "Push suppression fingerprint search requires 8–16 lowercase hexadecimal characters.",
          ),
        );
      }
      if (opts.cursor !== undefined && !isCursor(opts.cursor)) {
        return Promise.resolve(
          invalidRequest("Push suppression cursor is malformed."),
        );
      }
      const params = new URLSearchParams();
      if (opts.platform) params.set("platform", opts.platform);
      if (opts.reason) params.set("reason", opts.reason);
      if (opts.query) params.set("hash_prefix", opts.query);
      if (opts.cursor) params.set("cursor", opts.cursor);
      params.set("limit", String(limit));
      return decode(
        request<unknown>(
          `/api/v1/push/suppressions?${params.toString()}`,
          opts.signal ? { signal: opts.signal } : undefined,
        ),
        identity,
        (value): value is PushSuppressionListResponse =>
          isPage(value, identity, { ...opts, limit }),
      );
    },

    add(
      input: {
        device_token: string;
        platform: PushSuppressionPlatform;
        reason: "manual";
      },
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<PushSuppressionRow>> {
      const identity = captureIdentity();
      if (
        !identity ||
        !isRecord(input) ||
        !hasOnlyKeys(input, new Set(["device_token", "platform", "reason"])) ||
        typeof input.platform !== "string" ||
        !PLATFORM_VALUES.has(input.platform) ||
        input.reason !== "manual" ||
        typeof input.device_token !== "string" ||
        !validRawToken(input.device_token, input.platform)
      ) {
        return Promise.resolve(
          invalidRequest(
            "A manual push suppression requires a stable workspace, supported platform, and canonical token without whitespace or control characters.",
          ),
        );
      }
      return decode(
        request<unknown>(
          "/api/v1/push/suppressions",
          {
            method: "POST",
            body: JSON.stringify(input),
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          { requireOnline: true },
        ),
        identity,
        (value): value is PushSuppressionRow =>
          isRow(value, identity) &&
          value.platform === input.platform &&
          value.reason === "manual" &&
          value.source === "dashboard" &&
          value.reversible,
      );
    },

    remove(
      id: string,
      input: { expected_version: number },
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<PushSuppressionDeleteReceipt>> {
      const identity = captureIdentity();
      if (
        !identity ||
        !UUID.test(id) ||
        !isRecord(input) ||
        !hasOnlyKeys(input, new Set(["expected_version"])) ||
        !Number.isSafeInteger(input.expected_version) ||
        input.expected_version < 1
      ) {
        return Promise.resolve(
          invalidRequest(
            "Manual push suppression removal requires a stable workspace, canonical row id, and reviewed version.",
          ),
        );
      }
      return decode(
        request<unknown>(
          `/api/v1/push/suppressions/${encodeURIComponent(id)}`,
          {
            method: "DELETE",
            body: JSON.stringify(input),
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          { requireOnline: true },
        ),
        identity,
        (value): value is PushSuppressionDeleteReceipt =>
          isRecord(value) &&
          hasOnlyKeys(
            value,
            new Set(["ok", "tenantId", "id", "version", "stillSuppressed"]),
          ) &&
          value.ok === true &&
          value.tenantId === identity.tenantId &&
          value.id === id &&
          typeof value.stillSuppressed === "boolean" &&
          value.version === input.expected_version + 1,
      );
    },

    bulkImport(
      items: Array<{
        device_token: string;
        platform: PushSuppressionPlatform;
        reason: "manual";
      }>,
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<PushSuppressionBulkImportReceipt>> {
      const identity = captureIdentity();
      if (
        !identity ||
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 100
      ) {
        return Promise.resolve(
          invalidRequest(
            "Bulk push suppression import requires a stable workspace and 1–100 manual entries.",
          ),
        );
      }
      const seen = new Set<string>();
      for (const item of items) {
        if (
          !isRecord(item) ||
          !hasOnlyKeys(item, new Set(["device_token", "platform", "reason"])) ||
          typeof item.platform !== "string" ||
          !PLATFORM_VALUES.has(item.platform) ||
          item.reason !== "manual" ||
          typeof item.device_token !== "string" ||
          !validRawToken(
            item.device_token,
            item.platform as PushSuppressionPlatform,
          )
        ) {
          return Promise.resolve(
            invalidRequest(
              "Every bulk import entry must contain one supported platform, a canonical token, and reason=manual.",
            ),
          );
        }
        const key = `${item.platform}\u0000${item.device_token}`;
        if (seen.has(key)) {
          return Promise.resolve(
            invalidRequest(
              "Bulk push suppression import cannot repeat a platform and device token.",
            ),
          );
        }
        seen.add(key);
      }
      return decode(
        request<unknown>(
          "/api/v1/push/suppressions/bulk-import",
          {
            method: "POST",
            body: JSON.stringify({ items }),
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          { requireOnline: true },
        ),
        identity,
        (value): value is PushSuppressionBulkImportReceipt => {
          if (
            !isRecord(value) ||
            !hasOnlyKeys(
              value,
              new Set(["ok", "tenantId", "created", "existing", "items"]),
            ) ||
            value.ok !== true ||
            value.tenantId !== identity.tenantId ||
            !Number.isSafeInteger(value.created) ||
            (value.created as number) < 0 ||
            !Number.isSafeInteger(value.existing) ||
            (value.existing as number) < 0 ||
            (value.created as number) + (value.existing as number) !==
              items.length ||
            !Array.isArray(value.items) ||
            value.items.length !== items.length
          ) {
            return false;
          }
          const ids = new Set<string>();
          return value.items.every(
            (candidate, index) =>
              isRow(candidate, identity) &&
              !ids.has(candidate.id) &&
              (ids.add(candidate.id), true) &&
              candidate.platform === items[index]?.platform &&
              candidate.reason === "manual" &&
              candidate.source === "dashboard" &&
              candidate.reversible,
          );
        },
      );
    },

    bulkRemove(
      items: PushSuppressionBulkRemoveItem[],
      opts: { signal?: AbortSignal } = {},
    ): Promise<ApiResult<PushSuppressionBulkRemoveReceipt>> {
      const identity = captureIdentity();
      if (
        !identity ||
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > 100
      ) {
        return Promise.resolve(
          invalidRequest(
            "Bulk push suppression removal requires a stable workspace and 1–100 reviewed rows.",
          ),
        );
      }
      const ids = new Set<string>();
      for (const item of items) {
        if (
          !isRecord(item) ||
          !hasOnlyKeys(item, new Set(["id", "expected_version"])) ||
          typeof item.id !== "string" ||
          !UUID.test(item.id) ||
          !Number.isSafeInteger(item.expected_version) ||
          (item.expected_version as number) < 1 ||
          ids.has(item.id)
        ) {
          return Promise.resolve(
            invalidRequest(
              "Every bulk removal entry must contain one unique canonical row id and positive reviewed version.",
            ),
          );
        }
        ids.add(item.id);
      }
      return decode(
        request<unknown>(
          "/api/v1/push/suppressions/bulk-remove",
          {
            method: "POST",
            body: JSON.stringify({ items }),
            ...(opts.signal ? { signal: opts.signal } : {}),
          },
          { requireOnline: true },
        ),
        identity,
        (value): value is PushSuppressionBulkRemoveReceipt => {
          if (
            !isRecord(value) ||
            !hasOnlyKeys(
              value,
              new Set([
                "ok",
                "tenantId",
                "removed",
                "stillSuppressed",
                "items",
              ]),
            ) ||
            value.ok !== true ||
            value.tenantId !== identity.tenantId ||
            value.removed !== items.length ||
            !Number.isSafeInteger(value.stillSuppressed) ||
            (value.stillSuppressed as number) < 0 ||
            (value.stillSuppressed as number) > items.length ||
            !Array.isArray(value.items) ||
            value.items.length !== items.length
          ) {
            return false;
          }
          let stillSuppressed = 0;
          const valid = value.items.every((candidate, index) => {
            const expected = items[index];
            if (
              !expected ||
              !isRecord(candidate) ||
              !hasOnlyKeys(
                candidate,
                new Set(["ok", "tenantId", "id", "version", "stillSuppressed"]),
              ) ||
              candidate.ok !== true ||
              candidate.tenantId !== identity.tenantId ||
              candidate.id !== expected.id ||
              candidate.version !== expected.expected_version + 1 ||
              typeof candidate.stillSuppressed !== "boolean"
            ) {
              return false;
            }
            if (candidate.stillSuppressed) stillSuppressed += 1;
            return true;
          });
          return valid && stillSuppressed === value.stillSuppressed;
        },
      );
    },
  };
}
