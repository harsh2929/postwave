// SPDX-License-Identifier: AGPL-3.0-only
//
// A mirror of the parts of Go's net/url that the semantic-email boundary
// depends on.
//
// The browser's own URL class cannot stand in for it. `new URL("https://a.test")`
// normalizes to "https://a.test/" — Go's url.String() does not add that slash —
// and the URL class throws on the relative and opaque forms whose REJECTION is
// exactly what validateHTTPURL is testing for. Using it would make the editor
// accept and display URLs the API stores differently, or refuse to show the
// diagnostic that explains why a URL was rejected.

export interface GoURL {
  scheme: string;
  opaque: string;
  /** Raw userinfo including any password, or null when absent. */
  user: string | null;
  host: string;
  hostname: string;
  path: string;
  rawPath: string;
  forceQuery: boolean;
  rawQuery: string;
  fragment: string;
}

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+\-.]*$/;
// §3.2.2 reg-name sub-delims, plus the characters Go additionally tolerates so
// that "[ipv6]:port" and a handful of legacy hosts still parse.
const HOST_EXTRA_ALLOWED = "!$&'()*+,;=:[]<>\"%-._~";

/**
 * Mirrors url.Parse for the shapes this boundary can encounter. Returns null
 * where Go returns an error.
 */
export function parseGoURL(raw: string): GoURL | null {
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null; // invalid control byte
  }

  let rest = raw;
  let fragment = "";
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  let scheme = "";
  const colonIndex = rest.indexOf(":");
  if (colonIndex >= 0) {
    const candidate = rest.slice(0, colonIndex);
    if (candidate === "") return null; // missing protocol scheme
    if (SCHEME_PATTERN.test(candidate)) {
      scheme = candidate.toLowerCase();
      rest = rest.slice(colonIndex + 1);
    }
  }

  let forceQuery = false;
  let rawQuery = "";
  const questionIndex = rest.indexOf("?");
  if (questionIndex >= 0) {
    rawQuery = rest.slice(questionIndex + 1);
    forceQuery = rawQuery === "";
    rest = rest.slice(0, questionIndex);
  }

  const url: GoURL = {
    scheme,
    opaque: "",
    user: null,
    host: "",
    hostname: "",
    path: "",
    rawPath: "",
    forceQuery,
    rawQuery,
    fragment,
  };

  if (!rest.startsWith("/") && scheme !== "") {
    // Rootless paths are opaque per RFC 3986 — "mailto:x", "http:foo".
    url.opaque = rest;
    return url;
  }

  if (rest.startsWith("//")) {
    let authority = rest.slice(2);
    rest = "";
    const slashIndex = authority.indexOf("/");
    if (slashIndex >= 0) {
      rest = authority.slice(slashIndex);
      authority = authority.slice(0, slashIndex);
    }
    const atIndex = authority.lastIndexOf("@");
    if (atIndex >= 0) {
      url.user = authority.slice(0, atIndex);
      authority = authority.slice(atIndex + 1);
    }
    if (!isParsableHost(authority)) return null;
    url.host = authority.toLowerCase();
  }

  url.path = rest;
  url.rawPath = rest;
  url.hostname = hostnameOf(url.host);
  return url;
}

/**
 * Go rejects an ASCII character in the host that would have to be
 * percent-encoded, because hosts cannot use %-encoding for ASCII bytes. A
 * space in a path is fine; a space in a host is a parse error.
 */
function isParsableHost(host: string): boolean {
  if (host.startsWith("[") && !host.includes("]")) return false;
  for (const character of host) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x80) continue;
    if (/[A-Za-z0-9]/.test(character)) continue;
    if (HOST_EXTRA_ALLOWED.includes(character)) continue;
    return false;
  }
  return true;
}

function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close < 0 ? "" : host.slice(1, close);
  }
  const colon = host.lastIndexOf(":");
  return colon < 0 ? host : host.slice(0, colon);
}

/**
 * Mirrors url.URL.String() closely enough for normalization: scheme and host
 * are lower-cased, the path is re-escaped the way EscapedPath does when the raw
 * form is not already a valid encoding, and the query is emitted verbatim.
 */
export function formatGoURL(url: GoURL): string {
  let out = "";
  if (url.scheme !== "") out += url.scheme + ":";
  if (url.opaque !== "") {
    out += url.opaque;
  } else {
    if (url.scheme !== "" || url.host !== "" || url.user !== null) {
      if (url.host !== "" || url.path !== "" || url.user !== null) out += "//";
      if (url.user !== null) out += url.user + "@";
      out += url.host;
    }
    const path = escapedPath(url);
    if (path !== "" && path[0] !== "/" && url.host !== "") out += "/";
    out += path;
  }
  if (url.forceQuery || url.rawQuery !== "") out += "?" + url.rawQuery;
  if (url.fragment !== "") out += "#" + escapeGo(url.fragment, "fragment");
  return out;
}

function escapedPath(url: GoURL): string {
  if (url.rawPath !== "" && isValidEncoded(url.rawPath, "path")) {
    return url.rawPath;
  }
  return escapeGo(url.path, "path");
}

type EscapeMode = "path" | "fragment";

// §2.3 unreserved marks plus the reserved characters Go leaves alone in each
// mode. For a path everything reserved except "?" survives; a fragment keeps
// "?" too.
function shouldEscape(byte: number, mode: EscapeMode): boolean {
  const character = String.fromCharCode(byte);
  if (/[A-Za-z0-9]/.test(character)) return false;
  if ("-_.~".includes(character)) return false;
  if ("$&+,/:;=?@".includes(character)) {
    return mode === "path" ? character === "?" : false;
  }
  return true;
}

function isValidEncoded(value: string, mode: EscapeMode): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "%") {
      if (!/^%[0-9A-Fa-f]{2}/.test(value.slice(index))) return false;
      index += 2;
      continue;
    }
    if (character === "[" || character === "]") continue;
    const bytes = new TextEncoder().encode(character);
    if (bytes.length > 1) return false;
    if (shouldEscape(bytes[0], mode)) return false;
  }
  return true;
}

function escapeGo(value: string, mode: EscapeMode): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    if (shouldEscape(byte, mode)) {
      out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}
