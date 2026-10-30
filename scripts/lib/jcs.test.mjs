// Tests for the RFC 8785 JSON Canonicalization Scheme implementation.
//
// This is NORMATIVE for release evidence: `candidate_payload_digest` is defined
// as SHA-256 over the JCS serialization of the manifest, and approval records
// bind that exact digest. A canonicalizer that differs from the RFC by one byte
// produces a digest no other implementation can reproduce, which silently turns
// "this approval covers this exact payload" into an unverifiable claim.
//
// Vectors below are taken from RFC 8785 §3.2.3 and its published test suite.

import { strict as assert } from "node:assert";
import test from "node:test";

import { canonicalize, sha256Canonical } from "./jcs.mjs";

test("sorts object keys by UTF-16 code unit, not by locale", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // Uppercase sorts before lowercase in code-unit order; a locale-aware sort
  // would interleave them.
  assert.equal(canonicalize({ a: 1, B: 2, A: 3 }), '{"A":3,"B":2,"a":1}');
  // RFC 8785 §3.2.3 literal example. Order is U+000D (\r) < U+0031 ("1") <
  // U+20AC (€) — the control character sorts FIRST, which is the case a
  // "sort the visible characters" intuition gets wrong.
  assert.equal(
    canonicalize({ "€": "Euro Sign", "\r": "Carriage Return", "1": "One" }),
    '{"\\r":"Carriage Return","1":"One","€":"Euro Sign"}',
  );
});

test("sorts surrogate pairs by code unit, not code point", () => {
  // U+1F600 is the surrogate pair D83D DE00; U+FB33 is a single unit FB33.
  // Code-UNIT order puts the emoji first (D83D < FB33); code-POINT order would
  // not. The RFC mandates code-unit order.
  const out = canonicalize({ "\u{1F600}": 1, "דּ": 2 });
  assert.equal(out.indexOf("\u{1F600}") < out.indexOf("דּ"), true);
});

test("sorts nested objects too", () => {
  assert.equal(
    canonicalize({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }),
    '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
  );
});

test("preserves array order — arrays are sequences, not sets", () => {
  assert.equal(canonicalize([3, 1, 2]), "[3,1,2]");
});

test("serializes numbers per ECMAScript Number::toString", () => {
  assert.equal(canonicalize(1), "1");
  assert.equal(canonicalize(1.0), "1");
  assert.equal(canonicalize(-0), "0"); // RFC 8785: negative zero serializes as 0
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(1e-7), "1e-7");
  assert.equal(canonicalize(0.1), "0.1");
  assert.equal(canonicalize(333333333.33333329), "333333333.3333333");
});

test("rejects non-finite numbers rather than emitting invalid JSON", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalize(bad), /finite/i);
  }
});

test("escapes only what JSON requires, with the short forms", () => {
  assert.equal(canonicalize("a\"b\\c"), '"a\\"b\\\\c"');
  assert.equal(canonicalize("\b\t\n\f\r"), '"\\b\\t\\n\\f\\r"');
  // Other C0 controls use \u00XX lowercase-hex form.
  assert.equal(canonicalize(""), '"\\u0001"');
  // Non-ASCII is NOT escaped — JCS emits UTF-8 literally.
  assert.equal(canonicalize("é€"), '"é€"');
  // Solidus is not escaped.
  assert.equal(canonicalize("a/b"), '"a/b"');
});

test("emits literals for null/true/false and drops no keys", () => {
  assert.equal(canonicalize({ a: null, b: true, c: false }), '{"a":null,"b":true,"c":false}');
});

test("rejects values JSON cannot represent instead of silently dropping them", () => {
  // JSON.stringify drops undefined/function values inside objects, which would
  // make two DIFFERENT payloads hash identically.
  assert.throws(() => canonicalize({ a: undefined }), /undefined/i);
  assert.throws(() => canonicalize({ a: () => {} }), /unsupported/i);
  assert.throws(() => canonicalize({ a: 1n }), /unsupported/i);
});

test("is stable under key insertion order", () => {
  const a = { x: 1, y: { p: 1, q: 2 } };
  const b = { y: { q: 2, p: 1 }, x: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(sha256Canonical(a), sha256Canonical(b));
});

test("sha256Canonical returns the prefixed lowercase hex form", () => {
  const digest = sha256Canonical({});
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  // SHA-256 of the two bytes "{}".
  assert.equal(
    digest,
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("lone surrogates do not collide with each other or with U+FFFD", () => {
  // Regression for a REAL collision. `for…of` iterates code points, handing an
  // unpaired surrogate back as a one-char string that was emitted literally;
  // `Buffer.from(…, "utf8")` then replaced it with U+FFFD, so these three
  // distinct payloads all hashed to the same value — in the one primitive
  // whose job is that they never do.
  const high = sha256Canonical({ x: "\uD800" });
  const low = sha256Canonical({ x: "\uDC00" });
  const replacement = sha256Canonical({ x: "�" });
  assert.notEqual(high, low);
  assert.notEqual(high, replacement);
  assert.notEqual(low, replacement);
  // Escaped form matches well-formed JSON.stringify, so another RFC 8785
  // implementation reproduces the digest.
  assert.equal(canonicalize("\uD800"), '"\\ud800"');
  assert.equal(canonicalize("\uDFFF"), '"\\udfff"');
});

test("well-formed surrogate PAIRS stay literal", () => {
  // A paired surrogate is a real code point and must be emitted as UTF-8, not
  // escaped — escaping it would be valid JSON but not the canonical form.
  assert.equal(canonicalize("\u{1F600}"), '"\u{1F600}"');
  assert.equal(canonicalize("a\u{1F600}b"), '"a\u{1F600}b"');
  // A high surrogate followed by a NON-low unit is still lone.
  assert.equal(canonicalize("\uD800a"), '"\\ud800a"');
});
