// SPDX-License-Identifier: MIT

import { ParseError, PostwaveError } from "../errors.js";
import { Resource } from "./_base.js";

const COLLECTION_PATH = "/api/v1/conversions/ingest-secrets";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const MAX_CURSOR_BYTES = 512;
const MAX_TIMESTAMP_BYTES = 128;
const MAX_LABEL_CODE_POINTS = 128;
const CONTROLS = /\p{Cc}/u;
const KEY_ID = /^[0-9a-f]{32}$/u;
// 32 raw bytes encode as 43 unpadded base64url characters. The final sextet
// carries four data bits, so its two RFC 4648 pad bits must be zero.
const REVEALED_SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const encoder = new TextEncoder();

export const CONVERSION_INGEST_SECRET_NOTICE =
  "This is the only time the secret is shown. Store it now; it cannot be recovered, only replaced.";

/** The only safe recovery after an issuance result could have been lost. */
export const CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY =
  "list signing-key metadata, identify any newly issued key ID, revoke it, then issue a replacement; never retry issuance blindly";

export type ConversionEmailHMACProjectionStatus =
  | "pending"
  | "ready"
  | "failed";

export type ConversionEmailHMACProjectionErrorCode =
  | "secret_unavailable"
  | "projection_failed";

/** Metadata-only register entry. Plaintext secret material is unrepresentable. */
export interface ConversionIngestSecretSummary {
  keyId: string;
  label: string;
  createdAt: string;
  revokedAt?: string;
  identityProjectionStatus: ConversionEmailHMACProjectionStatus;
  identityProjectionErrorCode?: ConversionEmailHMACProjectionErrorCode;
  identityProjectionUpdatedAt: string;
}

export interface ConversionIngestSecretPage {
  items: ConversionIngestSecretSummary[];
  nextCursor?: string;
}

/** The reveal-once value returned only by issue(). Store and then discard it. */
export interface IssuedConversionIngestSecret extends Omit<
  ConversionIngestSecretSummary,
  "revokedAt"
> {
  secret: string;
  notice: typeof CONVERSION_INGEST_SECRET_NOTICE;
}

export interface ConversionIngestSecretListOptions {
  /** Defaults to 100; the server and SDK cap every page at 100. */
  limit?: number;
  /** Opaque cursor returned by the immediately preceding page. */
  cursor?: string;
  signal?: AbortSignal;
}

export interface ConversionIngestSecretIssueOptions {
  signal?: AbortSignal;
}

/**
 * The request may have committed even though its one-time response was lost or
 * malformed. Never call issue() again blindly; follow `recovery` first.
 */
export class AmbiguousConversionIngestSecretIssueError extends PostwaveError {
  readonly recovery = CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY;

  constructor() {
    super(
      `Conversion signing-key issuance is ambiguous; ${CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY}.`,
      {
        status: 0,
        code: "ambiguous_conversion_ingest_secret_issue",
      },
    );
    this.name = "AmbiguousConversionIngestSecretIssueError";
  }
}

export class ConversionIngestSecretsResource extends Resource {
  /** Return exactly one bounded, metadata-only page; never auto-walk. */
  async list(
    options: ConversionIngestSecretListOptions = {},
  ): Promise<ConversionIngestSecretPage> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new TypeError(
        "conversion signing-key limit must be an integer from 1 to 100",
      );
    }
    if (options.cursor !== undefined) validateCursor(options.cursor, "cursor");
    const payload = await this.client.request<unknown>("GET", COLLECTION_PATH, {
      query: { limit, cursor: options.cursor },
      signal: options.signal,
    });
    return parsePage(payload, options.cursor);
  }

  /**
   * Mint a reveal-once key with no Idempotency-Key and exactly one transport
   * attempt. After an ambiguous result, reconcile the register, revoke the
   * possible new key, and issue a replacement; never retry this call blindly.
   */
  async issue(
    label = "",
    options: ConversionIngestSecretIssueOptions = {},
  ): Promise<IssuedConversionIngestSecret> {
    validateLabel(label);
    let payload: unknown;
    try {
      payload = await this.client.request<unknown>("POST", COLLECTION_PATH, {
        body: label === "" ? {} : { label },
        idempotencyKey: null,
        expectedStatus: 201,
        signal: options.signal,
      });
    } catch (error) {
      // A concrete 4xx (including 429) proves the operation was rejected. A
      // transport failure, 5xx, or successful-but-unparseable body does not.
      if (
        error instanceof PostwaveError &&
        !(error instanceof ParseError) &&
        error.status >= 400 &&
        error.status < 500
      ) {
        throw error;
      }
      // Do not retain the cause: a malformed 201 may still contain the only
      // plaintext secret, and exception payloads are commonly logged.
      throw new AmbiguousConversionIngestSecretIssueError();
    }
    try {
      return parseIssued(payload, label);
    } catch {
      throw new AmbiguousConversionIngestSecretIssueError();
    }
  }

  /** Permanently revoke and cryptoshred one exact key. */
  async revoke(
    keyId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ revoked: true }> {
    if (!KEY_ID.test(keyId)) {
      throw new TypeError(
        "conversion signing-key id must be exactly 32 lowercase hexadecimal characters",
      );
    }
    const payload = await this.client.request<unknown>(
      "POST",
      `${COLLECTION_PATH}/${keyId}/revoke`,
      { signal: options.signal },
    );
    const value = record(payload);
    if (!value || !hasExactKeys(value, ["revoked"]) || value.revoked !== true) {
      throw new TypeError(
        "invalid closed conversion signing-key revocation receipt",
      );
    }
    return { revoked: true };
  }
}

function parsePage(
  payload: unknown,
  requestCursor: string | undefined,
): ConversionIngestSecretPage {
  const page = record(payload);
  if (
    !page ||
    !hasOnlyKeys(page, ["items", "next_cursor"]) ||
    !("items" in page)
  ) {
    throw new TypeError("invalid closed conversion signing-key page");
  }
  if (!Array.isArray(page.items) || page.items.length > MAX_LIMIT) {
    throw new TypeError("invalid bounded conversion signing-key page");
  }
  const items = page.items.map((item) => parseSummary(item, false));
  if (new Set(items.map((item) => item.keyId)).size !== items.length) {
    throw new TypeError(
      "conversion signing-key page contains duplicate key ids",
    );
  }
  if (page.next_cursor !== undefined) {
    validateCursor(page.next_cursor, "next_cursor");
    if (page.next_cursor === requestCursor) {
      throw new TypeError(
        "conversion signing-key page repeated its request cursor",
      );
    }
    return { items, nextCursor: page.next_cursor };
  }
  return { items };
}

function parseIssued(
  payload: unknown,
  expectedLabel: string,
): IssuedConversionIngestSecret {
  const envelope = record(payload);
  if (
    !envelope ||
    !hasExactKeys(envelope, ["notice", "secret"]) ||
    envelope.notice !== CONVERSION_INGEST_SECRET_NOTICE
  ) {
    throw new TypeError("invalid closed reveal-once signing-key envelope");
  }
  const issued = parseSummary(envelope.secret, true);
  const raw = record(envelope.secret);
  if (
    !raw ||
    issued.label !== expectedLabel ||
    typeof raw.secret !== "string" ||
    !REVEALED_SECRET.test(raw.secret) ||
    issued.identityProjectionStatus !== "pending" ||
    issued.identityProjectionErrorCode !== undefined
  ) {
    throw new TypeError("invalid reveal-once conversion signing secret");
  }
  return {
    keyId: issued.keyId,
    label: issued.label,
    createdAt: issued.createdAt,
    identityProjectionStatus: "pending",
    identityProjectionUpdatedAt: issued.identityProjectionUpdatedAt,
    secret: raw.secret,
    notice: CONVERSION_INGEST_SECRET_NOTICE,
  };
}

function parseSummary(
  payload: unknown,
  issued: boolean,
): ConversionIngestSecretSummary {
  const value = record(payload);
  const allowed = issued
    ? [
        "key_id",
        "secret",
        "label",
        "created_at",
        "identity_projection_status",
        "identity_projection_error_code",
        "identity_projection_updated_at",
      ]
    : [
        "key_id",
        "label",
        "created_at",
        "revoked_at",
        "identity_projection_status",
        "identity_projection_error_code",
        "identity_projection_updated_at",
      ];
  const required = [
    "key_id",
    "label",
    "created_at",
    "identity_projection_status",
    "identity_projection_updated_at",
  ];
  if (
    !value ||
    !hasOnlyKeys(value, allowed) ||
    !required.every((key) => key in value)
  ) {
    throw new TypeError("invalid closed conversion signing-key object");
  }
  if (typeof value.key_id !== "string" || !KEY_ID.test(value.key_id)) {
    throw new TypeError("invalid conversion signing-key id");
  }
  validateLabel(value.label);
  validateTimestamp(value.created_at, "created_at");
  validateTimestamp(
    value.identity_projection_updated_at,
    "identity_projection_updated_at",
  );
  const status = value.identity_projection_status;
  if (status !== "pending" && status !== "ready" && status !== "failed") {
    throw new TypeError("invalid conversion identity projection status");
  }
  let errorCode: ConversionEmailHMACProjectionErrorCode | undefined;
  if (status === "failed") {
    if (
      value.identity_projection_error_code !== "secret_unavailable" &&
      value.identity_projection_error_code !== "projection_failed"
    ) {
      throw new TypeError(
        "failed identity projection omits its bounded error code",
      );
    }
    errorCode = value.identity_projection_error_code;
  } else if ("identity_projection_error_code" in value) {
    throw new TypeError("non-failed identity projection exposes an error code");
  }
  let revokedAt: string | undefined;
  if ("revoked_at" in value) {
    validateTimestamp(value.revoked_at, "revoked_at");
    revokedAt = value.revoked_at;
  }
  return {
    keyId: value.key_id,
    label: value.label,
    createdAt: value.created_at,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    identityProjectionStatus: status,
    ...(errorCode === undefined
      ? {}
      : { identityProjectionErrorCode: errorCode }),
    identityProjectionUpdatedAt: value.identity_projection_updated_at,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    Object.keys(value).length === expected.length &&
    hasOnlyKeys(value, expected)
  );
}

function validateLabel(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value !== value.trim() ||
    CONTROLS.test(value) ||
    Array.from(value).length > MAX_LABEL_CODE_POINTS
  ) {
    throw new TypeError(
      "conversion signing-key label must be at most 128 Unicode characters without controls or surrounding whitespace",
    );
  }
}

function validateCursor(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROLS.test(value) ||
    encoder.encode(value).byteLength > MAX_CURSOR_BYTES
  ) {
    throw new TypeError(`${field} must be a bounded opaque cursor`);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    encoder.encode(value).byteLength > MAX_TIMESTAMP_BYTES
  ) {
    throw new TypeError(`invalid ${field}`);
  }
  const match = RFC3339.exec(value);
  if (!match) throw new TypeError(`invalid ${field}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
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
    throw new TypeError(`invalid ${field}`);
  }
}
