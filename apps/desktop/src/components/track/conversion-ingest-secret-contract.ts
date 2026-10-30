// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversionIngestSecretIssueResponse } from "../../lib/api-client";

const encoder = new TextEncoder();
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const KEY_ID = /^[0-9a-f]{32}$/u;
const REVEALED_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const SUMMARY_KEYS = new Set([
  "key_id",
  "label",
  "created_at",
  "revoked_at",
  "identity_projection_status",
  "identity_projection_error_code",
  "identity_projection_updated_at",
]);
const PROJECTION_STATUSES = new Set(["pending", "ready", "failed"]);
const PROJECTION_ERROR_CODES = new Set([
  "secret_unavailable",
  "projection_failed",
]);

export type VerifiedIdentityProjectionStatus = "pending" | "ready" | "failed";
export type VerifiedIdentityProjectionErrorCode =
  | "secret_unavailable"
  | "projection_failed";

export interface VerifiedConversionIngestSecret {
  keyId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  identityProjectionStatus: VerifiedIdentityProjectionStatus;
  identityProjectionErrorCode: VerifiedIdentityProjectionErrorCode | null;
  identityProjectionUpdatedAt: string;
}

export interface VerifiedIssuedConversionIngestSecret extends VerifiedConversionIngestSecret {
  secret: string;
  notice: string;
}

export interface VerifiedConversionIngestSecretPage {
  items: VerifiedConversionIngestSecret[];
  nextCursor?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bounded(
  value: unknown,
  bytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    encoder.encode(value).byteLength <= bytes &&
    (allowEmpty || value.length > 0)
  );
}

function boundedCodePoints(
  value: unknown,
  maxCodePoints: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    Array.from(value).length <= maxCodePoints &&
    (allowEmpty || value.length > 0)
  );
}

function timestamp(value: unknown): value is string {
  return bounded(value, 128) && Number.isFinite(Date.parse(value));
}

function parseSummary(
  value: unknown,
  allowIssuedSecret: boolean,
): VerifiedConversionIngestSecret | null {
  const row = record(value);
  const projectionStatus = row?.identity_projection_status;
  const projectionError = row?.identity_projection_error_code;
  if (
    !row ||
    Object.keys(row).some(
      (key) =>
        !SUMMARY_KEYS.has(key) && !(allowIssuedSecret && key === "secret"),
    ) ||
    typeof row.key_id !== "string" ||
    !KEY_ID.test(row.key_id) ||
    !boundedCodePoints(row.label, 128, true) ||
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
      projectionStatus as VerifiedIdentityProjectionStatus,
    identityProjectionErrorCode:
      projectionStatus === "failed"
        ? (projectionError as VerifiedIdentityProjectionErrorCode)
        : null,
    identityProjectionUpdatedAt: row.identity_projection_updated_at,
  };
}

export function parseConversionIngestSecretRegister(
  payload: unknown,
): VerifiedConversionIngestSecretPage | null {
  const envelope = record(payload);
  if (
    !envelope ||
    Object.keys(envelope).some(
      (key) => key !== "items" && key !== "next_cursor",
    ) ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > 100 ||
    (envelope.next_cursor !== undefined && !bounded(envelope.next_cursor, 512))
  ) {
    return null;
  }
  const parsed = envelope.items.map((item) => parseSummary(item, false));
  if (parsed.some((item) => item === null)) return null;
  const items = parsed as VerifiedConversionIngestSecret[];
  if (new Set(items.map((item) => item.keyId)).size !== items.length) {
    return null;
  }
  return {
    items,
    ...(typeof envelope.next_cursor === "string"
      ? { nextCursor: envelope.next_cursor }
      : {}),
  };
}

export function parseIssuedConversionIngestSecret(
  payload: ConversionIngestSecretIssueResponse | unknown,
): VerifiedIssuedConversionIngestSecret | null {
  const envelope = record(payload);
  const wireSecret = record(envelope?.secret);
  const summary = parseSummary(wireSecret, true);
  if (
    !envelope ||
    !wireSecret ||
    !summary ||
    Object.keys(envelope).some((key) => key !== "secret" && key !== "notice") ||
    typeof wireSecret.secret !== "string" ||
    !REVEALED_SECRET.test(wireSecret.secret) ||
    !bounded(envelope.notice, 1_024)
  ) {
    return null;
  }
  return { ...summary, secret: wireSecret.secret, notice: envelope.notice };
}

/** Metadata-only projection for the register; never retain the revealed secret. */
export function issuedConversionIngestSecretSummary(
  issued: VerifiedIssuedConversionIngestSecret,
): VerifiedConversionIngestSecret {
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

export function conversionIngestSecretLabelError(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return "Give the signing key an auditable label.";
  if (CONTROLS.test(trimmed) || Array.from(trimmed).length > 128) {
    return "Use plain text no longer than 128 Unicode characters.";
  }
  return null;
}

export const CONVERSION_INGEST_V2_CONTRACT = [
  "X-Postwave-Signature: keyid=<id>,v2=<hex>",
  "X-Postwave-Timestamp: <Unix seconds>",
  "Idempotency-Key: <stable retry key>",
  "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
  "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
] as const;
