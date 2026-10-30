/**
 * Canonical outbound-webhook HMAC verification.
 *
 * X-Postwave-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
 * signed bytes: UTF8(timestamp + ".") || exact raw request bytes
 */

export interface VerifyWebhookOptions {
  /** Current wall clock. Defaults to Date.now(). */
  now?: Date | number;
  /** Maximum timestamp skew. Defaults to 300 seconds; 0 disables the check. */
  toleranceSeconds?: number;
}

export async function verifySignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<boolean> {
  if (!header || !secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed || parsed.v1.length === 0) return false;

  const timestamp = Number(parsed.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;
  const tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0) return false;
  const now =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now
        : Date.now();
  if (!Number.isFinite(now)) return false;
  if (tolerance > 0 && Math.abs(Math.floor(now / 1000) - timestamp) > tolerance) {
    return false;
  }

  const expected = await computeSignatureHex(rawBody, secret, parsed.timestamp);
  return parsed.v1.some((candidate) => constantTimeEqualHex(candidate.toLowerCase(), expected));
}

/** Compute the v1 digest for an explicit timestamp. */
export async function computeSignatureHex(
  rawBody: string | Uint8Array,
  secret: string,
  timestamp: string | number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const timestampText = String(timestamp);
  if (!/^[0-9]+$/.test(timestampText)) {
    throw new TypeError("timestamp must be Unix seconds");
  }
  const subtle = await pickSubtle();
  const enc = new TextEncoder();
  const keyBytes = enc.encode(secret);
  const bodyBytes = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const prefix = enc.encode(`${timestampText}.`);
  const signedBytes = new Uint8Array(prefix.length + bodyBytes.length);
  signedBytes.set(prefix);
  signedBytes.set(bodyBytes, prefix.length);
  const key = await subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, signedBytes as BufferSource);
  return toHex(new Uint8Array(sig));
}

/** Build a complete canonical HMAC signature header for fixtures. */
export async function computeSignatureHeader(
  rawBody: string | Uint8Array,
  secret: string,
  timestamp: string | number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const timestampText = String(timestamp);
  return `t=${timestampText},v1=${await computeSignatureHex(rawBody, secret, timestampText)}`;
}

function parseSignatureHeader(
  header: string,
): { timestamp: string; v1: string[] } | null {
  let timestamp = "";
  const v1: string[] = [];
  for (const rawPart of header.split(",")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (key === "t") {
      if (timestamp !== "") return null;
      timestamp = value;
    }
    if (key === "v1" && /^[A-Fa-f0-9]{64}$/.test(value)) v1.push(value);
  }
  return /^[0-9]+$/.test(timestamp) ? { timestamp, v1 } : null;
}

async function pickSubtle(): Promise<SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c.subtle;
  const nodeCrypto = await import("node:crypto");
  return nodeCrypto.webcrypto.subtle as unknown as SubtleCrypto;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const value of bytes) out += value.toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
