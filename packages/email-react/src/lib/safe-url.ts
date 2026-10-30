// SPDX-License-Identifier: MIT

const TEMPLATE_TOKEN = /^\{\{[a-zA-Z0-9_.-]+\}\}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

export function safeEmailHref(raw: string | undefined): string {
  return safeEmailURL(raw, {
    allowedProtocols: new Set(["http:", "https:", "mailto:", "tel:"]),
    fallback: "#",
  });
}

export function safeEmailImageSrc(raw: string | undefined): string {
  return safeEmailURL(raw, {
    allowedProtocols: new Set(["http:", "https:"]),
    fallback: "",
  });
}

function safeEmailURL(
  raw: string | undefined,
  opts: { allowedProtocols: Set<string>; fallback: string },
): string {
  const value = (raw ?? "").trim();
  if (!value) return opts.fallback;
  if (TEMPLATE_TOKEN.test(value)) return value;
  if (value !== raw || CONTROL_RE.test(value) || value.includes("\\") || hasEncodedControl(value)) {
    return opts.fallback;
  }
  try {
    const url = new URL(value);
    if (!opts.allowedProtocols.has(url.protocol)) return opts.fallback;
    if (url.username || url.password) return opts.fallback;
    if ((url.protocol === "http:" || url.protocol === "https:") && isBlockedHttpHost(url.hostname)) {
      return opts.fallback;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return opts.fallback;
  }
}

function hasEncodedControl(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return CONTROL_RE.test(decoded) || decoded.includes("\\");
  } catch {
    return true;
  }
}

/** Apply the private/loopback/metadata IPv4 rules to a dotted quad. */
function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * The IPv4 address embedded in an IPv6 one, when there is a well-known
 * embedding, else null.
 *
 * This is the hole the IPv6 branch had. WHATWG URL normalises `2130706433`,
 * `0177.0.0.1` and `0x7f000001` back to `127.0.0.1`, so those decimal/octal/hex
 * tricks were already caught by the dotted-quad rules. What it does NOT undo is
 * an IPv4 address carried inside an IPv6 one: `[::ffff:127.0.0.1]` normalises
 * to `[::ffff:7f00:1]`, which is not `::1`, not `fc00::/7` and not `fe80::/10`,
 * so every private-range rule above was skipped. `[::ffff:169.254.169.254]` —
 * the cloud metadata endpoint — passed the same way.
 *
 * Handled embeddings:
 *   ::ffff:a.b.c.d     IPv4-mapped     (RFC 4291)
 *   ::a.b.c.d          IPv4-compatible (deprecated, still parsed)
 *   64:ff9b::a.b.c.d   NAT64 well-known prefix (RFC 6052)
 */
function embeddedIPv4(host: string): [number, number, number, number] | null {
  if (!host.includes(":")) return null;

  // Expand to eight 16-bit groups, honouring a single "::" elision.
  const [head, tail] = host.split("::") as [string, string | undefined];
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((h) => Number.parseInt(h, 16));
  let groups: number[];
  if (tail === undefined) {
    groups = parse(head);
  } else {
    const left = parse(head);
    const right = parse(tail);
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }

  const zero = (from: number, to: number) =>
    groups.slice(from, to).every((g) => g === 0);
  const mapped = zero(0, 5) && groups[5] === 0xffff;
  const compatible = zero(0, 6);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6);
  if (!mapped && !compatible && !nat64) return null;

  const hi = groups[6]!;
  const lo = groups[7]!;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isBlockedHttpHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number) as [number, number, number, number];
    if (isBlockedIPv4(a, b, c, d)) return true;
  }

  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (/^fe80:/i.test(host)) return true;
    // Re-enter the IPv4 rules through the address the IPv6 form is carrying,
    // rather than adding a second, drifting set of hex patterns for each range.
    const embedded = embeddedIPv4(host);
    if (embedded && isBlockedIPv4(...embedded)) return true;
  }

  return false;
}
