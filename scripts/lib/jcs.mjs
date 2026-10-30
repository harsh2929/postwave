/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * Why this exists rather than `JSON.stringify`: release-evidence manifests
 * define `candidate_payload_digest` as SHA-256 over the CANONICAL serialization
 * of the payload, and every approval record binds that exact digest. Two
 * semantically identical manifests must therefore hash identically regardless
 * of key order, and any other implementation (a promotion controller, an
 * auditor's script) must reproduce the digest byte-for-byte. `JSON.stringify`
 * guarantees neither: it preserves insertion order and silently DROPS
 * `undefined`/function values, so two different payloads could hash the same.
 *
 * The rules implemented here (RFC 8785 §3.2):
 *   - object members sorted by key as sequences of UTF-16 code units;
 *   - arrays keep their order (they are sequences, not sets);
 *   - numbers serialized per ECMAScript `Number::toString`;
 *   - strings escaped minimally: `"` `\` and C0 controls only, using the short
 *     forms `\b \t \n \f \r` where they exist and `\uXXXX` otherwise; non-ASCII
 *     is emitted literally as UTF-8;
 *   - no insignificant whitespace.
 *
 * Anything JSON cannot represent THROWS rather than being dropped or coerced —
 * a digest computed over a silently truncated payload is worse than no digest.
 */

import { createHash } from "node:crypto";

/** Short escapes RFC 8785 requires for the control characters that have them. */
const SHORT_ESCAPES = new Map([
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
  ['"', '\\"'],
  ["\\", "\\\\"],
]);

function serializeString(value) {
  let out = '"';
  // Indexed rather than `for…of` so LONE surrogates are visible. `for…of`
  // iterates code POINTS and hands an unpaired surrogate back as a one-char
  // string, which then gets emitted literally — and `Buffer.from(…, "utf8")`
  // replaces it with U+FFFD. That made "\uD800", "\uDC00" and "�" hash
  // IDENTICALLY: a real collision in the primitive whose entire job is that two
  // different payloads never share a digest. It is reachable from YAML, and
  // RFC 8785 §3.2.2.2 defers to well-formed JSON.stringify, so no conforming
  // implementation would have reproduced the digest either.
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    const short = SHORT_ESCAPES.get(ch);
    if (short !== undefined) {
      out += short;
      continue;
    }
    const code = value.charCodeAt(i);
    // C0 controls always escape.
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    // High surrogate followed by a low surrogate is a well-formed pair: emit
    // both units literally so the code point survives as UTF-8.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + value[i + 1];
        i += 1;
        continue;
      }
    }
    // Anything else in the surrogate range is UNPAIRED. Escape it, matching
    // well-formed JSON.stringify, so the encoding is lossless and reproducible.
    if (code >= 0xd800 && code <= 0xdfff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

function serializeNumber(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `JCS: ${String(value)} is not a finite number and cannot be canonicalized`,
    );
  }
  // RFC 8785 defers to ECMAScript Number::toString, which is exactly what
  // JS `String(number)` produces — including "1e+21" and "1e-7" — with the
  // single exception of negative zero, which must serialize as "0".
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function serialize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "undefined":
      throw new TypeError(
        "JCS: undefined has no JSON representation; JSON.stringify would drop " +
          "it silently, making two different payloads hash identically",
      );
    case "object":
      break;
    default:
      throw new TypeError(`JCS: unsupported value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }
  if (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp
  ) {
    throw new TypeError(
      `JCS: unsupported object ${value.constructor.name}; convert it to a plain ` +
        `JSON value before canonicalizing so the encoding is explicit`,
    );
  }

  // Sort by UTF-16 code unit. JavaScript's default string comparison is exactly
  // that, so no locale-aware collator may be used here — `localeCompare` would
  // order "a" before "B" and produce a non-canonical, unreproducible digest.
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => {
    const entry = value[key];
    if (entry === undefined) {
      throw new TypeError(
        `JCS: property ${JSON.stringify(key)} is undefined; remove the key ` +
          `explicitly rather than relying on it being dropped`,
      );
    }
    return `${serializeString(key)}:${serialize(entry)}`;
  });
  return `{${parts.join(",")}}`;
}

/** The RFC 8785 canonical serialization of `value` as a string. */
export function canonicalize(value) {
  return serialize(value);
}

/**
 * `sha256:<lowercase-hex>` over the UTF-8 bytes of the canonical form — the
 * exact shape release-evidence manifests store and approval records bind.
 */
export function sha256Canonical(value) {
  const hash = createHash("sha256");
  hash.update(Buffer.from(canonicalize(value), "utf8"));
  return `sha256:${hash.digest("hex")}`;
}
