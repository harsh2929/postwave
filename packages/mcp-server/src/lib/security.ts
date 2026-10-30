// SPDX-License-Identifier: MIT
/**
 * SSRF + size hardening utilities. Patterned after the Beehiiv community
 * MCP server: any tool that accepts a URL routes it through `validateUrl`
 * first; any tool that returns large blobs routes them through `capResponse`.
 */

const PRIVATE_V4_RANGES: Array<[number, number, number]> = [
  // [first-octet, prefix-bits, second-octet-floor (or -1 if not used)]
  [10, 8, -1],
  [127, 8, -1],
  [169, 16, 254], // 169.254.0.0/16 (link-local + AWS metadata 169.254.169.254)
  [172, 12, -1], // 172.16.0.0/12 — handled below by range check
  [192, 16, 168], // 192.168.0.0/16
  [0, 8, -1], // 0.0.0.0/8
];

const BLOCKED_HOSTS: Set<string> = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/**
 * Validate a user-supplied URL is safe for the server to fetch. Rejects:
 *   - non-http(s) schemes (file:, gopher:, etc.)
 *   - hostnames pointing at loopback / link-local / private IPv4 / IPv6 ULA
 *   - cloud metadata endpoints
 *
 * Note: this is a static validation. A full SSRF defense also requires DNS
 * pinning at fetch-time; for V1 we rely on the SDK's outbound traffic
 * going to api.moosewave.com exclusively.
 */
/**
 * The IPv4 address an IPv4-mapped IPv6 host refers to, or null.
 *
 * Accepts both textual forms Node's URL parser can produce:
 *   ::ffff:127.0.0.1        (dotted tail, as written)
 *   ::ffff:7f00:1           (hextet tail, after canonicalisation)
 * and their fully expanded 0:0:0:0:0:ffff:… equivalents.
 */
function mappedIPv4(host: string): string | null {
  const m = /^(?:0*:)*0*:?0*ffff:(.+)$/i.exec(host);
  if (!m) return null;
  const tail = m[1] ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return tail;
  const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hextets) return null;
  const high = Number.parseInt(hextets[1]!, 16);
  const low = Number.parseInt(hextets[2]!, 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function validateUrl(input: string): void {
  if (!input || input.trim() !== input || CONTROL_RE.test(input)) {
    throw new SsrfError("invalid URL input");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new SsrfError(`invalid URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`disallowed scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfError("URL credentials are not allowed");
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) {
    throw new SsrfError(`blocked host: ${host}`);
  }

  // IPv6 — block loopback ::1 and ULA fc00::/7
  if (host.startsWith("[") || host.includes(":")) {
    const stripped = host.replace(/^\[|\]$/g, "");

    // IPv4-mapped IPv6 (::ffff:a.b.c.d) reaches the same host as a.b.c.d, but
    // is neither shape this function checked: it carries colons so the
    // dotted-quad branch below never runs, and it matches no ::1 / fc / fd /
    // fe80 prefix so the IPv6 branch waved it through. [::ffff:169.254.169.254]
    // was an open path to cloud instance metadata. Fold it back to its IPv4
    // form and re-enter the same rules rather than duplicating the ranges.
    const mapped = mappedIPv4(stripped);
    if (mapped) {
      validateUrl(`${parsed.protocol}//${mapped}`);
      return;
    }

    if (stripped === "::1" || stripped === "0:0:0:0:0:0:0:1") {
      throw new SsrfError(`blocked IPv6 loopback`);
    }
    if (/^fc[0-9a-f]{2}:/i.test(stripped) || /^fd[0-9a-f]{2}:/i.test(stripped)) {
      throw new SsrfError(`blocked IPv6 ULA`);
    }
    if (/^fe80:/i.test(stripped)) {
      throw new SsrfError(`blocked IPv6 link-local`);
    }
  }

  // IPv4 numeric
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) throw new SsrfError("blocked IPv4 10.0.0.0/8");
    if (a === 127) throw new SsrfError("blocked IPv4 127.0.0.0/8 (loopback)");
    if (a === 0) throw new SsrfError("blocked IPv4 0.0.0.0/8");
    if (a === 169 && b === 254) throw new SsrfError("blocked IPv4 169.254.0.0/16 (link-local + cloud metadata)");
    if (a === 172 && b >= 16 && b <= 31) throw new SsrfError("blocked IPv4 172.16.0.0/12");
    if (a === 192 && b === 168) throw new SsrfError("blocked IPv4 192.168.0.0/16");
    // 100.64.0.0/10 carrier-grade NAT
    if (a === 100 && b >= 64 && b <= 127) throw new SsrfError("blocked IPv4 100.64.0.0/10 (CGNAT)");
    void PRIVATE_V4_RANGES;
  }
}

export interface CappedResponse<T> {
  data: T;
  truncated: boolean;
  byteLength: number;
}

const TRUNCATION_MARKER = "...[truncated by @postwave/mcp-server: response exceeded cap]";

/**
 * Cap a JSON-serializable value at `maxBytes`. If the serialized form is
 * larger, the function returns a string-truncated representation with a
 * trailing marker so the LLM understands the cut-off. Otherwise the value
 * is returned unchanged.
 */
export function capResponse<T>(data: T, maxBytes = 5_000_000): CappedResponse<T | string> {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { data: String(data), truncated: false, byteLength: 0 };
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= maxBytes) {
    return { data, truncated: false, byteLength };
  }
  const slice = truncateUtf8(serialized, maxBytes);
  return {
    data: `${slice}\n${TRUNCATION_MARKER}`,
    truncated: true,
    byteLength,
  };
}

export const __TRUNCATION_MARKER = TRUNCATION_MARKER;

function truncateUtf8(value: string, maxBytes: number): string {
  let out = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}
