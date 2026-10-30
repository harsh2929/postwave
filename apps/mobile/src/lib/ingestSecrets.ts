/**
 * lib/ingestSecrets.ts — the signing keys that authenticate conversion ingest.
 *
 * Strict codecs and operator copy for the admin-only
 * `GET /api/v1/conversions/ingest-secrets` and `.../{keyID}/revoke` routes.
 * Mobile exposes the urgent list/revoke half while web and desktop own the
 * reveal-once issuance ceremony.
 *
 * ── WHY REVOKE PORTS AND ISSUE DOES NOT ────────────────────────────────────
 * `app/(tabs)/conversions.tsx` states the screen's rule: "A MONITOR, NOT A
 * CONSOLE… Key creation returns the plaintext key exactly once, so it is credential
 * authoring and stays on a desk." That reasoning is exactly right about ISSUING —
 * a secret shown once needs a capture-then-dismiss ceremony and somewhere to paste
 * it — and it does not reach REVOKING, which returns no secret, needs no capture,
 * and is the thing you do the moment a key turns up somewhere it should not be.
 *
 * A leaked ingest key lets anyone forge conversion events, which corrupts
 * attribution and therefore revenue reporting. The window between noticing and
 * revoking is the entire risk, and that window is usually not spent at a desk.
 *
 * Import-free of react-native, so it is node-tested.
 */
import { WireShapeError } from "./wireShapeError";

export type IdentityProjectionStatus = "pending" | "ready" | "failed";
export type IdentityProjectionErrorCode =
  | "secret_unavailable"
  | "projection_failed";

export interface IngestSecret {
  keyId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  identityProjectionStatus: IdentityProjectionStatus;
  identityProjectionErrorCode: IdentityProjectionErrorCode | null;
  identityProjectionUpdatedAt: string;
}

export interface IngestSecretPage {
  items: IngestSecret[];
  nextCursor?: string;
}

const encoder = new TextEncoder();
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const KEY_ID = /^[0-9a-f]{32}$/u;
const ROW_KEYS = new Set([
  "key_id",
  "label",
  "created_at",
  "revoked_at",
  "identity_projection_status",
  "identity_projection_error_code",
  "identity_projection_updated_at",
]);

function bounded(
  value: unknown,
  bytes: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    encoder.encode(value).byteLength <= bytes &&
    (empty || value.length > 0)
  );
}

function boundedCodePoints(
  value: unknown,
  maxCodePoints: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    !CONTROLS.test(value) &&
    [...value].length <= maxCodePoints &&
    (empty || value.length > 0)
  );
}

function timestamp(value: unknown): value is string {
  return bounded(value, 128) && Number.isFinite(Date.parse(value));
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectionMetadataIsValid(row: Record<string, unknown>): boolean {
  const status = row.identity_projection_status;
  const errorCode = row.identity_projection_error_code;
  if (status === "failed") {
    return (
      errorCode === "secret_unavailable" || errorCode === "projection_failed"
    );
  }
  return (
    (status === "pending" || status === "ready") && errorCode === undefined
  );
}

function parseIngestSecretRow(raw: unknown): IngestSecret {
  if (!record(raw)) {
    throw new WireShapeError(
      "signed-ingest key register",
      "The signed-ingest key register contained an invalid row.",
    );
  }
  if (
    Object.keys(raw).some((key) => !ROW_KEYS.has(key)) ||
    typeof raw.key_id !== "string" ||
    !KEY_ID.test(raw.key_id) ||
    !boundedCodePoints(raw.label, 128, true) ||
    !timestamp(raw.created_at) ||
    !timestamp(raw.identity_projection_updated_at) ||
    !projectionMetadataIsValid(raw) ||
    (raw.revoked_at !== undefined &&
      raw.revoked_at !== null &&
      !timestamp(raw.revoked_at))
  ) {
    throw new WireShapeError(
      "signed-ingest key register",
      "The signed-ingest key register contained an invalid row.",
    );
  }
  const failed = raw.identity_projection_status === "failed";
  return {
    keyId: raw.key_id,
    label: raw.label || raw.key_id,
    createdAt: raw.created_at,
    revokedAt:
      raw.revoked_at === undefined || raw.revoked_at === null
        ? null
        : raw.revoked_at,
    identityProjectionStatus:
      raw.identity_projection_status as IdentityProjectionStatus,
    identityProjectionErrorCode: failed
      ? (raw.identity_projection_error_code as IdentityProjectionErrorCode)
      : null,
    identityProjectionUpdatedAt: raw.identity_projection_updated_at,
  };
}

export function parseIngestSecrets(payload: unknown): IngestSecretPage {
  const envelope = record(payload) ? payload : null;
  const rows = envelope?.items;
  if (
    !envelope ||
    Object.keys(envelope).some(
      (key) => key !== "items" && key !== "next_cursor",
    ) ||
    !Array.isArray(rows) ||
    rows.length > 100 ||
    (envelope.next_cursor !== undefined && !bounded(envelope.next_cursor, 512))
  ) {
    throw new WireShapeError(
      "signed-ingest key register",
      "The signed-ingest key register response was malformed.",
    );
  }
  const out = rows.map(parseIngestSecretRow);
  if (new Set(out.map((row) => row.keyId)).size !== out.length) {
    throw new WireShapeError(
      "signed-ingest key register",
      "The signed-ingest key register contained duplicate IDs.",
    );
  }
  return {
    items: out,
    ...(typeof envelope.next_cursor === "string"
      ? { nextCursor: envelope.next_cursor }
      : {}),
  };
}

/** A key is live until it carries a revocation timestamp. */
export function ingestSecretIsActive(secret: IngestSecret): boolean {
  return secret.revokedAt === null;
}

/**
 * The confirmation before revoking.
 *
 * Names the consequence in both directions: revoking stops forged events
 * immediately AND breaks any legitimate sender still using the key. Mentioning
 * only the first would make this look free.
 */
export function ingestSecretRevokeCopy(secret: IngestSecret): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: `Revoke ${secret.label}?`,
    body: "Conversions signed with this key stop being accepted immediately — including from anything legitimate still using it. Revoking cannot be undone; for planned rotation, issue and verify a new key from the web or desktop admin first.",
    confirmLabel: "Revoke key",
  };
}

export const CONVERSION_INGEST_V2_CONTRACT = [
  "X-Postwave-Signature: keyid=<id>,v2=<hex>",
  "X-Postwave-Timestamp: <Unix seconds>",
  "Idempotency-Key: <stable retry key>",
  "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
  "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
] as const;
