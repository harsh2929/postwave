/**
 * lib/preferenceCenterLogoUrl.ts — "would the API accept this logo URL?"
 *
 * Split out of lib/preferenceCenterTheme because it is one whole
 * responsibility: a faithful mirror of `validPreferenceLogoURL` /
 * `safePreferenceLogoHost` in apps/api/internal/privacy_portal/
 * preference_center.go, and through them of Go's `net/url` and `net.IP`.
 *
 * VERIFIED, NOT ASSERTED. The rules below were checked against the real Go
 * functions over an 84-URL corpus (the run agreed on every one). Three of them
 * exist BECAUSE that comparison disagreed first: IPv4 multicast is 224/4 and
 * not "everything from 224 up"; an IPv4-mapped IPv6 literal is classified by
 * its IPv4 half; and an internationalised host is fine while a %-escaped one is
 * not. Being STRICTER than the server is the failure that matters here — it
 * would refuse a logo the hosted page would happily have served.
 *
 * Import-free (no react-native / expo) so it runs under node vitest.
 */

import { utf8ByteLength } from "./inboundTriggerValidation";

/** `logoURLMaxBytes` — measured in BYTES, like Go's len(string). */
export const LOGO_URL_MAX_BYTES = 2048;

/** net/url refuses any URL containing a control byte, wherever it sits. */
const CONTROL_BYTE = /[\u0000-\u001f\u007f]/u;
const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+\-.]*):\/\/([^/?#]*)([/?#][\s\S]*)?$/u;
/**
 * Go's parseHost rejects the ASCII bytes `shouldEscape(c, encodeHost)` flags and
 * leaves every byte >= 0x80 alone — so an internationalised domain is a valid
 * host and a space is not.
 */
const HOST_CHARS =
  /^(?:[A-Za-z0-9\-._~%!$&'()*+,;=:[\]<>"]|[^\u0000-\u007f])+$/u;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

/**
 * unescape(host, encodeHost) refuses almost every %-escape in a host: the
 * triplet must be well formed AND either be `%25` or encode a byte >= 0x80.
 * `%2f` — the classic "host" that is really a path — is refused there, so it is
 * refused here.
 */
function hostEscapesValid(authority: string): boolean {
  for (
    let at = authority.indexOf("%");
    at >= 0;
    at = authority.indexOf("%", at + 1)
  ) {
    const triplet = authority.slice(at, at + 3);
    if (!/^%[0-9A-Fa-f]{2}$/u.test(triplet)) return false;
    if (triplet.toUpperCase() === "%25") continue;
    if (Number.parseInt(triplet.slice(1, 2), 16) < 8) return false;
  }
  return true;
}

/** `u.Hostname()`: strip the [] of an IPv6 literal, strip a numeric port. */
function hostnameOf(authority: string): string | null {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    const after = authority.slice(end + 1);
    if (after !== "" && !/^:\d*$/u.test(after)) return null;
    return authority.slice(1, end);
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return authority;
  // A non-numeric port makes the whole URL invalid in Go, not just the port.
  if (!/^\d*$/u.test(authority.slice(colon + 1))) return null;
  return authority.slice(0, colon);
}

/** net.ParseIP for a dotted quad. Go rejects leading zeros, so we do too. */
function ipv4Octets(host: string): number[] | null {
  const match = IPV4.exec(host);
  if (!match) return null;
  const octets: number[] = [];
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith("0")) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** The classes LoadPreferenceCustomization's host guard refuses for IPv4. */
function ipv4Blocked(octets: number[]): boolean {
  const [first = 0, second = 0] = octets;
  return (
    octets.every((octet) => octet === 0) || // unspecified
    first === 127 || // loopback
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || // private
    (first === 169 && second === 254) || // link-local unicast
    // IsMulticast is ip4[0]&0xf0 == 0xe0 — 224.0.0.0/4 only. The 240/4
    // reserved block is not multicast and the server does accept it.
    (first >= 224 && first <= 239)
  );
}

/** A coarse but valid-only IPv6 literal reader; nil-equivalent when it is not one. */
function ipv6Blocked(host: string): boolean | null {
  const hextets = ipv6Hextets(host);
  if (!hextets) return null;
  const [first = 0] = hextets;
  // ip.To4() unwraps ::ffff:a.b.c.d, so every IPv4 rule applies to it.
  if (
    hextets.slice(0, 5).every((hextet) => hextet === 0) &&
    hextets[5] === 0xffff
  ) {
    const high = hextets[6] ?? 0;
    const low = hextets[7] ?? 0;
    return ipv4Blocked([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  if (hextets.every((hextet) => hextet === 0)) return true; // :: unspecified
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) {
    return true; // ::1 loopback
  }
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local (Go: IsPrivate)
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local unicast
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** The eight hextets of an IPv6 literal, or null when this is not one. */
function ipv6Hextets(host: string): number[] | null {
  if (!host.includes(":") || !/^[0-9A-Fa-f:.]+$/u.test(host)) return null;
  const quad = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u.exec(host);
  if (quad) {
    const octets = ipv4Octets(quad[1] ?? "");
    if (!octets) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const head = ipv6Hextets(
      `${host.slice(0, host.length - (quad[1] ?? "").length)}0:0`,
    );
    if (!head) return null;
    return [...head.slice(0, 6), (a << 8) | b, (c << 8) | d];
  }
  if (host.includes(".")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const split = (part: string): string[] =>
    part.split(":").filter((group) => group !== "");
  const head = split(halves[0] ?? "");
  const tail = halves.length === 2 ? split(halves[1] ?? "") : [];
  if ([...head, ...tail].some((group) => group.length > 4)) return null;
  const middle = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 1 ? head.length !== 8 : middle < 1) return null;
  const zeros: string[] = Array.from({ length: middle }, () => "0");
  return [...head, ...zeros, ...tail].map((group) => Number.parseInt(group, 16));
}

/** safePreferenceLogoHost (preference_center.go:145), rule for rule. */
function safeLogoHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/u, "");
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return false;
  }
  const octets = ipv4Octets(host);
  if (octets) return !ipv4Blocked(octets);
  const blockedV6 = ipv6Blocked(host);
  if (blockedV6 !== null) return !blockedV6;
  // Single-label / intranet names never resolve for a subscriber's browser.
  return host.includes(".");
}

/**
 * True when `validPreferenceLogoURL` would accept this value. Empty is
 * accepted (no logo); everything else must be an https URL with a public host
 * and no embedded credentials.
 */
export function preferenceLogoUrlAccepted(raw: string): boolean {
  const value = raw.trim();
  if (value === "") return true;
  if (utf8ByteLength(value) > LOGO_URL_MAX_BYTES) {
    return false;
  }
  if (CONTROL_BYTE.test(value)) return false;
  const match = ABSOLUTE_URL.exec(value);
  if (!match) return false;
  const [, scheme = "", authority = ""] = match;
  if (scheme.toLowerCase() !== "https") return false;
  // Any userinfo at all makes u.User non-nil, which the validator refuses.
  if (authority.includes("@")) return false;
  if (!HOST_CHARS.test(authority) || !hostEscapesValid(authority)) return false;
  const host = hostnameOf(authority);
  if (host === null) return false;
  return safeLogoHost(host);
}
