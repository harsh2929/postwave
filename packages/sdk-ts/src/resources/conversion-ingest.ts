// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

const encoder = new TextEncoder();
const MAX_KEY_ID_BYTES = 200;
const MAX_IDEMPOTENCY_KEY_BYTES = 200;

export interface SignedConversionCredentials {
  /** Non-secret identifier for one live server-side conversion key. */
  keyId: string;
  /** HMAC secret. It is used locally and never sent in a request. */
  secret: string;
}

export interface SignedConversionIdentity {
  /**
   * HMAC-SHA256(signing secret, lower(trim(email))). The request's signed
   * keyId supplies the tenant/key namespace; never send an unsalted email hash.
   */
  email_hmac_sha256?: string;
  click_id?: string;
  external_id?: string;
}

export interface SignedConversionInput {
  event_name: string;
  occurred_at?: string;
  identity: SignedConversionIdentity;
  /** Exact major-unit decimal with at most two fractional digits. */
  value?: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface SignedConversionReceipt {
  accepted: number;
  conversion_ids: number[];
  /** Non-secret key identifier that authenticated the request. */
  key_id: string;
}

export interface SignedConversionIngestOptions {
  /** Stable across retries in other processes; otherwise one is minted locally. */
  idempotencyKey?: string;
  /** Explicit Unix seconds, primarily for deterministic jobs/tests. Defaults to now. */
  timestamp?: string | number;
  signal?: AbortSignal;
}

/**
 * Compute the key-bound v2 MAC over the exact raw bytes the API will parse.
 * The key id and timestamp lengths are UTF-8 byte lengths, matching the Go
 * verifier rather than JavaScript string/code-point counts.
 */
export async function computeConversionIngestSignatureHex(
  rawBody: string | Uint8Array,
  credentials: SignedConversionCredentials,
  timestamp: string | number,
): Promise<string> {
  const { keyId, secret } = validateCredentials(credentials);
  const timestampText = normalizeTimestamp(timestamp);
  const bodyBytes =
    typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const keyIDBytes = encoder.encode(keyId);
  const timestampBytes = encoder.encode(timestampText);
  const prefix = encoder.encode(
    `postwave-conversion-v2\n${keyIDBytes.byteLength}\n${keyId}${timestampBytes.byteLength}\n${timestampText}`,
  );
  const preimage = new Uint8Array(prefix.byteLength + bodyBytes.byteLength);
  preimage.set(prefix);
  preimage.set(bodyBytes, prefix.byteLength);

  const subtle = await pickSubtle();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, preimage as BufferSource);
  return toHex(new Uint8Array(signature));
}

export async function computeConversionIngestSignatureHeader(
  rawBody: string | Uint8Array,
  credentials: SignedConversionCredentials,
  timestamp: string | number,
): Promise<string> {
  const { keyId } = validateCredentials(credentials);
  return `keyid=${keyId},v2=${await computeConversionIngestSignatureHex(
    rawBody,
    credentials,
    timestamp,
  )}`;
}

/**
 * Derive the only email pseudonym accepted by signed conversion ingest.
 * The address and secret stay local; callers send only the returned digest in
 * `identity.email_hmac_sha256` and sign that request with the same credential.
 */
export async function computeConversionEmailHMACSHA256(
  email: string,
  credentials: SignedConversionCredentials,
): Promise<string> {
  const { secret } = validateCredentials(credentials);
  if (typeof email !== "string" || email.trim() === "") {
    throw new TypeError("conversion email must not be empty");
  }
  const subtle = await pickSubtle();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(email.trim().toLowerCase()) as BufferSource,
  );
  return toHex(new Uint8Array(digest));
}

export class ConversionIngestResource extends Resource {
  /** Ingest one HMAC-authenticated server-side conversion. */
  ingest(
    input: SignedConversionInput,
    credentials: SignedConversionCredentials,
    options: SignedConversionIngestOptions = {},
  ): Promise<SignedConversionReceipt> {
    validateInput(input);
    return this.send(
      "/api/public/conversions/ingest",
      JSON.stringify(input),
      credentials,
      options,
    );
  }

  /** Ingest one atomic batch. Empty batches and batches above 500 fail locally. */
  ingestBatch(
    conversions: SignedConversionInput[],
    credentials: SignedConversionCredentials,
    options: SignedConversionIngestOptions = {},
  ): Promise<SignedConversionReceipt> {
    if (!Array.isArray(conversions) || conversions.length < 1 || conversions.length > 500) {
      throw new TypeError("conversion batch must contain 1 to 500 items");
    }
    conversions.forEach(validateInput);
    return this.send(
      "/api/public/conversions/ingest/batch",
      JSON.stringify({ conversions }),
      credentials,
      options,
    );
  }

  private async send(
    path: string,
    rawBody: string,
    credentials: SignedConversionCredentials,
    options: SignedConversionIngestOptions,
  ): Promise<SignedConversionReceipt> {
    validateCredentials(credentials);
    const timestamp = normalizeTimestamp(
      options.timestamp ?? Math.floor(Date.now() / 1000),
    );
    const idempotencyKey = validateIdempotencyKey(options.idempotencyKey);
    const signature = await computeConversionIngestSignatureHeader(
      rawBody,
      credentials,
      timestamp,
    );
    return this.client.request("POST", path, {
      rawBody,
      auth: "none",
      omitDefaultHeaders: true,
      headers: {
        "Content-Type": "application/json",
        "X-Postwave-Timestamp": timestamp,
        "X-Postwave-Signature": signature,
      },
      idempotencyKey,
      signal: options.signal,
    });
  }
}

function validateCredentials(
  credentials: SignedConversionCredentials,
): SignedConversionCredentials {
  const keyId = credentials?.keyId;
  const secret = credentials?.secret;
  if (
    typeof keyId !== "string" ||
    keyId.length === 0 ||
    keyId !== keyId.trim() ||
    encoder.encode(keyId).byteLength > MAX_KEY_ID_BYTES ||
    (keyId.includes(",") || /\p{Cc}/u.test(keyId))
  ) {
    throw new TypeError(
      "conversion signing keyId must be 1 to 200 UTF-8 bytes without commas, controls, or surrounding whitespace",
    );
  }
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new TypeError("conversion signing secret must not be empty");
  }
  return { keyId, secret };
}

function normalizeTimestamp(value: string | number): string {
  const text = String(value);
  if (
    !/^[0-9]+$/.test(text) ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) <= 0
  ) {
    throw new TypeError("conversion timestamp must be Unix seconds");
  }
  return text;
}

function validateIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value !== value.trim() ||
    encoder.encode(value).byteLength > MAX_IDEMPOTENCY_KEY_BYTES ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(
      "conversion idempotencyKey must be 1 to 200 UTF-8 bytes without controls or surrounding whitespace",
    );
  }
  return value;
}

function validateInput(input: SignedConversionInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("conversion input must be an object");
  }
  if (
    typeof input.event_name !== "string" ||
    input.event_name.trim() === "" ||
    Array.from(input.event_name.trim()).length > 128 ||
    /\p{Cc}/u.test(input.event_name)
  ) {
    throw new TypeError("conversion event_name is required");
  }
  const identity = input.identity;
  if (
    !identity ||
    ![
      identity.click_id,
      identity.email_hmac_sha256,
      identity.external_id,
    ].some(
      (value) => typeof value === "string" && value.trim() !== "",
    )
  ) {
    throw new TypeError(
      "conversion identity requires click_id, email_hmac_sha256, or external_id",
    );
  }
  if (
    identity.email_hmac_sha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(identity.email_hmac_sha256)
  ) {
    throw new TypeError(
      "conversion email_hmac_sha256 must be 64 lowercase hexadecimal characters",
    );
  }
  if (input.value !== undefined) {
    const text = String(input.value);
    if (
      !Number.isFinite(input.value) ||
      !/^-?\d+(?:\.\d{1,2})?$/.test(text) ||
      typeof input.currency !== "string" ||
      !/^[A-Za-z]{3}$/.test(input.currency)
    ) {
      throw new TypeError(
        "conversion value requires an exact decimal with at most two fractional digits and a three-letter currency",
      );
    }
  } else if (input.currency !== undefined && input.currency.trim() !== "") {
    throw new TypeError("conversion currency requires value");
  }
}

async function pickSubtle(): Promise<SubtleCrypto> {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (crypto?.subtle) return crypto.subtle;
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto.subtle as unknown as SubtleCrypto;
}

function toHex(bytes: Uint8Array): string {
  let output = "";
  for (const value of bytes) output += value.toString(16).padStart(2, "0");
  return output;
}
