// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

const BASE = "/api/v1/conversions/ingest-secrets";
const REGISTER_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 512;
const MAX_LABEL_CODE_POINTS = 128;
const MAX_TIMESTAMP_BYTES = 128;
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const KEY_ID = /^[0-9a-f]{32}$/u;
const REVEALED_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const encoder = new TextEncoder();
const SUMMARY_KEYS = new Set(["key_id", "label", "created_at", "revoked_at"]);
const PROJECTION_STATUSES = new Set(["pending", "ready", "failed"]);
const PROJECTION_ERROR_CODES = new Set([
  "secret_unavailable",
  "projection_failed",
]);

export type ConversionIdentityProjectionStatus = "pending" | "ready" | "failed";
export type ConversionIdentityProjectionErrorCode =
  | "secret_unavailable"
  | "projection_failed";

export interface ConversionIngestSecretSummary {
  keyId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  identityProjectionStatus: ConversionIdentityProjectionStatus;
  identityProjectionErrorCode: ConversionIdentityProjectionErrorCode | null;
  identityProjectionUpdatedAt: string;
}

export interface ConversionIngestSecretPage {
  items: ConversionIngestSecretSummary[];
  nextCursor?: string;
}

/** The only client type that may contain the credential returned at issuance. */
export interface IssuedConversionIngestSecret extends ConversionIngestSecretSummary {
  secret: string;
  notice: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    encoder.encode(value).byteLength <= maxBytes &&
    (allowEmpty || value.length > 0)
  );
}

function boundedCodePointText(
  value: unknown,
  maxCodePoints: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    [...value].length <= maxCodePoints &&
    (allowEmpty || value.length > 0)
  );
}

function timestamp(value: unknown): value is string {
  return (
    boundedText(value, MAX_TIMESTAMP_BYTES) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseSummary(
  value: unknown,
  allowIssuedSecret = false,
): ConversionIngestSecretSummary | null {
  const row = record(value);
  const projectionStatus = row?.identity_projection_status;
  const projectionError = row?.identity_projection_error_code;
  if (
    !row ||
    Object.keys(row).some(
      (key) =>
        !SUMMARY_KEYS.has(key) &&
        ![
          "identity_projection_status",
          "identity_projection_error_code",
          "identity_projection_updated_at",
        ].includes(key) &&
        !(allowIssuedSecret && key === "secret"),
    ) ||
    typeof row.key_id !== "string" ||
    !KEY_ID.test(row.key_id) ||
    !boundedCodePointText(row.label, MAX_LABEL_CODE_POINTS, true) ||
    !timestamp(row.created_at) ||
    typeof projectionStatus !== "string" ||
    !PROJECTION_STATUSES.has(projectionStatus) ||
    !timestamp(row.identity_projection_updated_at) ||
    (projectionStatus === "failed"
      ? typeof projectionError !== "string" ||
        !PROJECTION_ERROR_CODES.has(projectionError)
      : projectionError !== undefined && projectionError !== null) ||
    (row.revoked_at !== undefined &&
      row.revoked_at !== null &&
      !timestamp(row.revoked_at))
  ) {
    return null;
  }
  return {
    keyId: row.key_id,
    label: row.label || row.key_id,
    createdAt: row.created_at,
    revokedAt:
      row.revoked_at === undefined || row.revoked_at === null
        ? null
        : row.revoked_at,
    identityProjectionStatus:
      projectionStatus as ConversionIdentityProjectionStatus,
    identityProjectionErrorCode:
      projectionStatus === "failed"
        ? (projectionError as ConversionIdentityProjectionErrorCode)
        : null,
    identityProjectionUpdatedAt: row.identity_projection_updated_at,
  };
}

export function parseConversionIngestSecretRegister(
  payload: unknown,
): ConversionIngestSecretPage {
  const envelope = record(payload);
  if (
    !envelope ||
    Object.keys(envelope).some(
      (key) => key !== "items" && key !== "next_cursor",
    ) ||
    !Array.isArray(envelope.items) ||
    (envelope.next_cursor !== undefined &&
      !boundedText(envelope.next_cursor, MAX_CURSOR_BYTES))
  ) {
    throw new Error("The signed-ingest key register response was malformed.");
  }
  if (envelope.items.length > REGISTER_PAGE_SIZE) {
    throw new Error("The signed-ingest key register exceeded its safe bound.");
  }
  const items = envelope.items.map((item) => parseSummary(item));
  if (items.some((item) => item === null)) {
    throw new Error("The signed-ingest key register contained an invalid row.");
  }
  const parsed = items as ConversionIngestSecretSummary[];
  if (new Set(parsed.map((item) => item.keyId)).size !== parsed.length) {
    throw new Error("The signed-ingest key register contained duplicate IDs.");
  }
  return {
    items: parsed,
    ...(typeof envelope.next_cursor === "string"
      ? { nextCursor: envelope.next_cursor }
      : {}),
  };
}

export function conversionIngestSecretLabelError(
  rawLabel: string,
): string | null {
  const label = rawLabel.trim();
  if (!label) return "Give the signing key a label so rotations are auditable.";
  if (
    CONTROLS.test(label) ||
    [...label].length > MAX_LABEL_CODE_POINTS
  ) {
    return "Use plain text no longer than 128 Unicode characters.";
  }
  return null;
}

export function parseIssuedConversionIngestSecret(
  payload: unknown,
): IssuedConversionIngestSecret {
  const envelope = record(payload);
  const rawIssued = record(envelope?.secret);
  const summary = parseSummary(rawIssued, true);
  if (
    !envelope ||
    !rawIssued ||
    !summary ||
    Object.keys(envelope).some(
      (key) => key !== "secret" && key !== "notice",
    ) ||
    typeof rawIssued.secret !== "string" ||
    !REVEALED_SECRET.test(rawIssued.secret) ||
    !boundedText(envelope.notice, 1_024)
  ) {
    throw new Error(
      "The key may have been issued, but its one-time secret response could not be verified. Review the key register before issuing another key.",
    );
  }
  return { ...summary, secret: rawIssued.secret, notice: envelope.notice };
}

/**
 * Strip the reveal-once credential before updating a register or query cache.
 * The issued response may live only in the reveal state that owns its discard
 * ceremony; registers contain metadata and never the signing secret.
 */
export function issuedConversionIngestSecretSummary(
  issued: IssuedConversionIngestSecret,
): ConversionIngestSecretSummary {
  return {
    keyId: issued.keyId,
    label: issued.label,
    createdAt: issued.createdAt,
    revokedAt: issued.revokedAt,
    identityProjectionStatus: issued.identityProjectionStatus,
    identityProjectionErrorCode: issued.identityProjectionErrorCode,
    identityProjectionUpdatedAt: issued.identityProjectionUpdatedAt,
  };
}

export const conversionIngestSecretsApi = {
  async list(options: { signal?: AbortSignal; cursor?: string } = {}) {
    if (
      options.cursor !== undefined &&
      !boundedText(options.cursor, MAX_CURSOR_BYTES)
    ) {
      throw new Error("Signed-ingest register cursor is invalid.");
    }
    const params = new URLSearchParams({ limit: String(REGISTER_PAGE_SIZE) });
    if (options.cursor) params.set("cursor", options.cursor);
    const payload = await api.get<unknown>(`${BASE}?${params.toString()}`, {
      cache: "no-store",
      signal: options.signal,
    });
    return parseConversionIngestSecretRegister(payload);
  },

  async issue(rawLabel: string): Promise<IssuedConversionIngestSecret> {
    const label = rawLabel.trim();
    const labelError = conversionIngestSecretLabelError(label);
    if (labelError) throw new Error(labelError);
    const payload = await api.post<unknown>(
      BASE,
      { label },
      {
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        // The 201 contains the only copy of the credential. It is excluded
        // from the server replay ledger and must never be queued or retried.
        idempotencyKey: null,
      },
    );
    return parseIssuedConversionIngestSecret(payload);
  },

  async revoke(keyId: string): Promise<{ revoked: true }> {
    const normalized = keyId.trim();
    if (!KEY_ID.test(normalized)) {
      throw new Error("Signed-ingest key ID is invalid.");
    }
    const payload = await api.post<unknown>(
      `${BASE}/${encodeURIComponent(normalized)}/revoke`,
      {},
      { cache: "no-store", requireOnline: true, maxAttempts: 1 },
    );
    if (record(payload)?.revoked !== true) {
      throw new Error(
        "The server did not confirm signed-ingest key revocation.",
      );
    }
    return { revoked: true };
  },
};

/**
 * Exact backend v2 preimage, expressed for operators without ever placing a
 * plaintext address in the HTTP body. UTF-8 lengths are byte lengths.
 */
export const CONVERSION_INGEST_V2_CONTRACT = [
  "X-Postwave-Signature: keyid=<id>,v2=<hex>",
  "X-Postwave-Timestamp: <Unix seconds>",
  "Idempotency-Key: <stable retry key>",
  "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
  "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
] as const;
